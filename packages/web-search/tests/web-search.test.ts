/**
 * The web search module: tools that exist while a provider does, answered by
 * the first provider that is set up, shaped as text an agent can cite.
 */
import { describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { fresh, settle } from "@tomradex/testkit";
import { ToolInputError, Tools } from "@tomradex/tools";
import WebSearch, { formatPages, type SearchRequest, type WebSearchProvider } from "@tomradex/web-search";

const providerPlugin = (provider: WebSearchProvider) => ({
  name: `search-${provider.id}`,
  inject: ["webSearch"],
  apply: (ctx: Context) => void ctx.webSearch.register(provider)
});

const fake = (id: string, over: Partial<WebSearchProvider> = {}): WebSearchProvider & { asked: SearchRequest[] } => {
  const asked: SearchRequest[] = [];
  return {
    id,
    title: id,
    asked,
    unavailable: () => null,
    async search(request) {
      asked.push(request);
      return { results: [{ title: `${id} result`, url: `https://${id}.example/a`, content: "An excerpt.", published: "2026-10-01" }] };
    },
    ...over
  };
};

async function boot(...providers: WebSearchProvider[]) {
  const { ctx } = await fresh({ plugins: [Tools, WebSearch] });
  const fibers = [];
  for (const provider of providers) fibers.push(ctx.plugin(providerPlugin(provider)));
  await settle();
  return { ctx, fibers };
}

const by = "human" as const;

describe("web search tools", () => {
  it("are offered only while a provider is registered, web_fetch only while one can read, and are served over MCP", async () => {
    const { ctx } = await boot();
    expect(ctx.tools.has("web_search")).toBe(false);

    const searchOnly = ctx.plugin(providerPlugin(fake("a")));
    await settle();
    expect(ctx.tools.has("web_search")).toBe(true);
    expect(ctx.tools.has("web_fetch")).toBe(false);
    expect(ctx.tools.served().map((t) => t.name)).toContain("web_search");

    const reader = ctx.plugin(providerPlugin(fake("b", { read: async () => ({ pages: [], failed: [] }) })));
    await settle();
    expect(ctx.tools.has("web_fetch")).toBe(true);

    await reader.dispose();
    expect(ctx.tools.has("web_fetch")).toBe(false);
    expect(ctx.tools.has("web_search")).toBe(true);
    await searchOnly.dispose();
    expect(ctx.tools.has("web_search")).toBe(false);
    await ctx.fiber.dispose();
  });

  it("asks the first provider that is set up, with defaults filled in, and returns citable text", async () => {
    const notReady = fake("a", { unavailable: () => "no key" });
    const ready = fake("b");
    const { ctx } = await boot(notReady, ready);
    const text = await ctx.tools.execute("web_search", { query: "cordis 4 release" }, { by });
    expect(notReady.asked).toEqual([]);
    expect(ready.asked).toEqual([{ query: "cordis 4 release", maxResults: 5, topic: "general" }]);
    expect(text).toBe("1. b result\nhttps://b.example/a · 2026-10-01\nAn excerpt.");
    await ctx.fiber.dispose();
  });

  it("passes on why nobody can answer, so the agent can tell the person what to set up", async () => {
    const { ctx } = await boot(fake("a", { unavailable: () => "Web search has no Tavily API key yet" }));
    await expect(ctx.tools.execute("web_search", { query: "x" }, { by })).rejects.toThrow("Web search has no Tavily API key yet");
    await ctx.fiber.dispose();
  });

  it("says when a search found nothing", async () => {
    const { ctx } = await boot(fake("a", { search: async () => ({ results: [] }) }));
    expect(await ctx.tools.execute("web_search", { query: "zzqx" }, { by })).toBe('No results for "zzqx".');
    await ctx.fiber.dispose();
  });

  it("hands the caller's cancellation to the provider", async () => {
    let seen: AbortSignal | undefined;
    const { ctx } = await boot(
      fake("a", {
        search: (_, signal) =>
          new Promise((_resolve, reject) => {
            seen = signal;
            signal.addEventListener("abort", () => reject(signal.reason));
          })
      })
    );
    const stop = new AbortController();
    const call = ctx.tools.execute("web_search", { query: "x" }, { by, signal: stop.signal });
    await settle();
    stop.abort(new Error("run stopped"));
    await expect(call).rejects.toThrow("run stopped");
    expect(seen?.aborted).toBe(true);
    await ctx.fiber.dispose();
  });

  it("reads only http(s) pages, at most five at a time", async () => {
    const { ctx } = await boot(fake("a", { read: async ({ urls }) => ({ pages: urls.map((url) => ({ url, content: "text" })), failed: [] }) }));
    await expect(ctx.tools.execute("web_fetch", { urls: ["file:///etc/passwd"] }, { by })).rejects.toBeInstanceOf(ToolInputError);
    await expect(ctx.tools.execute("web_fetch", { urls: Array.from({ length: 6 }, (_, i) => `https://e.example/${i}`) }, { by })).rejects.toBeInstanceOf(ToolInputError);
    expect(await ctx.tools.execute("web_fetch", { urls: ["https://e.example/"] }, { by })).toBe("# https://e.example/\n\ntext");
    await ctx.fiber.dispose();
  });
});

describe("formatPages", () => {
  it("shares one budget between the pages and lists what could not be read", () => {
    const text = formatPages({
      pages: [
        { url: "https://a.example/", content: "a".repeat(20_000) },
        { url: "https://b.example/", content: "short" }
      ],
      failed: [{ url: "https://c.example/", error: "403" }]
    });
    expect(text).toContain("[… cut at 8000 of 20000 characters");
    expect(text).toContain("# https://b.example/\n\nshort");
    expect(text).toContain("Could not read:\n- https://c.example/ — 403");
    expect(text.length).toBeLessThan(17_000);
  });
});
