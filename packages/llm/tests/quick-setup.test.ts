/**
 * Quick setup: one pasted key becomes a working profile — the provider's model
 * listing checks the key and names a model — and keys already exported in the
 * shell, or a local Ollama, are offered without typing anything.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { guessProviders, Llm, pickModel, PROVIDERS, usableModels, type ModelsSettings } from "@tomradex/llm";

let server: http.Server;
let base = "";
const realFetch = globalThis.fetch;
const listed: Record<string, string[]> = { deepseek: ["deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-pro"], ollama: [] };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const [, who] = req.url!.split("/");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (who === "deepseek" && !req.headers.authorization?.startsWith("Bearer sk-good")) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"Authentication Fails, Your api key is invalid"}}');
      if (req.url!.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: listed[who].map((id) => ({ id })) }));
      res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
afterEach(() => vi.unstubAllGlobals());

async function llm() {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    realFetch(String(url).replace("https://api.deepseek.com", `${base}/deepseek`).replace("http://127.0.0.1:11434/v1", `${base}/ollama`), init));
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-quick-${Date.now()}-${Math.random()}.json`) });
  await ctx.plugin(Llm);
  return ctx;
}

it("tells keys apart by their shape where it can", () => {
  expect(guessProviders("sk-ant-api03-xyz")).toEqual(["anthropic"]);
  expect(guessProviders(" sk-or-v1-abc ")).toEqual(["openrouter"]);
  expect(guessProviders("sk-proj-abc")).toEqual(["openai"]);
  expect(guessProviders("sk-0123456789abcdef0123456789abcdef")).toEqual(["deepseek"]);
  expect(guessProviders("AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q")).toEqual(["gemini"]);
  expect(guessProviders("whatever")).toEqual([]);
  // Gemini's compatible endpoint lists `models/<id>`: the newest flash, not an image or TTS model.
  const gemini = PROVIDERS.find((p) => p.id === "gemini")!;
  expect(gemini).toMatchObject({ provider: "openai-compatible", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", keyPage: "https://aistudio.google.com/apikey", env: "GEMINI_API_KEY" });
  expect(pickModel(gemini, ["models/gemini-2.5-flash", "models/gemini-2.5-flash-image", "models/gemini-3.6-flash", "models/gemini-3.1-pro-preview", "models/gemini-2.5-flash-preview-tts"])).toBe("models/gemini-3.6-flash");
  expect(pickModel({ model: "deepseek-chat", prefer: [/flash/] }, ["deepseek-reasoner", "deepseek-v4-flash", "deepseek-v3-flash"])).toBe("deepseek-v4-flash");
  expect(pickModel({ model: "deepseek-chat", prefer: [/flash/] }, ["deepseek-chat", "deepseek-v4-flash"])).toBe("deepseek-chat");
  expect(pickModel({ model: "deepseek-chat", prefer: [] }, null)).toBe("deepseek-chat");
  expect(pickModel({ model: "", prefer: [/^gpt-\d+(\.\d+)?$/] }, ["gpt-5", "gpt-5.10", "gpt-5.9", "gpt-image-2"])).toBe("gpt-5.10");
});

it("turns a pasted key into the first profile, with a model the provider lists", async () => {
  const ctx = await llm();
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [{ id: "old", title: "Old", provider: "openai-compatible", baseURL: "https://example.com/v1", apiKey: "x", model: "y" }], roles: { worker: "" } } });
  expect(await ctx.llm.quickSetup({ preset: "deepseek", apiKey: "sk-bad" })).toMatchObject({ ok: false, kind: "auth" });
  expect(await ctx.llm.quickSetup({ preset: "deepseek", apiKey: " sk-good " })).toEqual({ ok: true, profile: { id: "deepseek", title: "DeepSeek", model: "deepseek-v4-flash" } });
  const profiles = (ctx.settings.get().models as ModelsSettings).profiles;
  expect(profiles.map((p) => p.id)).toEqual(["deepseek", "old"]);
  expect(profiles[0]).toMatchObject({ provider: "openai-compatible", baseURL: "https://api.deepseek.com", apiKey: "sk-good" });
  expect(ctx.llm.ready().ok).toBe(true);
  // a second key for the same endpoint replaces the first rather than stacking profiles
  await ctx.llm.quickSetup({ preset: "deepseek", apiKey: "sk-good" });
  expect((ctx.settings.get().models as ModelsSettings).profiles.map((p) => p.id)).toEqual(["deepseek", "old"]);
});

it("finds keys in the environment and a local Ollama, and adopts them without the key crossing to the page", async () => {
  const ctx = await llm();
  for (const name of ["DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) vi.stubEnv(name, "");
  vi.stubEnv("DEEPSEEK_API_KEY", "sk-good-from-shell-1a2b");
  listed.ollama = [];
  expect(await ctx.llm.detect()).toEqual([{ id: "env:DEEPSEEK_API_KEY", preset: "deepseek", source: "env", detail: "DEEPSEEK_API_KEY · sk-…1a2b" }]);
  listed.ollama = ["qwen3:8b", "llama4"];
  expect((await ctx.llm.detect()).map((d) => d.id)).toEqual(["env:DEEPSEEK_API_KEY", "local:ollama"]);
  expect(await ctx.llm.adopt("env:DEEPSEEK_API_KEY")).toMatchObject({ ok: true, profile: { id: "deepseek" } });
  expect(await ctx.llm.adopt("local:ollama")).toMatchObject({ ok: true, profile: { id: "ollama", model: "qwen3:8b" } });
  expect(await ctx.llm.detect()).toEqual([]);
  vi.unstubAllEnvs();
});

it("lists an endpoint's chat models for the profile form, or why it cannot", async () => {
  const ctx = await llm();
  expect(await ctx.llm.listing({ provider: "openai-compatible", baseURL: "https://api.deepseek.com", apiKey: "sk-good" })).toEqual({ ok: true, models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-reasoner"] });
  expect(await ctx.llm.listing({ provider: "openai-compatible", baseURL: "https://api.deepseek.com", apiKey: "" })).toMatchObject({ ok: false, kind: "auth" });
  expect(usableModels("openai-compatible", ["gpt-5", "text-embedding-3-large", "whisper-1", "gpt-image-2", "tts-1", "gpt-5.10"])).toEqual(["gpt-5.10", "gpt-5"]);
  expect(usableModels("openai-images", ["gpt-5", "gpt-image-2", "dall-e-3"])).toEqual(["gpt-image-2", "dall-e-3"]);
});
