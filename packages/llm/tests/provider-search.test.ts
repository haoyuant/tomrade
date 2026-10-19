/**
 * Web search follows the model providers: a DeepSeek or Kimi model's key brings
 * that provider's search service to web search, with nothing to install, and
 * takes it away with the key; Settings can say which way search goes now.
 */
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { afterEach, expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { Tools } from "@tomradex/tools";
import WebSearch from "@tomradex/web-search";
import { Llm, type ModelsSettings } from "@tomradex/llm";

afterEach(() => vi.unstubAllGlobals());

const deepseek = { id: "d", title: "DeepSeek", provider: "openai-compatible", baseURL: "https://api.deepseek.com", apiKey: "sk-ds", model: "deepseek-flash" };
const kimi = { id: "k", title: "Kimi", provider: "openai-compatible", baseURL: "https://api.moonshot.ai/v1", apiKey: "sk-kimi", model: "kimi-k3" };
const claude = { id: "c", title: "Claude", provider: "anthropic", apiKey: "sk-ant", model: "claude-sonnet-5" };

async function boot() {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-provider-search-${Date.now()}-${Math.random()}.json`) });
  await ctx.plugin(Tools);
  await ctx.plugin(WebSearch);
  await ctx.plugin(Llm);
  const use = (profiles: ModelsSettings["profiles"]) => ctx.settings.set({ ...ctx.settings.get(), models: { profiles, roles: { worker: "" } } });
  return { ctx, use, providers: () => ctx.webSearch.providers().map((p) => p.id) };
}

it("brings DeepSeek's and Kimi's search with their models' keys, and takes it away with them", async () => {
  const sent: { url: string; auth: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, auth: new Headers(init.headers).get("authorization") });
    return new Response(JSON.stringify({ results: [{ title: "DeepSeek Search API", url: "https://api-docs.deepseek.com/guides/search/", summary: "Search and fetch." }] }));
  });
  const { ctx, use, providers } = await boot();
  expect(providers()).toEqual([]);
  expect(ctx.webSearch.unavailable()).not.toBeNull();

  use([deepseek]);
  expect(providers()).toEqual(["deepseek"]);
  const answer = await ctx.tools.execute("web_search", { query: "deepseek search api" }, { by: "ai:test" });
  expect(String(answer)).toContain("https://api-docs.deepseek.com/guides/search/");
  expect(sent).toEqual([{ url: "https://api.deepseek.com/v1/tools/search", auth: "Bearer sk-ds" }]);

  use([deepseek, kimi]);
  expect(providers()).toEqual(["deepseek", "kimi"]);
  use([kimi]);
  expect(providers()).toEqual(["kimi"]);
  use([{ ...kimi, apiKey: "" }]);
  expect(providers()).toEqual([]);
});

it("says which models search on their own and which service searches for the rest", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
  const { ctx, use } = await boot();
  const llm = ctx.llm as Llm;
  use([claude]);
  expect(llm.searchRoute()).toEqual({ native: ["Claude"], service: null });
  use([claude, deepseek]);
  expect(llm.searchRoute()).toEqual({ native: ["Claude"], service: "DeepSeek" });
  use([deepseek]);
  expect(llm.searchRoute()).toEqual({ native: [], service: "DeepSeek" });
});
