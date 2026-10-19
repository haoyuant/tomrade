/**
 * Kimi as a web search provider: the key comes from the person's Kimi model
 * (or the environment) with nothing else to set up, requests go to that
 * model's host, and answers and errors read the way the agent's tools need.
 */
import { describe, expect, it } from "vitest";
import { kimiKey, kimiProvider, type KimiKey } from "@tomradex/llm";

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
const cn: KimiKey = { key: "sk-kimi", origin: "https://api.moonshot.cn" };
const signal = () => new AbortController().signal;
const now = () => new Date("2026-10-19T12:00:00Z");
const ask = { query: "kimi k3", maxResults: 5, topic: "general" as const };
const provider = (fetch?: typeof globalThis.fetch, key: () => KimiKey | null = () => cn) => kimiProvider({ id: "kimi_search", key, fetch, now });

describe("the Kimi key", () => {
  it("comes from the first Kimi model profile with a key, on that profile's host", () => {
    const profiles = [
      { baseURL: "https://api.deepseek.com", apiKey: "sk-ds" },
      { baseURL: "https://api.moonshot.cn/v1", apiKey: "" },
      { baseURL: "https://api.moonshot.ai/v1", apiKey: " sk-intl " }
    ];
    expect(kimiKey(profiles)).toEqual({ key: "sk-intl", origin: "https://api.moonshot.ai" });
  });

  it("is missing without a Kimi model that has a key", () => {
    expect(kimiKey([])).toBeNull();
    expect(kimiKey([{ baseURL: "https://api.openai.com/v1", apiKey: "sk-oa" }])).toBeNull();
  });

  it("leaves the provider unavailable without a key, saying where a key goes, and points at the model settings", () => {
    expect(provider(undefined, () => null).unavailable()).toMatch(/Settings → Models/);
    expect(provider().unavailable()).toBeNull();
    expect(provider().settings).toBe("assistant");
  });
});

describe("the Kimi provider", () => {
  it("searches with the basic search on the key's host and maps the results", async () => {
    const { sent, fetch } = server(() => json(200, { search_results: [{ title: "Kimi K3", url: "https://moonshot.ai/k3", date: "2026-10-01", snippet: "An excerpt.", site_name: "Moonshot" }] }));
    const out = await provider(fetch).search(ask, signal());
    expect(sent).toEqual([{ url: "https://api.moonshot.cn/v1/tools/search", auth: "Bearer sk-kimi", body: { text_query: "kimi k3", limit: 5, timeout_seconds: 30 } }]);
    expect(out.results).toEqual([{ title: "Kimi K3", url: "https://moonshot.ai/k3", content: "An excerpt.", published: "2026-10-01" }]);
  });

  it("uses the Pro search only to narrow by site or date, and drops excluded sites itself", async () => {
    const { sent, fetch } = server(() =>
      json(200, { search_results: [{ title: "a", url: "https://docs.example.com/a", chunks: [{ text: "first" }, { text: "second" }] }, { title: "b", url: "https://spam.example.org/b", snippet: "x" }] })
    );
    const out = await provider(fetch).search({ ...ask, includeDomains: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"], timeRange: "week", excludeDomains: ["example.org"] }, signal());
    expect(sent[0]!.url).toBe("https://api.moonshot.cn/v1/tools/search_pro");
    expect(sent[0]!.body).toEqual({ text_query: "kimi k3", limit: 5, timeout_seconds: 30, sites: ["a.com", "b.com", "c.com", "d.com", "e.com"], time_window: { start: "2026-10-12", end: "2026-10-19" } });
    expect(out.results).toEqual([{ title: "a", url: "https://docs.example.com/a", content: "first\nsecond" }]);
  });

  it("reads one page per request and lists the ones it could not read", async () => {
    const { sent, fetch } = server((s) => (s.body.url === "https://ok.example/" ? json(200, { url: "https://ok.example/", title: "OK", markdown: "# OK" }) : json(404, { error: { message: "no markdown found", type: "markdown_not_found" } })));
    const out = await provider(fetch).read!({ urls: ["https://ok.example/", "https://gone.example/"] }, signal());
    expect(sent.map((s) => [s.url, s.body])).toEqual([
      ["https://api.moonshot.cn/v1/tools/fetch", { url: "https://ok.example/" }],
      ["https://api.moonshot.cn/v1/tools/fetch", { url: "https://gone.example/" }]
    ]);
    expect(out).toEqual({ pages: [{ url: "https://ok.example/", content: "# OK" }], failed: [{ url: "https://gone.example/", error: "Kimi answered 404: no markdown found" }] });
  });

  it("words a refused key, a rate limit and other errors so the agent can say what to do", async () => {
    const replies = [new Response(null, { status: 401 }), json(429, { error: { message: "slow down", type: "rate_limited" } }, { "x-ratelimit-reset": "1792390000" }), json(504, { error: { message: "search timed out", type: "timeout" } })];
    const { fetch } = server(() => replies.shift()!);
    const p = provider(fetch);
    await expect(p.search(ask, signal())).rejects.toThrow(/refused the API key.*Settings → Models/);
    await expect(p.search(ask, signal())).rejects.toThrow("Kimi is rate-limiting this key; try again after 1792390000");
    await expect(p.search(ask, signal())).rejects.toThrow("Kimi answered 504: search timed out");
  });

  it("says when Moonshot cannot be reached", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.moonshot.cn") });
    }) as unknown as typeof globalThis.fetch;
    await expect(provider(fetch).search(ask, signal())).rejects.toThrow("Could not reach api.moonshot.cn: getaddrinfo ENOTFOUND api.moonshot.cn — check this machine's network or proxy");
  });
});
