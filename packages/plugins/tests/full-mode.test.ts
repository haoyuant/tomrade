/**
 * Full mode: an installed extension that is a plain cordis plugin, given the
 * app's whole Context, with rows of its own laid over the app's. What it
 * writes still carries its namespace; Tomrade keeps the rows it needs to
 * switch plugins off, remove and revoke them; and rows that leave a required
 * module empty are taken back.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "cordis";
import { afterAll, describe, expect, it } from "vitest";
import { Tools } from "@tomradex/tools";
import { fresh, settle } from "@tomradex/testkit";
import { LOCK_FILE, packPlugin } from "@tomradex/plugin-kit";
import { ExtensionStore, Plugins, type PluginRow } from "@tomradex/plugins";

const tmp = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const nativeImport = async (url: string) => {
  const u = new URL(url);
  const copy = path.join(tmp, "imports", `${u.searchParams.get("v")}-${path.basename(fileURLToPath(u))}`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(fileURLToPath(u), copy);
  return import(copy);
};

const rand = () => Math.random().toString(36).slice(2, 8);

/** A full-mode package: its main is whatever `body` exports. */
function full(name: string, opts: { tomrade?: string; rows?: unknown[]; body?: string } = {}) {
  const dir = path.join(tmp, "src", `${name}-${rand()}`);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  const manifest = { id: `someone/${name}`, version: "1.0.0", title: name, license: "MIT", engines: { sdk: "^0.2.0", tomrade: opts.tomrade ?? ">=0.12.0" }, context: "full", rows: opts.rows ?? [] };
  fs.writeFileSync(path.join(dir, "tomrade-plugin.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "dist/index.js"), opts.body ?? `export default { name: ${JSON.stringify(name)}, apply() {} };`);
  return dir;
}

const packed = async (dir: string) => (await packPlugin(dir, path.join(tmp, `${rand()}.tomrade-plugin`))).file;

const storeAt = (root: string, appVersion: string | null = null) =>
  new ExtensionStore({ root, lockFile: path.join(root, LOCK_FILE), trustedKeys: {}, importer: nativeImport, appVersion });

async function host(appVersion: string | null = null) {
  const w = await fresh({ plugins: [Tools] });
  const store = storeAt(fs.mkdtempSync(path.join(tmp, "root-")), appVersion);
  await w.ctx.plugin(Plugins, { rows: [], modules: [], extensions: store, resolve: async () => ({ apply() {} }) });
  await settle();
  const view = (id: string) => w.ctx.plugins.snapshot().plugins.find((p) => p.id === id)!;
  return { ...w, store, plugins: w.ctx.plugins, view };
}

/** Writes through the services it was handed, from its own context, a listener's, and a plugin it loads. */
const WRITER = `
const create = (ctx, title, by) => {
  const project = ctx.projects.list()[0];
  return ctx.items.create({ projectId: project.id, boardId: ctx.boards.defaultFor(project.id).id, title, by });
};
export default {
  name: "writer",
  inject: ["items", "projects", "boards"],
  apply(ctx) {
    // The app's own policy layer, which no SDK plugin reaches.
    ctx.on("write/pre-commit", (intent, next) => {
      if (intent.after && intent.after.title === "refused by the writer") throw new Error("the writer refuses this");
      return next();
    });
    ctx.on("writer/ping", () => void create(ctx, "from a listener", "ai:writer"));
    ctx.plugin({ name: "writer-child", inject: ["items", "projects", "boards"], apply(child) { globalThis.__writerChild = () => create(child, "from its child", "ai:writer"); } });
    globalThis.__writer = (title, by) => create(ctx, title, by);
  }
};`;

describe("a full-mode extension", () => {
  it("runs with the app's whole context, and what it writes — itself, from a listener, through a plugin it loaded — carries its namespace", async () => {
    const { ctx, plugins, view, oplog, project, items } = await host();
    await plugins.installFile(await packed(full("writer", { body: WRITER })));
    expect(view("someone/writer")).toMatchObject({ state: "active", extension: { full: { tomrade: ">=0.12.0", rows: [], restart: false }, risk: { level: "high", reasons: ["full"] } } });
    const g = globalThis as unknown as { __writer(title: string, by: string): { id: string }; __writerChild(): unknown };

    // It names its own author, as the app's own modules do.
    const mine = g.__writer("as a person", "human");
    expect(items.get(project.id, mine.id)!.updatedBy).toBe("human");
    ctx.emit("writer/ping" as never);
    g.__writerChild();
    expect(oplog.recent(project.id, 3).map((e) => e.via)).toEqual(["writer", "writer", "writer"]);
    expect(() => g.__writer("refused by the writer", "ai:writer")).toThrow(/refuses this/);

    // The app's own writes stay the app's.
    items.create({ projectId: project.id, boardId: ctx.boards.defaultFor(project.id).id, title: "by the app", by: "human" });
    expect(oplog.recent(project.id, 1)[0]!.via).toBeNull();
  });

  it("is refused outside the Tomrade versions it names, or when its main is not a cordis plugin; a checkout checks no range", async () => {
    const release = await host("0.12.4");
    await release.plugins.installFile(await packed(full("future", { tomrade: ">=0.13.0" })));
    expect(release.view("someone/future")).toMatchObject({ state: "failed", error: expect.stringContaining("works with Tomrade >=0.13.0; this is 0.12.4") });
    await release.plugins.installFile(await packed(full("number", { body: "export default 42;" })));
    expect(release.view("someone/number").error).toMatch(/exports a cordis plugin/);
    await release.plugins.installFile(await packed(full("sdk", { body: `export default { [Symbol.for("tomrade.sdk-plugin")]: 1, apply() {} };` })));
    expect(release.view("someone/sdk").error).toMatch(/drop "context": "full"/);

    const checkout = await host(null);
    await checkout.plugins.installFile(await packed(full("future", { tomrade: ">=0.13.0" })));
    expect(checkout.view("someone/future").state).toBe("active");
  });
});

describe("a full-mode extension's rows", () => {
  it("are laid over the app's in install order; Tomrade keeps its own rows, a new row carries the namespace, and a file stays in the package", async () => {
    const store = storeAt(fs.mkdtempSync(path.join(tmp, "root-")));
    const first = await store.installFile(
      await packed(
        full("first", {
          rows: [
            { id: "llm", name: "./dist/llm.js" },
            { id: "web-search-tavily", disabled: true },
            { id: "ipc", disabled: true },
            { id: "community", name: "./dist/catalog.js" },
            { id: "first-extra", name: "./dist/extra.js", config: { size: 2 } },
            { id: "stray", name: "./dist/extra.js" },
            { id: "first-out", name: "../elsewhere.js" }
          ]
        })
      )
    );
    await store.installFile(await packed(full("second", { rows: [{ id: "llm", config: { model: "local" } }] })));
    // Switched off, an extension lays no rows.
    await store.installFile(await packed(full("third", { rows: [{ id: "llm", disabled: true }] })));
    store.setDisabled("someone/third", true);

    const patches = store.patches(["llm", "web-search-tavily", "ipc", "community"]);
    expect(patches).toEqual([
      {
        from: "someone/first",
        rows: [
          { id: "llm", name: path.join(first.dir, "dist/llm.js"), from: "someone/first" },
          { id: "web-search-tavily", disabled: true },
          { id: "first-extra", name: path.join(first.dir, "dist/extra.js"), from: "someone/first", config: { size: 2 } }
        ]
      },
      // Configuring an app row leaves the plugin the app's own.
      { from: "someone/second", rows: [{ id: "llm", config: { model: "local" } }] }
    ]);

    const rows = Object.fromEntries(store.info("someone/first").full!.rows.map((r) => [r.id, r]));
    expect(rows.llm).toEqual({ id: "llm", change: "replaces", alsoBy: ["someone/second"] });
    expect(rows["web-search-tavily"]).toEqual({ id: "web-search-tavily", change: "switches-off", alsoBy: [] });
    expect(rows.ipc!.refused).toMatch(/Tomrade keeps “ipc” itself/);
    expect(rows.community!.refused).toMatch(/Tomrade keeps “community” itself/);
    expect(rows.stray!.refused).toMatch(/named “first”/);
    expect(rows["first-out"]!.refused).toMatch(/outside the package/);
    expect(store.info("someone/first").full!.restart).toBe(false);

    // A switch changes the rows the next start lays on.
    store.setDisabled("someone/second", true);
    expect(store.info("someone/second").full!.restart).toBe(true);
    expect(store.info("someone/first").full!.rows.find((r) => r.id === "llm")!.alsoBy).toEqual([]);
  });

  it("are refused at install when they switch off the only plugin a required module has", async () => {
    const root = fs.mkdtempSync(path.join(tmp, "root-"));
    const ctx = new Context();
    await ctx.plugin(Plugins, { rows: [{ id: "keeper", name: "keeper" }], modules: [{ id: "keep", title: "Keeping", required: true }], extensions: storeAt(root), resolve: async () => Keeper });
    await settle();
    const file = await packed(full("breaker", { rows: [{ id: "keeper", disabled: true }] }));
    await expect(ctx.plugins.installFile(file)).rejects.toThrow("someone/breaker switches off “keeper”, which would leave Keeping with no plugin");
    expect(ctx.plugins.extensions!.has("someone/breaker")).toBe(false);
  });

  it("are taken back at start when they leave a required module empty, and the extension is told which", async () => {
    const root = fs.mkdtempSync(path.join(tmp, "root-"));
    const store = storeAt(root);
    await store.installFile(await packed(full("breaker", { rows: [{ id: "keeper", name: "./dist/broken.js" }] })));
    await store.installFile(await packed(full("bystander", { rows: [{ id: "bystander-row", name: "./dist/row.js" }] })));
    const app: PluginRow[] = [{ id: "keeper", name: "keeper" }];
    const laid: Record<string, PluginRow> = { "someone/breaker": { id: "keeper", name: "broken", from: "someone/breaker" }, "someone/bystander": { id: "bystander-row", name: "quiet", from: "someone/bystander" } };
    const recompose = (without: ReadonlySet<string>) => {
      const rows = app.map((r) => ({ ...r }));
      for (const [from, row] of Object.entries(laid)) {
        if (without.has(from)) continue;
        const at = rows.findIndex((r) => r.id === row.id);
        if (at >= 0) rows[at] = { ...row };
        else rows.push({ ...row });
      }
      return rows;
    };
    const ctx = new Context();
    await ctx.plugin(Plugins, {
      rows: recompose(new Set()),
      modules: [{ id: "keep", title: "Keeping", required: true }],
      extensions: store,
      resolve: async (row) => (row.name === "keeper" ? Keeper : { name: row.name, apply() {} }),
      recompose,
      rowsFrom: ["someone/breaker", "someone/bystander"]
    });
    await settle();
    const snapshot = ctx.plugins.snapshot();
    expect(snapshot.modules.find((m) => m.id === "keep")!.providers).toEqual(["keeper"]);
    expect(snapshot.plugins.find((p) => p.id === "keeper")).toMatchObject({ name: "keeper", state: "active" });
    expect(snapshot.plugins.find((p) => p.id === "someone/breaker")!.rowsRefused).toEqual(["Keeping"]);
    // Not the cause: its rows stay.
    expect(snapshot.plugins.find((p) => p.id === "bystander-row")).toMatchObject({ name: "quiet", state: "active" });
    expect(snapshot.plugins.find((p) => p.id === "someone/bystander")!.rowsRefused).toBeUndefined();
  });
});

declare module "cordis" {
  interface Context {
    keep: Keeper;
  }
}

class Keeper extends Service {
  static provide = "keep";
  constructor(ctx: Context) {
    super(ctx, "keep");
  }
}
