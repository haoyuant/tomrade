import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "cordis";
import { afterAll, describe, expect, it } from "vitest";
import { Items } from "@tomradex/items";
import { Tools } from "@tomradex/tools";
import { fresh, settle } from "@tomradex/testkit";
import { ATTESTATION_FILE, LOCK_FILE, attest, generateSigningKey, packPlugin, packageDigest } from "@tomradex/plugin-kit";
import { ExtensionStore, Plugins } from "@tomradex/plugins";

// Inside the repository: vitest's module runner will not import from the system temp directory.
const tmp = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const key = generateSigningKey();
/** The app imports `main?v=<digest>`; vitest's runner does not honour the query, so each build gets its own file. */
const nativeImport = async (url: string) => {
  const u = new URL(url);
  const copy = path.join(tmp, "imports", `${u.searchParams.get("v")}-${path.basename(fileURLToPath(u))}`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(fileURLToPath(u), copy);
  return import(copy);
};

/** An extension that needs nothing bundled: the SDK marker is a registered symbol. */
function source(name: string, opts: { version?: string; tool?: string; engines?: string; namespace?: string; plain?: boolean } = {}) {
  const dir = path.join(tmp, "src", `${name}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  const manifest = { id: `someone/${name}`, version: opts.version ?? "1.0.0", title: name, license: "MIT", engines: { sdk: opts.engines ?? "^0.2.0" }, inject: ["tools"], ...(opts.namespace ? { namespace: opts.namespace } : {}) };
  fs.writeFileSync(path.join(dir, "tomrade-plugin.json"), JSON.stringify(manifest));
  const tool = opts.tool ?? `${(opts.namespace ?? name).replace(/-/g, "_")}_hello`;
  const body = opts.plain
    ? `export default { name: "plain", apply() {} };`
    : `export default { [Symbol.for("tomrade.sdk-plugin")]: 1, inject: ["tools"], async apply(ctx) {
         await ctx.tools.register({ name: ${JSON.stringify(tool)}, title: "Hello", description: "says hello", input: { safeParse: (v) => ({ success: true, data: v }) }, execute: () => "hello from ${opts.version ?? "1.0.0"}" });
       } };`;
  fs.writeFileSync(path.join(dir, "dist/index.js"), body);
  return dir;
}

async function pack(name: string, opts: Parameters<typeof source>[1] & { signed?: boolean } = {}) {
  const dir = source(name, opts);
  if (opts.signed) {
    const digest = packageDigest(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "tomrade-plugin.json"), "utf8")) as { id: string; version: string };
    fs.writeFileSync(path.join(dir, ATTESTATION_FILE), JSON.stringify(attest({ v: 1, id: manifest.id, version: manifest.version, digest, tier: "official", risk: "low", issuedAt: Date.now() }, key.privateKey)));
  }
  return packPlugin(dir, path.join(tmp, `${name}-${Math.random().toString(36).slice(2, 8)}.tomrade-plugin`));
}

const packed = async (name: string, opts: Parameters<typeof pack>[1] = {}) => (await pack(name, opts)).file;

async function host() {
  const root = fs.mkdtempSync(path.join(tmp, "root-"));
  const w = await fresh({ plugins: [Tools] });
  const store = new ExtensionStore({ root, lockFile: path.join(root, LOCK_FILE), trustedKeys: { [key.keyId]: key.publicKey }, importer: nativeImport });
  await w.ctx.plugin(Plugins, { rows: [], modules: [], extensions: store, resolve: async () => ({ apply() {} }) });
  await settle();
  const plugins = w.ctx.plugins;
  const view = (id: string) => plugins.snapshot().plugins.find((p) => p.id === id)!;
  return { ...w, root, store, plugins, view };
}

describe("installed extensions", () => {
  it("installs a package without restarting, and lists it with its trust", async () => {
    const { ctx, plugins, view } = await host();
    await plugins.installFile(await packed("greeter"));
    expect(view("someone/greeter")).toMatchObject({ state: "active", extension: { tier: "local", version: "1.0.0", namespace: "greeter" } });
    expect(await ctx.tools.execute("greeter_hello", {}, { by: "human" })).toBe("hello from 1.0.0");
  });

  it("installs from the store only the build it lists, and calls it official only when Tomrade signed these exact files", async () => {
    const { plugins, view } = await host();
    const community = await pack("community");
    await plugins.installFile(community.file, { source: "store", digest: community.digest });
    expect(view("someone/community").extension).toMatchObject({ tier: "community", source: "store" });
    const official = await pack("official", { signed: true });
    await plugins.installFile(official.file, { source: "store", digest: official.digest });
    expect(view("someone/official").extension).toMatchObject({ tier: "official", source: "store" });
    await expect(plugins.installFile(await packed("swapped"), { source: "store", digest: "0".repeat(64) })).rejects.toThrow(/not the build the store lists/);
  });

  it("marks an installed plugin whose files changed as the person's own copy", async () => {
    const { plugins, view } = await host();
    const edited = await pack("edited");
    await plugins.installFile(edited.file, { source: "store", digest: edited.digest });
    fs.appendFileSync(path.join(view("someone/edited").extension!.dir, "dist/index.js"), "\n// mine");
    await plugins.reload("someone/edited");
    expect(view("someone/edited")).toMatchObject({ state: "active", extension: { modified: true, tier: "local" } });
  });

  it("keeps the version before an update so it can go back", async () => {
    const { ctx, plugins, view } = await host();
    await plugins.installFile(await packed("versions", { version: "1.0.0" }));
    await plugins.installFile(await packed("versions", { version: "1.1.0" }));
    expect(view("someone/versions").extension).toMatchObject({ version: "1.1.0", previousVersion: "1.0.0" });
    expect(await ctx.tools.execute("versions_hello", {}, { by: "human" })).toBe("hello from 1.1.0");
    await plugins.rollback("someone/versions");
    expect(view("someone/versions").extension).toMatchObject({ version: "1.0.0", previousVersion: null });
    expect(await ctx.tools.execute("versions_hello", {}, { by: "human" })).toBe("hello from 1.0.0");
  });

  it("loads an agent's build only at a digest a person confirmed", async () => {
    const { ctx, plugins, view } = await host();
    const dir = source("studio");
    await plugins.addFolder(dir, "studio");
    const pending = view("someone/studio");
    expect(pending.state).toBe("disabled");
    expect(pending.extension?.pending?.digest).toBe(packageDigest(dir));
    expect(pending.extension?.tier).toBe("dev");

    await plugins.confirm("someone/studio", pending.extension!.pending!.digest);
    expect(view("someone/studio").state).toBe("active");
    expect(ctx.tools.has("studio_hello")).toBe(true);

    fs.appendFileSync(path.join(dir, "dist/index.js"), "\n// the agent changed it");
    await plugins.reload("someone/studio");
    expect(view("someone/studio").state).toBe("disabled");
    expect(ctx.tools.has("studio_hello")).toBe(false);
    await expect(plugins.confirm("someone/studio", "0".repeat(64))).rejects.toThrow(/changed again/);
  });

  it("refuses what may not run: a contract it does not meet, code that is not an SDK plugin, a namespace already taken", async () => {
    const { plugins, view } = await host();
    await plugins.installFile(await packed("future", { engines: "^9.0.0" }));
    expect(view("someone/future")).toMatchObject({ state: "failed", error: expect.stringMatching(/needs plugin SDK \^9\.0\.0/) });
    await plugins.installFile(await packed("plain", { plain: true }));
    expect(view("someone/plain")).toMatchObject({ state: "failed", error: expect.stringMatching(/definePlugin/) });
    await plugins.installFile(await packed("first", { namespace: "shared" }));
    await expect(plugins.installFile(await packed("second", { namespace: "shared" }))).rejects.toThrow(/namespace "shared"/);
  });

  it("uninstalls, taking the files and, when asked, the data", async () => {
    const { plugins, root, store } = await host();
    await plugins.installFile(await packed("gone"));
    const dir = store.entry("someone/gone").dir;
    fs.writeFileSync(path.join(root, "someone", "gone", "data", "notes.txt"), "keep?");
    await plugins.uninstall("someone/gone", { removeData: true });
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(root, "someone", "gone", "data"))).toBe(false);
    expect(plugins.snapshot().plugins.some((p) => p.id === "someone/gone")).toBe(false);
    expect(store.has("someone/gone")).toBe(false);
  });

  it("brings installed extensions back with the lock on the next boot", async () => {
    const first = await host();
    await first.plugins.installFile(await packed("again"));
    await first.plugins.setEnabled("someone/again", false);
    const ctx = new Context();
    await ctx.plugin(Items as never);
    const store = new ExtensionStore({ root: first.root, lockFile: path.join(first.root, LOCK_FILE), trustedKeys: {}, importer: nativeImport });
    expect(store.rows()).toEqual([{ id: "someone/again", name: "ext:someone/again", disabled: true }]);
  });
});
