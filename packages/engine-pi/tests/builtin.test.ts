import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { Llm, type ModelProfile } from "@tomradex/llm";
import { Mcp } from "@tomradex/mcp";
import { builtinPi, modelsFile, piTarget } from "@tomradex/engine-pi";
import { usableProfile } from "../src/target.js";

const profile = (patch: Partial<ModelProfile>): ModelProfile => ({ id: "p1", title: "", provider: "openai-compatible", apiKey: "sk-secret", model: "m", ...patch });

it("runs a known endpoint as pi's own provider only when pi's catalog lists the model", () => {
  const catalog = new Set(["deepseek/deepseek-flash", "anthropic/claude-sonnet-5", "moonshotai-cn/kimi-k3", "google/gemini-3.8-flash"]);
  expect(piTarget(profile({ baseURL: "https://api.deepseek.com", model: "deepseek-flash" }), catalog)).toEqual({ model: "deepseek/deepseek-flash", env: { DEEPSEEK_API_KEY: "sk-secret" } });
  expect(piTarget(profile({ provider: "anthropic", model: "claude-sonnet-5" }), catalog)).toEqual({ model: "anthropic/claude-sonnet-5", env: { ANTHROPIC_API_KEY: "sk-secret" } });
  expect(piTarget(profile({ baseURL: "https://api.moonshot.cn/v1", model: "kimi-k3" }), catalog).model).toBe("moonshotai-cn/kimi-k3");
  expect(piTarget(profile({ provider: "gemini", model: "gemini-3.8-flash" }), catalog)).toEqual({ model: "google/gemini-3.8-flash", env: { GEMINI_API_KEY: "sk-secret" } });
  // an alias pi does not list, and an endpoint pi has no provider for
  expect(piTarget(profile({ baseURL: "https://api.deepseek.com", model: "deepseek-chat" }), catalog)).toEqual({ model: "tomrade-p1/deepseek-chat", env: { TOMRADE_KEY_P1: "sk-secret" } });
  expect(piTarget(profile({ id: "my local", baseURL: "http://127.0.0.1:11434/v1", apiKey: "", model: "qwen3" }), catalog)).toEqual({ model: "tomrade-my-local/qwen3", env: {} });
});

