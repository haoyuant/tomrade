import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Context, Service } from "cordis";
import { z } from "zod";
import { Contributions } from "@tomradex/contributions";
import { Settings } from "@tomradex/settings";
import { Tools } from "@tomradex/tools";
import { definePlugin, type PluginContext } from "@tomradex/plugin-sdk";
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
