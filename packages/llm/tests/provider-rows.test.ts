/**
 * Each of the app's own model providers is a row of its own: the catch-all's
 * profiles at a provider's hosts move to it with their address and key kept,
 * and a provider switched off takes its presets with it.
 */
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { afterEach, expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { Tools } from "@tomradex/tools";
import WebSearch from "@tomradex/web-search";
import { Llm, collect, userMessage, type ModelsSettings } from "@tomradex/llm";
import ProviderRow from "@tomradex/llm/provider";

afterEach(() => vi.unstubAllGlobals());

const compatible = (id: string, baseURL?: string) => ({ id, title: id, provider: "openai-compatible", ...(baseURL ? { baseURL } : {}), apiKey: `key-${id}`, model: "m" });

async function boot(profiles: ModelsSettings["profiles"], config?: { builtins: boolean }) {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-provider-rows-${Date.now()}-${Math.random()}.json`) });
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles, roles: { worker: "o" } } });
  await ctx.plugin(Llm, config);
  return { ctx, llm: ctx.llm as Llm, saved: () => (ctx.settings.get().models as ModelsSettings).profiles };
}

it("moves the catch-all's profiles at DeepSeek, Kimi, OpenAI and OpenRouter to their own providers, address, key and roles kept", async () => {
  const { ctx, llm, saved } = await boot([
    compatible("d", "https://api.deepseek.com"),
    compatible("bare"),
    compatible("kc", "https://api.moonshot.cn/v1"),
    compatible("ka", "https://api.moonshot.ai/v1"),
    compatible("o", "https://api.openai.com/v1"),
    compatible("r", "https://openrouter.ai/api/v1"),
    compatible("local", "http://127.0.0.1:11434/v1")
  ]);
  expect(saved().map((p) => [p.id, p.provider, p.baseURL])).toEqual([
    ["d", "deepseek", "https://api.deepseek.com"],
    // one saved without an address always talked to DeepSeek, and still does
    ["bare", "deepseek", "https://api.deepseek.com"],
    ["kc", "kimi", "https://api.moonshot.cn/v1"],
    ["ka", "kimi", "https://api.moonshot.ai/v1"],
    ["o", "openai", "https://api.openai.com/v1"],
    ["r", "openrouter", "https://openrouter.ai/api/v1"],
    ["local", "openai-compatible", "http://127.0.0.1:11434/v1"]
  ]);
  expect(saved().every((p) => p.apiKey === `key-${p.id}`)).toBe(true);
  expect((ctx.settings.get().models as ModelsSettings).roles.worker).toBe("o");

  // the same wire at the same address: nothing about a conversation changes
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    sent.push(url);
    return new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  for (const id of ["d", "ka", "o", "r"]) expect((await collect(llm.forProfile(id).chat({ system: "", messages: [userMessage("ping")] }))).text).toBe("hi");
  expect(sent).toEqual(["https://api.deepseek.com/chat/completions", "https://api.moonshot.ai/v1/chat/completions", "https://api.openai.com/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions"]);
  expect(llm.forProfile("local").capabilities.tools).toBe(true);
});

it("serves only what a row registers, and a provider switched off takes its presets and its profiles' models with it", async () => {
  const { ctx, llm, saved } = await boot([compatible("k", "https://api.moonshot.cn/v1")], { builtins: false });
  expect(llm.providers()).toEqual([]);
  const kimi = ctx.plugin(ProviderRow, { provider: "kimi" });
  await ctx.plugin(ProviderRow, { provider: "openai-compatible" });
  await kimi;
  // the row's provider claims the profile as it registers
  expect(saved()[0]).toMatchObject({ provider: "kimi", baseURL: "https://api.moonshot.cn/v1" });
  expect(llm.providers().map((p) => p.id)).toEqual(["kimi", "ollama"]);
  expect(llm.modelProviders().map((p) => p.id)).toEqual(["openai-compatible", "kimi"]);
  expect(llm.forProfile("k").capabilities.tools).toBe(true);

  await kimi.dispose();
  expect(llm.providers().map((p) => p.id)).toEqual(["ollama"]);
  expect(() => llm.forProfile("k")).toThrow(/No model provider "kimi" is installed/);
  await ctx.plugin(ProviderRow, { provider: "kimi" });
  expect(llm.providers().map((p) => p.id)).toEqual(["kimi", "ollama"]);
  expect(llm.forProfile("k").capabilities.tools).toBe(true);
});

it("takes a provider's search service away with its row, and brings it back with it", async () => {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-provider-rows-${Date.now()}-${Math.random()}.json`) });
  await ctx.plugin(Tools);
  await ctx.plugin(WebSearch);
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [compatible("k", "https://api.moonshot.ai/v1")], roles: { worker: "" } } });
  await ctx.plugin(Llm, { builtins: false });
  const searches = () => ctx.webSearch.providers().map((p) => p.id);
  const kimi = ctx.plugin(ProviderRow, { provider: "kimi" });
  await kimi;
  expect(searches()).toEqual(["kimi"]);
  await kimi.dispose();
  expect(searches()).toEqual([]);
  await ctx.plugin(ProviderRow, { provider: "kimi" });
  expect(searches()).toEqual(["kimi"]);
});

it("offers nothing on an llm row replaced by one that takes no providers, and loads without failing", async () => {
  const ctx = new Context();
  const warned: string[] = [];
  // the documented seam: an LLMProvider of one's own in the llm row
  class OwnLlm extends Service {
    static provide = "llm";
    constructor(ctx: Context) {
      super(ctx, "llm");
    }
    async completeJson() {
      return {};
    }
  }
  await ctx.plugin(OwnLlm);
  const original = ctx.logger;
  (ctx as unknown as { logger: unknown }).logger = (name: string) => ({ ...original.call(ctx, name), warn: (message: string) => warned.push(message) });
  const row = ctx.plugin(ProviderRow, { provider: "kimi" });
  await expect(row).resolves.toBeDefined();
  expect(warned).toEqual(["kimi: the llm row in use takes no model providers, so this one is not offered"]);
  expect(typeof (ctx.llm as { completeJson?: unknown }).completeJson).toBe("function");
});
