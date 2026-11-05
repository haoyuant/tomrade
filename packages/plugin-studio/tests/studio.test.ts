import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "cordis";
import { afterAll, describe, expect, it } from "vitest";
import { Contributions } from "@tomradex/contributions";
import { Settings } from "@tomradex/settings";
import { Tools } from "@tomradex/tools";
import { fresh, settle } from "@tomradex/testkit";
import { LOCK_FILE } from "@tomradex/plugin-kit";
import { ExtensionStore, Plugins } from "@tomradex/plugins";
import studio from "@tomradex/plugin-studio";

// Inside the repository: vitest's module runner will not import from the system temp directory.
const tmp = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const importer = async (url: string) => {
  const u = new URL(url);
  const copy = path.join(tmp, "imports", `${u.searchParams.get("v")}-${path.basename(fileURLToPath(u))}`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(fileURLToPath(u), copy);
  return import(copy);
};

type Handler = (...args: never[]) => unknown;
class FakeIpc extends Service {
  static provide = "ipc";
  handlers = new Map<string, Handler>();
  sent: [string, unknown[]][] = [];
  constructor(ctx: Context) {
    super(ctx, "ipc");
  }
  handle(channel: string, handler: Handler) {
    return this.ctx.effect(() => {
      this.handlers.set(channel, handler);
      return () => this.handlers.delete(channel);
    });
  }
  send(channel: string, ...args: unknown[]) {
    this.sent.push([channel, args]);
  }
}

async function world() {
  const root = path.join(tmp, `root-${Math.random().toString(36).slice(2, 8)}`);
  const devRoot = path.join(tmp, `dev-${Math.random().toString(36).slice(2, 8)}`);
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], Contributions, FakeIpc] });
  const store = new ExtensionStore({ root, lockFile: path.join(root, LOCK_FILE), trustedKeys: {}, importer });
  await w.ctx.plugin(Plugins, { rows: [], modules: [], extensions: store, resolve: async () => ({ apply() {} }) });
  await w.ctx.plugin(studio as never, { devRoot });
  await settle();
  const ipc = w.ctx.get("ipc") as unknown as FakeIpc;
  const call = <T>(channel: string, ...args: unknown[]) => (ipc.handlers.get(channel) as (...a: unknown[]) => Promise<T> | T)(...args);
  const tool = (name: string, args: unknown) => w.ctx.tools.execute(name, args, { by: "ai:assistant", projectId: w.project.id });
  return { ...w, devRoot, store, ipc, call, tool };
}

const SOURCE = `import { z } from "zod";
import { definePlugin, defineTool } from "@tomradex/plugin-sdk";
export default definePlugin({
  inject: ["items", "tools", "db", "contributions"],
  async apply(ctx) {
    await ctx.db.migrate([{ version: 1, up: "CREATE TABLE IF NOT EXISTS plugin_notes_notes (item_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, note TEXT)" }],
      { tables: { plugin_notes_notes: { project: "project_id", export: false } } });
    await ctx.tools.register(defineTool({
      name: "notes_add", title: "Add a note", description: "Attach a note to an issue.",
      input: z.object({ itemId: z.string(), note: z.string() }),
      execute: async ({ itemId, note }, inv) => {
        await ctx.db.run(inv.projectId, "INSERT OR REPLACE INTO plugin_notes_notes (item_id, project_id, note) VALUES (?, ?, ?)", [itemId, inv.projectId, note]);
        return "ok";
      }
    }));
    await ctx.contributions.section({ id: "notes", title: "Note", render: async (item) => {
      const row = await ctx.db.get(item.projectId, "SELECT note FROM plugin_notes_notes WHERE item_id = ?", [item.id]);
      return row ? { rows: [{ label: "Note", value: String(row.note) }] } : null;
    } });
  }
});
`;

const SCENARIO = `export default async (t) => {
  const a = t.createItem("Needs context");
  t.check("adds", (await t.tool("notes_add", { itemId: a.id, note: "remember" })) === "ok");
  const sections = await t.sections(a.id);
  t.check("shows it", sections.some((s) => s.id === "notes"), JSON.stringify(sections));
};
`;

describe("Plugin Studio", () => {
  it("lets an agent write, test and hand over a plugin that loads only once a person confirms it", async () => {
    const { ctx, tool, call, ipc, items, project, board } = await world();
    const created = (await tool("plugin_create", { name: "notes", description: "Keeps one note per issue." })) as { namespace: string; id: string };
    expect(created).toMatchObject({ namespace: "notes", id: "local/notes" });
    await tool("plugin_write", { plugin: "notes", path: "src/index.ts", content: SOURCE });
    await tool("plugin_write", { plugin: "notes", path: "src/test.ts", content: SCENARIO });
    await expect(tool("plugin_write", { plugin: "notes", path: "../escape.ts", content: "x" })).rejects.toThrow(/outside the workspace/);
    await expect(tool("plugin_write", { plugin: "notes", path: "package.json", content: "{}" })).rejects.toThrow(/not a file the agent writes/);

    expect(((await tool("plugin_build", { plugin: "notes" })) as { ok: boolean }).ok).toBe(true);
    const tested = (await tool("plugin_test", { plugin: "notes" })) as { ok: boolean; checks: { name: string; ok: boolean }[] };
    expect(tested.checks.filter((c) => !c.ok)).toEqual([]);
    expect(tested.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["adds", "shows it"]));

    const tried = (await tool("plugin_try", { plugin: "notes" })) as { waiting: boolean; digest: string };
    expect(tried.waiting).toBe(true);
    expect(ipc.sent.some(([channel]) => channel === "studio.pending")).toBe(true);
    expect(ctx.tools.has("notes_add")).toBe(false);
    expect(((await tool("plugin_status", { plugin: "notes" })) as { state: string }).state).toBe("waiting for the person to confirm");

    const review = await call<{ digest: string; inject: string[]; risk: { reasons: string[] }; previous: unknown }>("studio.review", "notes");
    expect(review).toMatchObject({ inject: ["items", "tools", "db", "contributions"], previous: null, risk: { reasons: ["db"] } });
    await call("studio.confirm", "notes", review.digest);
    expect(((await tool("plugin_status", { plugin: "notes" })) as { state: string }).state).toBe("active");

    const item = items.create({ projectId: project.id, boardId: board.id, title: "Real issue", by: "human" });
    expect(await tool("notes_add", { itemId: item.id, note: "first" })).toBe("ok");

    // The agent changes the code: the running build stays until a person confirms the new one.
    await tool("plugin_write", { plugin: "notes", path: "src/index.ts", content: SOURCE.replace('title: "Note"', 'title: "Notes"') });
    await tool("plugin_try", { plugin: "notes" });
    expect(ctx.tools.has("notes_add")).toBe(false);
    const again = await call<{ digest: string; previous: { version: string } | null; diff: { added: number; removed: number } | null }>("studio.review", "notes");
    expect(again.previous?.version).toBe("0.1.0");
    expect(again.diff).toEqual({ added: 1, removed: 1 });
    const confirmed = await call<{ snapshot: string | null }>("studio.confirm", "notes", again.digest);
    expect(confirmed.snapshot).toMatch(/snapshots[\\/]\d+\.json$/);
    expect(ctx.tools.has("notes_add")).toBe(true);

    await tool("notes_add", { itemId: item.id, note: "second" });
    expect((await call<{ rows: number }>("studio.restore", "notes", confirmed.snapshot)).rows).toBe(1);
    expect((await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "notes")?.rows[0]?.value).toBe("first");
  }, 90_000);
});