it("writes models.json with keys named by variable, never the key itself", () => {
  const file = modelsFile([
    profile({ baseURL: "https://api.example.com/v1", inputModalities: ["image"] }),
    profile({ id: "local", baseURL: "http://127.0.0.1:11434/v1", apiKey: "", model: "qwen3" }),
    profile({ id: "claude", provider: "anthropic", model: "claude-sonnet-5" }),
    profile({ id: "pics", provider: "openai-images", model: "gpt-image" }),
    profile({ id: "gem", provider: "gemini", model: "gemini-4-argon", inputModalities: ["image", "pdf"] }),
    profile({ id: "ds", provider: "deepseek", model: "deepseek-flash" }),
    profile({ id: "or", provider: "openrouter", baseURL: "https://openrouter.ai/api/v1", model: "x/y" }),
    // a plugin's provider talks its own API: pi never gets its key, nor guesses an address for it
    profile({ id: "acme", provider: "acme", model: "acme-large" })
  ]);
  expect(JSON.stringify(file)).not.toContain("sk-secret");
  expect(file.providers["tomrade-p1"]).toEqual({ baseUrl: "https://api.example.com/v1", api: "openai-completions", apiKey: "$TOMRADE_KEY_P1", models: [{ id: "m", name: "m", input: ["text", "image"] }] });
  expect(file.providers["tomrade-local"]).toMatchObject({ apiKey: "none", models: [{ input: ["text"] }] });
  expect(file.providers["tomrade-claude"]).toMatchObject({ baseUrl: "https://api.anthropic.com", api: "anthropic-messages", models: [{ input: ["text", "image"] }] });
  expect(file.providers["tomrade-pics"]).toBeUndefined();
  expect(file.providers["tomrade-gem"]).toMatchObject({ baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai", models: [{ input: ["text", "image"] }] });
  expect(file.providers["tomrade-ds"]).toMatchObject({ baseUrl: "https://api.deepseek.com", api: "openai-completions" });
  expect(file.providers["tomrade-or"]).toMatchObject({ baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" });
  expect(file.providers["tomrade-acme"]).toBeUndefined();
});

/** An endpoint that answers any chat request, so a profile can pass its one-token test without the network. */
async function endpoint(): Promise<{ baseURL: string; close(): void }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { baseURL: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}

it("writes models.json for a provider plugin that declared a plain wire, and nothing for one that did not", () => {
  const kinds = new Map([["acme", { api: "anthropic-messages" as const, base: "https://api.acme.example" }]]);
  const acme = profile({ provider: "acme", model: "acme-large", baseURL: "", apiKey: "acme-key" });
  expect(usableProfile(acme, kinds)).toBe(true);
  expect(modelsFile([acme], kinds).providers["tomrade-p1"]).toEqual({
    baseUrl: "https://api.acme.example",
    api: "anthropic-messages",
    apiKey: "$TOMRADE_KEY_P1",
    models: [{ id: "acme-large", name: "acme-large", input: ["text"] }]
  });
  // Its API is its own: Tomrade's adapters reach it, pi must not guess an address for its key.
  expect(usableProfile(acme)).toBe(false);
  expect(modelsFile([acme]).providers).toEqual({});
});

/** A provider a plugin registered: one whose endpoint answers, and one that refuses the key. */
function register(ctx: Awaited<ReturnType<typeof boot>>["ctx"], id: string, baseURL: string, answer: "ok" | "refuse") {
  ctx.llm.registerProvider({
    id, title: { en: id, zh: id }, keyRequired: true, baseURL: { default: baseURL, editable: true }, chat: true,
    wire: "openai-completions", presets: [], list: async () => ({ ok: true, models: [], capabilities: {} }),
    usable: (listed) => listed, defaultInput: [], capabilities: () => undefined,
    build: () => ({
      capabilities: { tools: true, streaming: true, json: false },
      async *chat() {
        if (answer === "refuse") throw new Error("401 invalid api key");
        yield { type: "text", delta: "OK" } as const;
        yield { type: "stop", reason: "end" } as const;
      }
    })
  });
}

it("runs on a provider plugin's profile once its model passed the test, and says why when it did not", async () => {
  const stub = await endpoint();
  try {
    const { ctx, engine, useModel } = await boot(fs.existsSync(bundled) ? bundled : process.execPath);
    register(ctx, "acme", stub.baseURL, "ok");
    register(ctx, "bad", stub.baseURL, "refuse");
    const test = async (provider: string) => {
      useModel({ provider, baseURL: stub.baseURL, apiKey: "acme-key", model: "acme-large" });
      return ctx.llm.test(ctx.settings.get().models.profiles[0]);
    };

    useModel({ provider: "acme", baseURL: stub.baseURL, apiKey: "acme-key", model: "acme-large" });
    expect(await engine()).toMatchObject({ ok: false, need: "model", reason: expect.stringContaining("Test the model") });
    expect(await test("acme")).toEqual({ ok: true });
    expect(await engine()).toMatchObject({ ok: true });

    // A tested failure is the reason, in the provider's own words.
    await test("bad");
    expect(await engine()).toMatchObject({ ok: false, need: "model", reason: expect.stringContaining("invalid api key") });
  } finally { stub.close(); }
});

async function boot(cli: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pi-builtin-"));
  const booted = await fresh({ plugins: [Tools, [Settings, { path: path.join(home, "settings.json") }], Llm, Agent, [Mcp, { port: 0 }], [builtinPi, { cli, home: path.join(home, "pi") }]] });
  await settle();
  const engine = () => booted.ctx.agent.engineViews(true).then((views) => views.find((v) => v.id === "pi-builtin")!);
  const useModel = (patch: Partial<ModelProfile>) => booted.ctx.settings.set({ ...booted.ctx.settings.get(), models: { profiles: [profile(patch)], roles: { worker: "" } } });
  return { ...booted, home, engine, useModel };
}

it("asks for nothing but a model", async () => {
  const missing = await boot("/nowhere/cli.js");
  expect(await missing.engine()).toMatchObject({ ok: false, need: "install" });
  const bundled = path.resolve("apps/desktop/vendor/pi/dist/bundle/cli.js");
  const { engine, useModel } = await boot(fs.existsSync(bundled) ? bundled : process.execPath);
  expect(await engine()).toMatchObject({ ok: false, need: "model", capabilities: ["backlog", "code", "general"] });
  useModel({ provider: "openai-images" });
  expect(await engine()).toMatchObject({ ok: false, need: "model" });
});

it("leaves a model that renders tools into the prompt to the loop, saying why", async () => {
  const { ctx, engine, useModel } = await boot(fs.existsSync(bundled) ? bundled : process.execPath);
  const stub = await endpoint();
  try {
    useModel({ promptTools: true, baseURL: stub.baseURL });
    expect(await engine()).toMatchObject({ ok: false, need: "model", reason: expect.stringContaining("cannot call tools") });
    ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [profile({ id: "local", title: "Local", promptTools: true, baseURL: stub.baseURL }), profile({ id: "cloud", baseURL: stub.baseURL })], roles: { worker: "" } } });
    const pi = ctx.agent.engineOf("pi-builtin")!;
    // Picked for a thread, it is refused rather than swapped for the model pi can run.
    expect(await pi.available({ options: { profile: "local" } })).toMatchObject({ ok: false, need: "model", reason: expect.stringContaining('"Local"') });
    expect(modelsFile(ctx.settings.get().models.profiles).providers).not.toHaveProperty("tomrade-local");
    if (fs.existsSync(bundled)) {
      // A profile counts once its own test answered, not because its address looks right.
      expect(await pi.available({ options: { profile: "cloud" } })).toMatchObject({ ok: false, need: "model", reason: expect.stringContaining("Test the model") });
      expect(await ctx.llm.test(ctx.settings.get().models.profiles[1])).toEqual({ ok: true });
      expect(await pi.available({ options: { profile: "cloud" } })).toMatchObject({ ok: true });
      expect(await pi.available()).toMatchObject({ ok: true });
    }
  } finally { stub.close(); }
});

it("leaves a model on a provider whose API pi does not speak to the loop, saying why", async () => {
  const { ctx, engine, useModel } = await boot(fs.existsSync(bundled) ? bundled : process.execPath);
  useModel({ provider: "acme", title: "Acme" });
  expect(await engine()).toMatchObject({ ok: false, need: "model", reason: expect.stringContaining("APIs the built-in agent does not") });
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [profile({ id: "acme", title: "Acme", provider: "acme" }), profile({ id: "cloud" })], roles: { worker: "" } } });
  const pi = ctx.agent.engineOf("pi-builtin")!;
  expect(await pi.available({ options: { profile: "acme" } })).toMatchObject({ ok: false, need: "model", reason: expect.stringContaining('"Acme"') });
});

