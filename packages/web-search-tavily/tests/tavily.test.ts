/**
 * Tavily as the web search provider: the requests it sends, the answers it
 * reads back, errors worded so the person knows what to fix, and a key no
 * agent can see.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import WebSearch from "@tomradex/web-search";
import tavily, { TAVILY_SECTION, tavilyProvider, type TavilySettings } from "@tomradex/web-search-tavily";

interface Sent {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

function server(reply: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const s = { url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) };
    sent.push(s);
    return reply(s);
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const settings = (over: Partial<TavilySettings> = {}) => () => ({ ...TAVILY_SECTION.defaults, apiKey: "tvly-test", ...over });
const signal = () => new AbortController().signal;

describe("the Tavily provider", () => {
  it("is unavailable without a key, naming where to add one, and takes TAVILY_API_KEY from the environment", () => {
    expect(tavilyProvider({ settings: settings({ apiKey: "" }), env: {} }).unavailable()).toMatch(/Settings → Web search/);
    expect(tavilyProvider({ settings: settings({ apiKey: " " }), env: { TAVILY_API_KEY: "tvly-env" } }).unavailable()).toBeNull();
  });

  it("searches with the key and the chosen depth, and reads results back as hits", async () => {
    const { sent, fetch } = server(() =>
      json(200, { query: "q", results: [{ title: "T", url: "https://t.example/", content: "C", score: 0.9, published_date: "2026-10-10" }, { url: "https://u.example/", published_date: null }] })
    );
    const provider = tavilyProvider({ settings: settings({ searchDepth: "advanced" }), fetch });
    const response = await provider.search({ query: "q", maxResults: 3, topic: "news", timeRange: "week", includeDomains: ["t.example"], excludeDomains: [] }, signal());
    expect(sent).toEqual([
      {
        url: "https://api.tavily.com/search",
        auth: "Bearer tvly-test",
        body: { query: "q", max_results: 3, topic: "news", search_depth: "advanced", time_range: "week", include_domains: ["t.example"] }
      }
    ]);
    expect(response.results).toEqual([
      { title: "T", url: "https://t.example/", content: "C", published: "2026-10-10" },
      { title: "", url: "https://u.example/", content: "" }
    ]);
  });

  it("reads pages as Markdown, focused on a query when given one, and keeps the failures", async () => {
    const { sent, fetch } = server(() => json(200, { results: [{ url: "https://a.example/", raw_content: "# A" }], failed_results: [{ url: "https://b.example/", error: "blocked" }] }));
    const response = await tavilyProvider({ settings: settings(), fetch }).read!({ urls: ["https://a.example/", "https://b.example/"], query: "pricing" }, signal());
    expect(sent[0]).toMatchObject({ url: "https://api.tavily.com/extract", body: { urls: ["https://a.example/", "https://b.example/"], format: "markdown", query: "pricing" } });
    expect(response).toEqual({ pages: [{ url: "https://a.example/", content: "# A" }], failed: [{ url: "https://b.example/", error: "blocked" }] });
  });

  it.each([
    [401, { detail: { error: "Unauthorized: missing or invalid API key." } }, {}, /refused the API key — the user can check it in Settings → Web search/],
    [429, { detail: { error: "slow down" } }, { "retry-after": "12" }, /rate-limiting this key; try again in 12 s/],
    [432, { detail: { error: "This request exceeds your plan's set usage limit." } }, {}, /credit limit: This request exceeds your plan's set usage limit/],
    [422, { detail: [{ loc: ["body", "max_results"], msg: "too big" }] }, {}, /Tavily answered 422: body.max_results: too big/]
  ])("words a %i so the person knows what to do", async (status, body, headers, message) => {
    const { fetch } = server(() => json(status, body, headers));
    await expect(tavilyProvider({ settings: settings(), fetch }).search({ query: "q", maxResults: 5, topic: "general" }, signal())).rejects.toThrow(message);
  });

  it("says when Tavily cannot be reached at all", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.tavily.com") });
    }) as unknown as typeof globalThis.fetch;
    await expect(tavilyProvider({ settings: settings(), fetch }).search({ query: "q", maxResults: 5, topic: "general" }, signal())).rejects.toThrow(
      "Could not reach api.tavily.com: getaddrinfo ENOTFOUND api.tavily.com — check this machine's network or proxy"
    );
  });
});

describe("the Tavily plugin", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps its key on this machine and out of every agent's reach", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-tavily-"));
    const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], WebSearch, tavily] });
    try {
      const view = ctx.settings.sections().find((s) => s.id === "tavily")!;
      expect(view.scope).toBe("machine");
      expect((view.schema as { properties: Record<string, { format?: string; title?: string }> }).properties.apiKey).toMatchObject({ format: "password", title: "API key" });
      expect(ctx.settings.accessOf(TAVILY_SECTION)).toBe("none");
    } finally {
      await ctx.fiber.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers web_search with the key from Settings", async () => {
    const { sent, fetch } = server(() => json(200, { results: [{ title: "Tomrade", url: "https://tomrade.com/", content: "Plan work with agents." }] }));
    vi.stubGlobal("fetch", fetch);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-tavily-"));
    const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], WebSearch, tavily] });
    try {
      ctx.settings.set({ ...ctx.settings.get(), tavily: { apiKey: "tvly-from-settings", searchDepth: "basic" } });
      const text = await ctx.tools.execute("web_search", { query: "tomrade" }, { by: "human" });
      expect(sent[0]?.auth).toBe("Bearer tvly-from-settings");
      expect(text).toBe("1. Tomrade\nhttps://tomrade.com/\nPlan work with agents.");
      expect(ctx.tools.has("web_fetch")).toBe(true);
    } finally {
      await ctx.fiber.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
