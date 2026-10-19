/**
 * Model providers: a profile is built, listed and checked by the provider it
 * names, so a provider added from outside core serves its profiles and offers
 * its presets like the built-in ones; a profile whose provider is gone says so.
 */
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { FakeChatModel, Llm, collect, userMessage, type ModelProviderSpec, type ModelsSettings } from "@tomradex/llm";

const echo = (built: string[]): ModelProviderSpec => ({
  id: "echo",
  title: { en: "Echo", zh: "回声" },
  signIn: "apiKey",
  keyRequired: true,
  baseURL: { default: "https://echo.example", editable: false },
  chat: true,
  defaultInput: ["image"],
  capabilities: (model, listed) => listed ?? (model === "echo-1" ? { inputModalities: ["image"], outputModalities: [] } : undefined),
  presets: [{ id: "echo-cloud", title: "Echo Cloud", baseURL: "", model: "echo-1", prefer: [], keyShapes: [/^echo-/], hint: { en: "Echoes", zh: "回声" } }],
  list: async (endpoint) => (endpoint.apiKey ? { ok: true, models: ["echo-1", "echo-embed"], capabilities: {} } : { ok: false, status: 401, detail: "401 no key" }),
  usable: (listed) => listed.filter((id) => !id.includes("embed")),
  build: (profile) => {
    built.push(profile.model);
    return new FakeChatModel([{ text: `echo from ${profile.model}` }]);
  }
});

async function llm(profiles: ModelsSettings["profiles"]) {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-providers-${Date.now()}-${Math.random()}.json`) });
  await ctx.plugin(Llm);
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles, roles: { worker: "" } } });
  return ctx.llm as Llm;
}

it("builds, lists and checks a profile through the provider it names, and offers that provider's presets", async () => {
  const built: string[] = [];
  const service = await llm([{ id: "e", title: "Echo", provider: "echo", apiKey: "echo-key", model: "echo-1" }]);
  const withdraw = service.registerProvider(echo(built));

  expect((await collect(service.forProfile("e").chat({ system: "", messages: [userMessage("hi")] }))).text).toBe("echo from echo-1");
  expect(await service.listing({ provider: "echo", apiKey: "echo-key" })).toEqual({ ok: true, models: ["echo-1"], capabilities: { "echo-1": { inputModalities: ["image"], outputModalities: [] } } });
  expect(await service.listing({ provider: "echo", apiKey: "" })).toMatchObject({ ok: false, kind: "auth" });
  expect(await service.test({ id: "t", title: "", provider: "echo", apiKey: "k", model: "echo-1" })).toEqual({ ok: true });
  expect(service.ready()).toMatchObject({ ok: true, profile: { provider: "echo" } });

  expect(service.providers().at(-1)).toMatchObject({ id: "echo-cloud", provider: "echo", model: "echo-1", hint: "Echoes" });
  expect(service.modelProviders().find((p) => p.id === "echo")).toEqual({ id: "echo", title: "Echo", keyRequired: true, baseURL: { default: "https://echo.example", editable: false }, chat: true, defaultInput: ["image"] });
  expect(service.modelProviders().map((p) => p.id)).toEqual(["openai-compatible", "anthropic", "openai-images", "echo"]);
  expect(await service.quickSetup({ preset: "echo-cloud", apiKey: "echo-key" })).toMatchObject({ ok: true, profile: { model: "echo-1" } });

  withdraw();
  expect(() => service.forProfile("e")).toThrow(/No model provider "echo" is installed/);
  expect(await service.test({ id: "t", title: "", provider: "echo", apiKey: "k", model: "echo-1" })).toMatchObject({ ok: false, kind: "model" });
  expect(service.providers().some((p) => p.id === "echo-cloud")).toBe(false);
});

it("asks for a key only where the provider needs one", async () => {
  const service = await llm([{ id: "a", title: "", provider: "anthropic", apiKey: "", model: "claude-sonnet-5" }]);
  expect(service.ready()).toMatchObject({ ok: false });
  const local = await llm([{ id: "o", title: "", provider: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1", apiKey: "", model: "qwen3" }]);
  expect(local.ready()).toMatchObject({ ok: true });
});