const bundled = path.resolve("apps/desktop/vendor/pi/dist/bundle/cli.js");

/** The real bundled pi against a stand-in chat-completions endpoint: one Tomrade tool call, then an answer. */
describe.skipIf(!fs.existsSync(bundled))("bundled pi", () => {
  it("conducts a turn on a model profile, with the key only in its environment and none of the person's skills", async () => {
    const seen: { auth?: string; tools: string[]; prompt: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const request = JSON.parse(body) as { tools?: { function: { name: string } }[]; messages: { role: string }[] };
        const tools = (request.tools ?? []).map((t) => t.function.name);
        seen.push({ auth: req.headers.authorization, tools, prompt: JSON.stringify(request.messages) });
        const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const listItems = tools.find((name) => name.endsWith("list_items"));
        if (listItems && !request.messages.some((m) => m.role === "tool")) {
          res.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: listItems, arguments: "{}" } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
        } else {
          res.end(chunk({ role: "assistant", content: "There is 1 item." }) + chunk({}, "stop") + "data: [DONE]\n\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    // a skill of the person's own, where pi looks whatever its config folder
    const person = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pi-person-"));
    fs.mkdirSync(path.join(person, ".agents", "skills", "personal-skill"), { recursive: true });
    fs.writeFileSync(path.join(person, ".agents", "skills", "personal-skill", "SKILL.md"), "---\nname: personal-skill\ndescription: Something only this person uses.\n---\nDo it.\n");
    const realHome = process.env.HOME;
    process.env.HOME = person;
    try {
      const { ctx, items, project, board, home, engine, useModel } = await boot(bundled);
      useModel({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sk-secret", model: "fake-model" });
      expect(await ctx.llm.test(ctx.settings.get().models.profiles[0])).toEqual({ ok: true });
      seen.length = 0;
      expect(await engine()).toMatchObject({ ok: true });
      items.create({ projectId: project.id, boardId: board.id, title: "Ship the water reminder", by: "human" });

      const thread = ctx.agent.newThread(project.id, "pi-builtin");
      const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "How many items are there?" });
      const t0 = Date.now();
      while (ctx.agent.store.run(project.id, runId)?.status === "running") {
        if (Date.now() - t0 > 60_000) throw new Error("the run did not settle");
        await new Promise((r) => setTimeout(r, 100));
      }
      const run = ctx.agent.store.run(project.id, runId)!;
      const blocks = ctx.agent.store.messages(project.id, thread.id).map((m) => m.block);
      expect(run.status, run.error ?? "").toBe("done");
      expect(blocks.some((b) => b.type === "trace" && b.tool === "list_items" && b.ok)).toBe(true);
      expect(blocks.some((b) => b.type === "text" && b.text.includes("1 item"))).toBe(true);
      expect(seen[0].auth).toBe("Bearer sk-secret");
      expect(fs.readFileSync(path.join(home, "pi", "models.json"), "utf8")).not.toContain("sk-secret");
      expect(seen[0].prompt).not.toContain("personal-skill");
    } finally {
      process.env.HOME = realHome;
      fs.rmSync(person, { recursive: true, force: true });
      server.close();
    }
  }, 90_000);

  it("takes a message sent mid-turn into the same turn, before its next model request", async () => {
    const requests: { messages: { role: string; content: unknown }[] }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const request = JSON.parse(body) as { tools?: { function: { name: string } }[]; messages: { role: string; content: unknown }[] };
        requests.push(request);
        const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        const listItems = (request.tools ?? []).map((t) => t.function.name).find((name) => name.endsWith("list_items"));
        // the first reply takes a moment, so the message arrives while the turn runs
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          if (listItems && !request.messages.some((m) => m.role === "tool")) res.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: listItems, arguments: "{}" } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
          else res.end(chunk({ role: "assistant", content: "Blue it is." }) + chunk({}, "stop") + "data: [DONE]\n\n");
        }, requests.length === 1 ? 1500 : 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { ctx, items, project, board, useModel } = await boot(bundled);
      useModel({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sk-secret", model: "fake-model" });
      items.create({ projectId: project.id, boardId: board.id, title: "Ship the water reminder", by: "human" });
      const thread = ctx.agent.newThread(project.id, "pi-builtin");
      const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "Paint the items" });
      const t0 = Date.now();
      while (requests.length < 1) {
        if (Date.now() - t0 > 30_000) throw new Error("pi never asked the model");
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await ctx.agent.steer(project.id, thread.id, "s1", "make it blue")).toBe(true);
      while (ctx.agent.store.run(project.id, runId)?.status === "running") {
        if (Date.now() - t0 > 60_000) throw new Error("the run did not settle");
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(ctx.agent.store.run(project.id, runId)?.status).toBe("done");
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].messages.at(-1))).toContain("make it blue");
      const said = ctx.agent.store.messages(project.id, thread.id).map((m) => (m.block.type === "text" ? `${m.role}${m.block.steerId ? "(steer)" : ""}:${m.block.text}` : `${m.role}:${m.block.type}`));
      expect(said.slice(-3)).toEqual(["agent:trace", "user(steer):make it blue", "agent:Blue it is."]);
      expect(ctx.agent.store.runs(project.id, thread.id)).toHaveLength(1);
    } finally {
      server.close();
    }
  }, 90_000);
});
