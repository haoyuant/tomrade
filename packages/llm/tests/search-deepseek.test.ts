/**
 * DeepSeek as a web search provider: the key comes from the person's DeepSeek
 * model with nothing else to set up, narrowing that DeepSeek cannot do is done
 * here, and answers and errors read the way the agent's tools need.
 */
import { describe, expect, it } from "vitest";
import { deepseekKey, deepseekProvider, type DeepSeekKey } from "@tomradex/llm";

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

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const key: DeepSeekKey = { key: "sk-ds", origin: "https://api.deepseek.com" };
const signal = () => new AbortController().signal;
const now = () => new Date("2026-10-19T12:00:00Z");
const ask = { query: "deepseek v4", maxResults: 5, topic: "general" as const };
const provider = (fetch?: typeof globalThis.fetch, k: () => DeepSeekKey | null = () => key) => deepseekProvider({ id: "deepseek_search", key: k, fetch, now });
const hit = (url: string, date: string | null = null, extra: Record<string, unknown> = {}) => ({ title: url, url, snippet: "snip", summary: "", date, ...extra });

describe("the DeepSeek key", () => {
  it("comes from the first DeepSeek model profile with a key", () => {
    expect(deepseekKey([{ baseURL: "https://api.moonshot.cn/v1", apiKey: "sk-k" }, { baseURL: "https://api.deepseek.com", apiKey: "" }, { baseURL: "https://api.deepseek.com/v1", apiKey: " sk-ds " }])).toEqual(key);
    expect(deepseekKey([{ baseURL: "https://openrouter.ai/api/v1", apiKey: "sk-or" }])).toBeNull();
  });

  it("leaves the provider unavailable without one, pointing at the model settings", () => {
    expect(provider(undefined, () => null).unavailable()).toMatch(/DeepSeek model with an API key.*Settings → Models/);
    expect(provider().unavailable()).toBeNull();
    expect(provider().settings).toBe("assistant");
  });
});

describe("the DeepSeek provider", () => {
  it("searches as asked and maps the results, the summary before the snippet", async () => {
    const { sent, fetch } = server(() => json(200, { results: [hit("https://a.example/", "2026-10-17T00:00:00Z", { summary: "A summary." }), hit("https://b.example/")] }));
    const out = await provider(fetch).search(ask, signal());
    expect(sent).toEqual([{ url: "https://api.deepseek.com/v1/tools/search", auth: "Bearer sk-ds", body: { query: "deepseek v4", count: 5 } }]);
    expect(out.results).toEqual([
      { title: "https://a.example/", url: "https://a.example/", content: "A summary.", published: "2026-10-17T00:00:00Z" },
      { title: "https://b.example/", url: "https://b.example/", content: "snip" }
    ]);
  });

  it("puts one site in the query and keeps the query within 128 characters", async () => {
    const { sent, fetch } = server(() => json(200, { results: [] }));
    await provider(fetch).search({ ...ask, query: "x".repeat(200), includeDomains: ["docs.python.org"] }, signal());
    expect(sent[0]!.body.query).toBe(`${"x".repeat(128 - " site:docs.python.org".length)} site:docs.python.org`);
    expect((sent[0]!.body.query as string).length).toBe(128);
    expect(sent[0]!.body.count).toBe(5);
  });

  it("filters several sites, excluded ones and a time range from a full page of results", async () => {
    const results = [
      hit("https://docs.a.com/1", "2026-10-18T00:00:00Z"),
      hit("https://b.com/2", "2026-10-01T00:00:00Z"),
      hit("https://spam.a.com/3", "2026-10-18T00:00:00Z"),
      hit("https://c.com/4", "2026-10-18T00:00:00Z"),
      hit("https://b.com/5", null)
    ];
    const { sent, fetch } = server(() => json(200, { results }));
    const out = await provider(fetch).search({ ...ask, includeDomains: ["a.com", "b.com"], excludeDomains: ["spam.a.com"], timeRange: "week" }, signal());
    expect(sent[0]!.body).toEqual({ query: "deepseek v4", count: 50 });
    expect(out.results.map((r) => r.url)).toEqual(["https://docs.a.com/1"]);
  });

  it("reads one page per request and lists the ones it could not read", async () => {
    const { sent, fetch } = server((s) => (s.body.url === "https://ok.example/" ? json(200, { title: "OK", content: "# OK" }) : json(404, { error: { message: "no usable content", type: "not_found" } })));
    const out = await provider(fetch).read!({ urls: ["https://ok.example/", "https://gone.example/"] }, signal());
    expect(sent.map((s) => [s.url, s.body])).toEqual([
      ["https://api.deepseek.com/v1/tools/fetch", { url: "https://ok.example/" }],
      ["https://api.deepseek.com/v1/tools/fetch", { url: "https://gone.example/" }]
    ]);
    expect(out).toEqual({ pages: [{ url: "https://ok.example/", content: "# OK" }], failed: [{ url: "https://gone.example/", error: "DeepSeek found no readable content on this page" }] });
  });

  it("words a refused key, an empty balance, the rate limit and other errors so the agent can say what to do", async () => {
    const replies = [json(401, {}), json(402, {}), json(429, {}), json(504, { error: { message: "downstream timeout" } })];
    const { fetch } = server(() => replies.shift()!);
    const p = provider(fetch);
    await expect(p.search(ask, signal())).rejects.toThrow(/refused the API key.*Settings → Models/);
    await expect(p.search(ask, signal())).rejects.toThrow(/run out of balance/);
    await expect(p.search(ask, signal())).rejects.toThrow(/rate-limiting/);
    await expect(p.search(ask, signal())).rejects.toThrow("DeepSeek answered 504: downstream timeout");
  });
});
