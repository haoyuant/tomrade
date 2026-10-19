import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Context, Service } from "cordis";
import { z } from "zod";
import { Contributions } from "@tomradex/contributions";
import { Settings } from "@tomradex/settings";
import { Tools } from "@tomradex/tools";
import { WebSearch } from "@tomradex/web-search";
import { Llm, collect, userMessage } from "@tomradex/llm";
import type {} from "@tomradex/desktop-surface";
import { definePlugin, type PendingWrite, type PluginContext } from "@tomradex/plugin-sdk";
import { windowTitle } from "@tomradex/extensions";
import { fresh, sdk, settle } from "@tomradex/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-ext-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const ext = (plugin: Parameters<typeof sdk>[0], namespace = "demo") => sdk(plugin, { id: `someone/${namespace}`, namespace, origin: "extension", root: dir, dataDir: dir });

async function world(plugin: Parameters<typeof sdk>[0]) {
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, `settings-${Math.random()}.json`) }], Contributions] });
  const fiber = w.ctx.plugin(ext(plugin));
  await fiber;
  await settle();
  return { ...w, fiber };
}

describe("the extension host", () => {
  it("passes a status item's command, countdown and look through, scoped to the namespace, and refreshes on demand", async () => {
    let refresh: () => Promise<void> = async () => {};
    const { ctx, fiber } = await world(definePlugin({
      inject: ["contributions"],
      async apply(p) {
        refresh = () => p.contributions.refresh();
        await p.contributions.statusItem({ id: "demo.timer", text: () => "Focus", icon: "i-clock", align: "end", title: "Timer", command: "demo.toggle", until: () => 1_000, menu: () => [{ title: "Skip", command: "demo.skip", icon: "i-redo" }] });
        await p.contributions.statusItem({ id: "demo.stray", text: () => "Stray", menu: () => [{ title: "Other", command: "other.skip" }] });
        await p.contributions.statusItem({ id: "demo.idle", text: () => "Idle", until: () => null });
        await p.contributions.statusItem({ id: "demo.broken", text: () => "Late", until: () => { throw new Error("boom"); } });
        await expect(p.contributions.statusItem({ id: "demo.foreign", text: () => "x", command: "other.toggle" })).rejects.toThrow();
      }
    }));
    expect(await ctx.contributions.statusItems({})).toEqual([
      { id: "demo.timer", text: "Focus", icon: "i-clock", align: "end", title: "Timer", command: "demo.toggle", until: 1_000, menu: [{ title: "Skip", command: "demo.skip", icon: "i-redo" }] },
      // a menu naming another plugin's command is dropped, the item stays
      { id: "demo.stray", text: "Stray" },
      { id: "demo.idle", text: "Idle" },
      { id: "demo.broken", text: "Late" }
    ]);
    await expect(refresh()).resolves.toBeUndefined();
    await fiber.dispose();
    expect(await ctx.contributions.statusItems({})).toEqual([]);
  });

  it("lets a plugin that did not ask for settings read the app's language, hear it change, and shows its titles in it", async () => {
    const seen: string[] = [];
    let changed = 0;
    const { ctx } = await world(definePlugin({
      inject: ["contributions"],
      async apply(p) {
        p.on("settings.changed", async () => { changed++; seen.push(await p.settings.locale()); });
        seen.push(await p.settings.locale());
        await p.contributions.command({ id: "demo.focus", title: { en: "Focus", zh: "专注", "pt-BR": "Foco" }, run: () => {} });
      }
    }));
    const title = () => ctx.contributions.commands().find((c) => c.id === "demo.focus")?.title;
    expect(seen).toEqual(["en"]);
    expect(title()).toBe("Focus");
    ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
    await settle();
    expect(changed).toBe(1);
    expect(seen.at(-1)).toBe("zh");
    expect(title()).toBe("专注");
    // The closest language the plugin has, as Tomrade picks its own; never the simplified script for Traditional Chinese.
    ctx.settings.set({ ...ctx.settings.get(), language: "zh-Hant" });
    await settle();
    expect(title()).toBe("Focus");
  });

  it("answers every call with a Promise and writes as the plugin, stamped with its namespace", async () => {
    let seen: PluginContext | null = null;
    const { oplog, project, board } = await world(
      definePlugin({
        inject: ["items"],
        async apply(ctx) {
          seen = ctx;
        }
      })
    );
    const ctx = seen as unknown as PluginContext;
    const pending = ctx.items.create({ projectId: project.id, boardId: board.id, title: "from the plugin" });
    expect(pending).toBeInstanceOf(Promise);
    const item = await pending;
    expect(item.updatedBy).toBe("ai:demo");
    expect(oplog.recent(project.id, 1)[0]).toMatchObject({ by: "ai:demo", via: "demo" });
    await expect(ctx.fields.list(project.id)).rejects.toThrow(/did not name "fields"/);
  });

  it("holds every id to the namespace", async () => {
    let seen: PluginContext | null = null;
    await world(definePlugin({ inject: ["tools", "contributions", "settings"], apply: (ctx) => void (seen = ctx) }));
    const ctx = seen as unknown as PluginContext;
    await expect(ctx.tools.register({ name: "list_items", title: "x", description: "x", input: z.object({}), execute: () => 1 })).rejects.toThrow(/must be named "demo"/);
    await expect(ctx.contributions.badge({ id: "other", compute: () => ({}) })).rejects.toThrow(/badge "other"/);
    await expect(ctx.settings.register({ id: "theme", title: "x", schema: z.object({}), defaults: {} })).rejects.toThrow(/settings section "theme"/);
    await expect(ctx.tools.register({ name: "demo_count", title: "Count", description: "x", input: z.object({}), execute: () => 1 })).resolves.toBeTypeOf("function");
  });

  it("puts a tool in a kit the plugin owns and says what the kit is for", async () => {
    let seen: PluginContext | null = null;
    const w = await world(definePlugin({ inject: ["tools"], apply: (ctx) => void (seen = ctx) }));
    const ctx = seen as unknown as PluginContext;
    await expect(ctx.tools.kit("routines", "x")).rejects.toThrow(/tool kit "routines"/);
    await expect(ctx.tools.register({ name: "demo_a", title: "x", description: "x", kit: "routines", input: z.object({}), execute: () => 1 })).rejects.toThrow(/tool kit "routines"/);
    const dropKit = await ctx.tools.kit("demo", "a demo timer");
    await ctx.tools.register({ name: "demo_timer", title: "Timer", description: "x", kit: "demo", input: z.object({}), execute: () => 1 });
    expect(w.ctx.tools.kits()).toMatchObject({ demo: "a demo timer" });
    expect(w.ctx.tools.describe().find((t) => t.name === "demo_timer")).toMatchObject({ kit: "demo" });
    await dropKit();
    expect(w.ctx.tools.kits()).not.toHaveProperty("demo");
  });

  it("lets a plugin refuse any write before it lands, whoever writes, until it unloads", async () => {
    const seen: PendingWrite[] = [];
    const { items, project, board, fiber } = await world(definePlugin({
      inject: ["items"],
      async apply(p) {
        await p.items.gate((write) => {
          seen.push(write);
          if ((write.patch as { title?: string } | null)?.title === "forbidden") throw new Error("demo: that title is not allowed");
          // The gate holds a copy: changing it changes nothing that lands.
          if (write.after) (write.after as { title: string }).title = "tampered";
        });
      }
    }));
    const item = items.create({ projectId: project.id, boardId: board.id, title: "kept", by: "human" });
    expect(items.get(project.id, item.id)!.title).toBe("kept");
    expect(() => items.update(project.id, item.id, { title: "forbidden" }, "human")).toThrow(/not allowed/);
    expect(items.get(project.id, item.id)!.title).toBe("kept");
    expect(seen.at(-1)).toMatchObject({ projectId: project.id, entity: "item", op: "update", id: item.id, by: "human", via: null, runId: null, patch: { title: "forbidden" } });
    await fiber.dispose();
    items.update(project.id, item.id, { title: "forbidden" }, "human");
    expect(items.get(project.id, item.id)!.title).toBe("forbidden");
  });

  it("does not wait for a write gate that answers with a Promise, and says so", async () => {
    const warnings: string[] = [];
    const { ctx, items, project, board } = await world(definePlugin({
      inject: ["items"],
      async apply(p) {
        await p.items.gate((async () => {
          throw new Error("too late");
        }) as never);
      }
    }));
    ctx.logger.exporter({ colors: 0, export: (m: { type: string; args: unknown[] }) => void (m.type === "warn" && warnings.push(String(m.args[0]))) } as never);
    const item = items.create({ projectId: project.id, boardId: board.id, title: "lands", by: "human" });
    await settle();
    expect(items.get(project.id, item.id)!.title).toBe("lands");
    expect(warnings.join("\n")).toMatch(/write gate answered with a Promise/);
  });

  it("lets a tool gate go on with other arguments, which the tool checks again, or answer in the tool's place", async () => {
    const { ctx, fiber } = await world(definePlugin({
      inject: ["tools"],
      async apply(p) {
        await p.tools.gate((call) => {
          if (call.name !== "demo_echo") return;
          const text = (call.args as { text: unknown }).text;
          // Changing the copy it is shown is not an answer.
          (call.args as { text: unknown }).text = "ignored";
          if (text === "cached") return { result: "from the gate" };
          if (text === "bad") return { args: { text: 7 } };
          return { args: { text: `${String(text)}!` } };
        });
      }
    }));
    let ran = 0;
    ctx.tools.register({ name: "demo_echo", title: "Echo", description: "x", input: z.object({ text: z.string() }), execute: ({ text }) => (ran++, text) });
    expect(await ctx.tools.execute("demo_echo", { text: "hi" }, { by: "ai:test" })).toBe("hi!");
    expect(await ctx.tools.execute("demo_echo", { text: "cached" }, { by: "ai:test" })).toBe("from the gate");
    await expect(ctx.tools.execute("demo_echo", { text: "bad" }, { by: "ai:test" })).rejects.toThrow(/demo_echo: invalid arguments/);
    expect(ran).toBe(1);
    await fiber.dispose();
    expect(await ctx.tools.execute("demo_echo", { text: "hi" }, { by: "ai:test" })).toBe("hi");
  });

  it("runs a palette command as the person who chose it, and a badge as the plugin", async () => {
    let authors: string[] = [];
    const { ctx, items, project, board } = await world(
      definePlugin({
        inject: ["items", "contributions"],
        async apply(p) {
          await p.contributions.command({
            id: "demo.touch",
            title: "Touch",
            run: async ({ projectId, itemId }) => {
              const updated = await p.items.update(projectId!, itemId!, { title: "touched" });
              authors.push(updated.updatedBy);
            }
          });
          await p.contributions.badge({
            id: "demo",
            compute: async (list) => {
              const made = await p.items.create({ projectId: list[0]!.projectId, boardId: list[0]!.boardId, title: "side effect" }).catch((e: Error) => e.message);
              authors.push(typeof made === "string" ? made : made.updatedBy);
              return {};
            }
          });
        }
      })
    );
    const item = items.create({ projectId: project.id, boardId: board.id, title: "t", by: "human" });
    await ctx.contributions.run("demo.touch", { projectId: project.id, itemId: item.id });
    await ctx.contributions.badgesFor(project.id);
    expect(authors).toEqual(["human", "ai:demo"]);
  });

  it("drops a render callback that stalls or throws, and keeps the rest of the refresh", async () => {
    const { ctx, project, items, board } = await world(
      definePlugin({
        inject: ["contributions"],
        async apply(p) {
          await p.contributions.statusItem({ id: "demo.slow", text: () => new Promise<string>(() => {}) });
          await p.contributions.statusItem({ id: "demo.broken", text: () => { throw new Error("boom"); } });
          await p.contributions.statusItem({ id: "demo.ok", text: () => "fine" });
        }
      })
    );
    items.create({ projectId: project.id, boardId: board.id, title: "t", by: "human" });
    const started = Date.now();
    expect(await ctx.contributions.statusItems({ projectId: project.id })).toEqual([{ id: "demo.ok", text: "fine" }]);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);

  it("lets a plugin answer the agent's web search, as the app's own providers do, until it unloads", async () => {
    let key = "";
    const asked: unknown[] = [];
    const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "web-search.json") }], WebSearch] });
    const fiber = w.ctx.plugin(
      ext(
        definePlugin({
          inject: ["webSearch"],
          async apply(p) {
            await expect(p.webSearch.register({ id: "other", title: "x", unavailable: () => null, search: () => ({ results: [] }) })).rejects.toThrow(/must be named "demo"/);
            await p.webSearch.register({
              id: "demo",
              title: "Demo search",
              settings: "demo",
              unavailable: () => (key ? null : "Demo search has no key — add one in Settings → Demo"),
              search: async (request) => {
                asked.push(request);
                return { results: [{ title: "Found", url: "https://example.com/a", content: "An excerpt." }] };
              },
              read: ({ urls }) => ({ pages: urls.map((url) => ({ url, content: `# ${url}` })), failed: [] })
            });
          }
        })
      )
    );
    await fiber;
    await settle();
    expect(w.ctx.webSearch.unavailable()).toEqual({ reason: "Demo search has no key — add one in Settings → Demo", settings: "demo" });
    key = "k";
    expect(w.ctx.webSearch.unavailable()).toBeNull();
    expect(await w.ctx.tools.execute("web_search", { query: "tomrade" }, { by: "human" })).toBe("1. Found\nhttps://example.com/a\nAn excerpt.");
    expect(asked).toEqual([{ query: "tomrade", maxResults: 5, topic: "general" }]);
    expect(await w.ctx.tools.execute("web_fetch", { urls: ["https://example.com/a"] }, { by: "human" })).toBe("# https://example.com/a\n\n# https://example.com/a");
    await fiber.dispose();
    await settle();
    expect(w.ctx.webSearch.providers()).toEqual([]);
    expect(w.ctx.tools.has("web_fetch")).toBe(false);
  });

  it("hands a plugin terminals of herdr panes through the app, and closes the ones it left open when it unloads", async () => {
    type Frame = { seq: number; width: number; height: number; full: boolean; bytes: Uint8Array };
    const streams: { paneId: string; opts: unknown; sent: unknown[]; closed: boolean; frame(f: Frame): void }[] = [];
    class FakeHerdr extends Service {
      static provide = "herdr";
      constructor(ctx: Context) {
        super(ctx, "herdr");
      }
      bridge = async () => ({ state: "ready" as const, version: "0.9.5" });
      terminal = async (paneId: string, opts: { mode?: string; cols: number; rows: number }) => {
        const frames = new Set<(f: Frame) => void>();
        const closes = new Set<(r: string | null) => void>();
        const entry = { paneId, opts, sent: [] as unknown[], closed: false, frame: (f: Frame) => frames.forEach((l) => l(f)) };
        streams.push(entry);
        return {
          paneId,
          mode: opts.mode ?? "control",
          closed: false,
          onFrame: (l: (f: Frame) => void) => (frames.add(l), () => frames.delete(l)),
          onClose: (l: (r: string | null) => void) => (closes.add(l), () => closes.delete(l)),
          input: (data: unknown) => entry.sent.push(["input", data]),
          resize: (cols: number, rows: number) => entry.sent.push(["resize", cols, rows]),
          scroll: (s: unknown) => entry.sent.push(["scroll", s]),
          mouse: (m: unknown) => entry.sent.push(["mouse", m]),
          close: () => {
            if (entry.closed) return;
            entry.closed = true;
            closes.forEach((l) => l(null));
          }
        };
      };
    }
    const heard: string[] = [];
    let state: unknown = null;
    const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "terminals.json") }], FakeHerdr] });
    const fiber = w.ctx.plugin(
      ext(
        definePlugin({
          inject: ["terminals"],
          async apply(p) {
            state = await p.terminals.state();
            const kept = await p.terminals.open("w1:p1", { cols: 100, rows: 30 });
            kept.onFrame((f) => void heard.push(Buffer.from(f.bytes).toString()));
            kept.input("ls\r");
            kept.resize(120, 40);
            const watched = await p.terminals.open("w1:p2", { mode: "observe", cols: 80, rows: 24 });
            watched.close();
          }
        })
      )
    );
    await fiber;
    await settle();
    expect(state).toEqual({ state: "ready", version: "0.9.5" });
    expect(streams.map((s) => [s.paneId, s.opts, s.closed])).toEqual([
      ["w1:p1", { mode: "control", cols: 100, rows: 30 }, false],
      ["w1:p2", { mode: "observe", cols: 80, rows: 24 }, true]
    ]);
    expect(streams[0]!.sent).toEqual([["input", "ls\r"], ["resize", 120, 40]]);
    streams[0]!.frame({ seq: 1, width: 100, height: 30, full: true, bytes: new Uint8Array(Buffer.from("hello")) });
    await settle();
    expect(heard).toEqual(["hello"]);
    await fiber.dispose();
    await settle();
    expect(streams[0]!.closed).toBe(true);
  });

  it("lets a plugin add a model provider: its presets show, its profiles list, build and answer through it, its sign-in ends in a key, until it unloads", async () => {
    const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "models.json") }], Llm] });
    const llm = w.ctx.llm as Llm;
    const asked: unknown[] = [];
    let opened = "";
    w.ctx.on("desktop/open-external", (url) => void (opened = url));
    const never = () => ({ ok: true as const, models: null });
    const fiber = w.ctx.plugin(
      ext(
        definePlugin({
          inject: ["models"],
          async apply(p) {
            await expect(p.models.registerProvider({ id: "other", title: "x", baseURL: { default: "" }, list: never, build: () => { throw new Error("no"); } })).rejects.toThrow(/must be named "demo"/);
            await expect(p.models.registerProvider({ id: "demo", title: "x", baseURL: { default: "" }, presets: [{ id: "elsewhere", title: "x" }], list: never, build: () => { throw new Error("no"); } })).rejects.toThrow(/must be named "demo"/);
            await p.models.registerProvider({
              id: "demo",
              title: { en: "Demo AI", zh: "演示 AI" },
              baseURL: { default: "https://api.demo.example/v1", editable: false },
              presets: [{ id: "demo", title: "Demo AI", keyShapes: [/^demo-/], prefer: [/^demo-large/], hint: { en: "Demo's own models", zh: "演示自家的模型" } }],
              list: (endpoint) => (endpoint.apiKey === "demo-key" ? { ok: true, models: ["demo-small", "demo-large-2", "demo-embed"] } : { ok: false, status: 401, detail: "401 invalid api key" }),
              usable: (listed) => listed.filter((m) => !m.includes("embed")),
              signIn: { title: "Sign in with Demo", run: async ({ open }) => { open("https://demo.example/auth"); return { apiKey: "demo-key" }; } },
              build: (profile) => ({
                capabilities: { tools: true, streaming: true, json: false },
                async *chat(request) {
                  asked.push({ model: profile.model, key: profile.apiKey, system: request.system });
                  yield { type: "text", delta: "Hello" };
                  yield { type: "usage", inputTokens: 3, outputTokens: 1 };
                  yield { type: "stop", reason: "end" };
                }
              })
            });
          }
        })
      )
    );
    await fiber;
    await settle();
    expect(llm.providers()).toContainEqual(expect.objectContaining({ id: "demo", title: "Demo AI", provider: "demo", hint: "Demo's own models" }));
    expect(llm.modelProviders()).toContainEqual({ id: "demo", title: "Demo AI", keyRequired: true, baseURL: { default: "https://api.demo.example/v1", editable: false }, chat: true, defaultInput: [], signIn: "Sign in with Demo" });
    expect(await llm.listing({ provider: "demo", apiKey: "demo-key" })).toEqual({ ok: true, models: ["demo-small", "demo-large-2"], capabilities: {} });
    expect(await llm.listing({ provider: "demo", apiKey: "nope" })).toMatchObject({ ok: false, kind: "auth" });

    expect(await llm.signIn("demo")).toEqual({ ok: true, apiKey: "demo-key" });
    expect(opened).toBe("https://demo.example/auth");
    expect(await llm.quickSetup({ preset: "demo", apiKey: "demo-key" })).toEqual({ ok: true, profile: { id: "demo", title: "Demo AI", model: "demo-large-2" } });
    expect(await collect(llm.for("worker").chat({ system: "Be brief.", messages: [userMessage("hi")] }))).toMatchObject({ text: "Hello", stop: "end", usage: { inputTokens: 3, outputTokens: 1 } });
    expect(asked.at(-1)).toEqual({ model: "demo-large-2", key: "demo-key", system: "Be brief." });

    await fiber.dispose();
    await settle();
    expect(llm.providers().some((p) => p.provider === "demo")).toBe(false);
    expect(() => llm.for("worker")).toThrow(/No model provider "demo" is installed/);
  });

  it("builds a plugin's models on the app's OpenAI-compatible adapter, with the vendor's own fields and its search on chat/completions", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "qwen-max", input_modalities: ["text", "image"] }, { id: "qwen-plus" }] }));
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      const chunks = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "add", arguments: '{"a":2,' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b":3}' } }] }, finish_reason: "tool_calls" }] }
      ];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    try {
      const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "compatible.json") }], Llm] });
      const llm = w.ctx.llm as Llm;
      let listed: unknown;
      await w.ctx.plugin(
        ext(
          definePlugin({
            inject: ["models"],
            async apply(p) {
              listed = await p.models.listCompatible({ baseURL: "https://dashscope.example/v1", apiKey: "sk-q" });
              await p.models.registerProvider({
                id: "demo",
                title: "Demo",
                baseURL: { default: "https://dashscope.example/v1" },
                list: (endpoint, signal) => p.models.listCompatible({ baseURL: endpoint.baseURL ?? "https://dashscope.example/v1", apiKey: endpoint.apiKey }, signal),
                build: (profile) =>
                  p.models.compatible({
                    baseURL: profile.baseURL ?? "https://dashscope.example/v1",
                    apiKey: profile.apiKey,
                    model: profile.model,
                    webSearch: "chat",
                    body: (json, request) => (request.webSearch ? { ...json, enable_search: true } : json)
                  })
              });
              await p.models.registerProvider({
                id: "demo-broken",
                title: "Broken",
                baseURL: { default: "https://dashscope.example/v1" },
                list: () => ({ ok: true, models: null }),
                build: (profile) => p.models.compatible({ baseURL: "https://dashscope.example/v1", apiKey: profile.apiKey, model: profile.model, body: () => { throw new Error("no shape"); } })
              });
            }
          })
        )
      );
      await settle();
      expect(listed).toEqual({ ok: true, models: ["qwen-max", "qwen-plus"], capabilities: { "qwen-max": { inputModalities: ["image"], outputModalities: [] } } });
      w.ctx.settings.set({ ...w.ctx.settings.get(), models: { profiles: [{ id: "q", title: "Qwen", provider: "demo", apiKey: "sk-q", model: "qwen-max" }], roles: { worker: "" } } });
      const model = llm.forProfile("q");
      expect(model.capabilities.nativeWebSearch).toBe(true);
      const tools = [{ name: "add", description: "Adds", inputSchema: { type: "object" } }];
      const step = await collect(model.chat({ system: "s", messages: [userMessage("search, then add")], tools, webSearch: true }));
      expect(step.toolCalls).toEqual([{ id: "c1", name: "add", args: { a: 2, b: 3 } }]);
      // on chat/completions, never the Responses API, with the vendor's flag beside the app's own fields
      expect(sent.map((s) => s.url)).toEqual(["https://dashscope.example/v1/chat/completions"]);
      expect(sent[0]!.body).toMatchObject({ model: "qwen-max", stream: true, enable_search: true, tools: [{ type: "function", function: { name: "add" } }] });
      await collect(model.chat({ system: "s", messages: [userMessage("no search")] }));
      expect(sent[1]!.body).not.toHaveProperty("enable_search");
      w.ctx.settings.set({ ...w.ctx.settings.get(), models: { profiles: [{ id: "b", title: "Broken", provider: "demo-broken", apiKey: "k", model: "m" }], roles: { worker: "" } } });
      await expect(collect(llm.forProfile("b").chat({ system: "s", messages: [userMessage("hi")] }))).rejects.toThrow(/someone\/demo could not shape the request: no shape/);
      expect(sent).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends a plugin's own headers in place of the bearer key, on chat/completions, the Responses API and the listing", async () => {
    const sent: { url: string; headers: Headers; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      sent.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }));
      if (url.endsWith("/responses")) return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "found" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      return new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    try {
      const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "compatible-headers.json") }], Llm] });
      const llm = w.ctx.llm as Llm;
      const asked: { url: string; body: string }[] = [];
      let listed: unknown;
      await w.ctx.plugin(
        ext(
          definePlugin({
            inject: ["models"],
            async apply(p) {
              listed = await p.models.listCompatible({ baseURL: "https://azure.example/openai/v1", apiKey: "", headers: { "api-key": "azure-key" } });
              await p.models.registerProvider({
                id: "demo",
                title: "Demo",
                baseURL: { default: "https://azure.example/openai/v1" },
                list: () => ({ ok: true, models: null }),
                build: (profile) =>
                  p.models.compatible({
                    baseURL: "https://azure.example/openai/v1",
                    apiKey: profile.apiKey,
                    model: profile.model,
                    webSearch: "responses",
                    headers: async (request) => (asked.push(request), { "api-key": profile.apiKey }),
                    responses: (json) => ({ ...json, max_output_tokens: 777 })
                  })
              });
              await p.models.registerProvider({
                id: "demo-unshaped",
                title: "Unshaped",
                baseURL: { default: "https://azure.example/openai/v1" },
                list: () => ({ ok: true, models: null }),
                build: (profile) => p.models.compatible({ baseURL: "https://azure.example/openai/v1", apiKey: profile.apiKey, model: profile.model, webSearch: "responses", responses: () => { throw new Error("no effort scale"); } })
              });
              await p.models.registerProvider({
                id: "demo-broken",
                title: "Broken",
                baseURL: { default: "https://azure.example/openai/v1" },
                list: () => ({ ok: true, models: null }),
                build: (profile) => p.models.compatible({ baseURL: "https://azure.example/openai/v1", apiKey: profile.apiKey, model: profile.model, headers: () => { throw new Error("signed out"); } })
              });
            }
          })
        )
      );
      await settle();
      expect(listed).toMatchObject({ ok: true, models: ["gpt-x"] });
      expect([sent[0]!.headers.get("api-key"), sent[0]!.headers.get("authorization")]).toEqual(["azure-key", null]);
      w.ctx.settings.set({ ...w.ctx.settings.get(), models: { profiles: [{ id: "a", title: "Azure", provider: "demo", apiKey: "azure-key", model: "gpt-x" }], roles: { worker: "" } } });
      const model = llm.forProfile("a");
      expect((await collect(model.chat({ system: "s", messages: [userMessage("hi")] }))).text).toBe("hi");
      expect((await collect(model.chat({ system: "s", messages: [userMessage("search")], webSearch: true }))).text).toBe("found");
      expect(asked.map((a) => a.url)).toEqual(["https://azure.example/openai/v1/chat/completions", "https://azure.example/openai/v1/responses"]);
      // what the plugin was handed is exactly what went out, so a signature over it holds
      expect(asked.map((a) => a.body)).toEqual([sent[1]!.body, sent[2]!.body]);
      expect(sent.slice(1).map((s) => [s.headers.get("api-key"), s.headers.get("authorization")])).toEqual([["azure-key", null], ["azure-key", null]]);
      // the plugin's last word on the Responses body, and none on chat/completions
      expect(JSON.parse(sent[2]!.body)).toMatchObject({ max_output_tokens: 777, tools: [{ type: "web_search" }] });
      expect(JSON.parse(sent[1]!.body)).not.toHaveProperty("max_output_tokens");
      w.ctx.settings.set({ ...w.ctx.settings.get(), models: { profiles: [{ id: "u", title: "Unshaped", provider: "demo-unshaped", apiKey: "k", model: "m" }], roles: { worker: "" } } });
      await expect(collect(llm.forProfile("u").chat({ system: "s", messages: [userMessage("search")], webSearch: true }))).rejects.toThrow(/someone\/demo could not shape the request: no effort scale/);
      w.ctx.settings.set({ ...w.ctx.settings.get(), models: { profiles: [{ id: "b", title: "Broken", provider: "demo-broken", apiKey: "k", model: "m" }], roles: { worker: "" } } });
      await expect(collect(llm.forProfile("b").chat({ system: "s", messages: [userMessage("hi")] }))).rejects.toThrow(/someone\/demo could not set the request headers: signed out/);
      expect(sent).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads a provider's unavailable() that throws as unavailable, with the reason", async () => {
    const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "web-search-throws.json") }], WebSearch] });
    await w.ctx.plugin(ext(definePlugin({ inject: ["webSearch"], apply: (p) => void p.webSearch.register({ id: "demo", title: "Demo", unavailable: () => { throw new Error("boom"); }, search: () => ({ results: [] }) }) })));
    await settle();
    expect(w.ctx.webSearch.unavailable()?.reason).toBe("Demo could not say whether it is set up: boom");
  });

  it("reaches an optional service only while it is there", async () => {
    const events: string[] = [];
    let seen: PluginContext | null = null;
    const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "optional.json") }]] });
    w.ctx.plugin(
      ext(
        definePlugin({
          optional: ["tools"],
          apply(p) {
            seen = p;
            p.when("tools", async (inner) => {
              events.push("tools arrived");
              await inner.tools.register({ name: "demo_ping", title: "Ping", description: "x", input: z.object({}), execute: () => "pong" });
              return () => events.push("tools gone");
            });
          }
        })
      )
    );
    await settle();
    expect((seen as unknown as PluginContext).has("tools")).toBe(false);
    const tools = w.ctx.plugin(Tools);
    await tools;
    await settle();
    await settle();
    expect(events).toEqual(["tools arrived"]);
    expect(await w.ctx.tools.execute("demo_ping", {}, { by: "human" })).toBe("pong");
    await tools.dispose();
    await settle();
    expect(events).toEqual(["tools arrived", "tools gone"]);
  });

  it("opens only documents inside the plugin's own package", async () => {
    fs.writeFileSync(path.join(dir, "face.html"), "<p>hi</p>");
    const opened: string[] = [];
    let seen: PluginContext | null = null;
    const w = await fresh({
      plugins: [
        class FakeSurfaces extends Service {
          static provide = "desktopSurfaces";
          constructor(ctx: Context) {
            super(ctx, "desktopSurfaces");
          }
          open(spec: { id: string; url: string }) {
            opened.push(spec.url);
            return { id: spec.id, capabilities: { programmaticPosition: true, forwardedMouseMoves: true }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, setState() {}, close() {} };
          }
        }
      ]
    });
    w.ctx.plugin(ext(definePlugin({ inject: ["surfaces"], apply: (p) => void (seen = p) })));
    await settle();
    const p = seen as unknown as PluginContext;
    await expect(p.surfaces.open({ id: "demo.face", title: "Face", document: "https://example.com", width: 1, height: 1 })).rejects.toThrow(/files inside the plugin/);
    await expect(p.surfaces.open({ id: "demo.face", title: "Face", document: "../../etc/passwd", width: 1, height: 1 })).rejects.toThrow(/outside the plugin/);
    const handle = await p.surfaces.open({ id: "demo.face", title: "Face", document: "face.html", width: 1, height: 1 });
    expect(handle.id).toBe("demo.face");
    expect(opened[0]).toMatch(/face\.html$/);
  });

  it("opens a working window only for a plugin whose manifest grants it, titled with the plugin's name, and posts to it", async () => {
    fs.writeFileSync(path.join(dir, "face.html"), "<p>hi</p>");
    const specs: { id: string; title: string; kind?: string; minWidth?: number; minHeight?: number }[] = [];
    const posted: unknown[] = [];
    class FakeSurfaces extends Service {
      static provide = "desktopSurfaces";
      constructor(ctx: Context) {
        super(ctx, "desktopSurfaces");
      }
      open(spec: { id: string; title: string; kind?: string }) {
        specs.push(spec);
        return { id: spec.id, capabilities: { programmaticPosition: true, forwardedMouseMoves: true }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, setState() {}, post: (m: unknown) => void posted.push(m), close() {} };
      }
    }
    const w = await fresh({ plugins: [FakeSurfaces] });
    const contexts: PluginContext[] = [];
    const grab = definePlugin({ inject: ["surfaces"], apply: (p) => void contexts.push(p) });
    w.ctx.plugin(sdk(grab, { id: "someone/plain", namespace: "plain", origin: "extension", root: dir, dataDir: dir, title: "Plain" }));
    w.ctx.plugin(sdk(grab, { id: "someone/demo", namespace: "demo", origin: "extension", root: dir, dataDir: dir, title: "Demo Tools", window: true }));
    w.ctx.plugin(sdk(grab, { id: "pet", namespace: "pet", origin: "builtin", root: dir, dataDir: null }));
    await settle();
    const [plain, demo, builtin] = contexts as [PluginContext, PluginContext, PluginContext];
    await expect(plain.surfaces.open({ id: "plain.win", title: "Win", document: "face.html", width: 800, height: 600, kind: "window" })).rejects.toThrow(/does not grant permissions\.window/);
    // A widget needs nothing new, and keeps its own title.
    await plain.surfaces.open({ id: "plain.face", title: "Face", document: "face.html", width: 10, height: 10 });
    const win = await demo.surfaces.open({ id: "demo.sessions", title: "Code sessions", document: "face.html", width: 900, height: 600, kind: "window", minWidth: 480, minHeight: 320 });
    await win.post({ frame: 1 });
    await win.post({ frame: 2 });
    await builtin.surfaces.open({ id: "pet.window", title: "Pet", document: "face.html", width: 300, height: 300, kind: "window" });
    expect(specs.map((spec) => [spec.id, spec.title, spec.kind, spec.minWidth, spec.minHeight])).toEqual([
      ["plain.face", "Face", undefined, undefined, undefined],
      ["demo.sessions", "Code sessions — Demo Tools", "window", 480, 320],
      ["pet.window", "Pet", "window", undefined, undefined]
    ]);
    expect(posted).toEqual([{ frame: 1 }, { frame: 2 }]);
    expect(windowTitle("Demo Tools", "Demo Tools")).toBe("Demo Tools");
  });

  it("tells the plugin once when its window is gone, and refuses calls on it after", async () => {
    fs.writeFileSync(path.join(dir, "face.html"), "<p>hi</p>");
    const hostSide: { onClose?: () => void }[] = [];
    let seen: PluginContext | null = null;
    const w = await fresh({
      plugins: [
        class FakeSurfaces extends Service {
          static provide = "desktopSurfaces";
          constructor(ctx: Context) {
            super(ctx, "desktopSurfaces");
          }
          open(spec: { id: string; onClose?: () => void }) {
            hostSide.push(spec);
            return { id: spec.id, capabilities: { programmaticPosition: true, forwardedMouseMoves: true }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, setState() {}, close: () => spec.onClose?.() };
          }
        }
      ]
    });
    w.ctx.plugin(ext(definePlugin({ inject: ["surfaces"], apply: (p) => void (seen = p) })));
    await settle();
    const p = seen as unknown as PluginContext;
    let closes = 0;
    const handle = await p.surfaces.open({ id: "demo.face", title: "Face", document: "face.html", width: 1, height: 1, onClose: () => void closes++ });
    await handle.setState({ a: 1 });
    // the person closes it; the host may say so more than once
    hostSide[0]!.onClose!();
    hostSide[0]!.onClose!();
    await settle();
    expect(closes).toBe(1);
    await expect(handle.setState({ a: 2 })).rejects.toThrow(/demo\.face is closed/);
    await expect(handle.setPosition(0, 0)).rejects.toThrow(/closed/);
    await expect(handle.close()).resolves.toBeUndefined();

    const second = await p.surfaces.open({ id: "demo.face2", title: "Face", document: "face.html", width: 1, height: 1, onClose: () => void closes++ });
    await second.close();
    await settle();
    expect(closes).toBe(2);
    await expect(second.setState({})).rejects.toThrow(/closed/);
  });
});
