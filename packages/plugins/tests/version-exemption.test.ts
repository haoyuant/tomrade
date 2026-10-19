/**
 * A plugin outside the versions it names is refused until the person lets that
 * exact plugin version run on this exact version anyway; neither side's next
 * version inherits the grant, and a broken compatibility.json never stops a start.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { Tools } from "@tomradex/tools";
import { fresh, settle } from "@tomradex/testkit";
import { LOCK_FILE, packPlugin } from "@tomradex/plugin-kit";
import { SDK_CONTRACT } from "@tomradex/plugin-sdk";
import { COMPATIBILITY_FILE, ExtensionStore, Plugins } from "@tomradex/plugins";

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

/** A package for `engines`; full mode exports a cordis plugin, SDK mode a definePlugin one. */
async function packed(name: string, opts: { version?: string; sdk?: string; tomrade?: string }) {
  const dir = path.join(tmp, "src", `${name}-${rand()}`);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  const full = opts.tomrade !== undefined;
  const manifest = { id: `someone/${name}`, version: opts.version ?? "1.0.0", title: name, license: "MIT", engines: { sdk: opts.sdk ?? "^0.2.0", ...(full ? { tomrade: opts.tomrade } : {}) }, ...(full ? { context: "full" } : {}) };
  fs.writeFileSync(path.join(dir, "tomrade-plugin.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "dist/index.js"), full ? `export default { name: ${JSON.stringify(name)}, apply() {} };` : `export default { [Symbol.for("tomrade.sdk-plugin")]: 1, apply() {} };`);
  return (await packPlugin(dir, path.join(tmp, `${rand()}.tomrade-plugin`))).file;
}

async function host(appVersion: string, root = fs.mkdtempSync(path.join(tmp, "root-"))) {
  const w = await fresh({ plugins: [Tools] });
  const store = new ExtensionStore({ root, lockFile: path.join(root, LOCK_FILE), trustedKeys: {}, importer: nativeImport, appVersion });
  await w.ctx.plugin(Plugins, { rows: [], modules: [], extensions: store, resolve: async () => ({ apply() {} }) });
  await settle();
  const view = (id: string) => w.ctx.plugins.snapshot().plugins.find((p) => p.id === id)!;
  return { plugins: w.ctx.plugins, view, root, file: path.join(root, COMPATIBILITY_FILE) };
}

it("lets an out-of-range full-mode plugin run for that exact pair only, and takes it back", async () => {
  const first = await host("0.12.4");
  await first.plugins.installFile(await packed("future", { tomrade: ">=0.13.0" }));
  expect(first.view("someone/future")).toMatchObject({ state: "failed", error: expect.stringContaining("works with Tomrade >=0.13.0; this is 0.12.4") });
  expect(first.view("someone/future").extension!.outOfRange).toEqual([{ kind: "tomrade", range: ">=0.13.0", version: "0.12.4", granted: false }]);

  await first.plugins.allowVersion("someone/future");
  expect(first.view("someone/future")).toMatchObject({ state: "active", extension: { outOfRange: [{ kind: "tomrade", granted: true }] } });
  expect(JSON.parse(fs.readFileSync(first.file, "utf8"))).toEqual({ "someone/future@1.0.0": { tomrade: ["0.12.4"], sdk: [] } });

  // the next Tomrade asks again, as does the plugin's next version
  const upgraded = await host("0.12.5", first.root);
  expect(upgraded.view("someone/future").state).toBe("failed");
  await first.plugins.installFile(await packed("future", { version: "1.0.1", tomrade: ">=0.13.0" }));
  expect(first.view("someone/future")).toMatchObject({ state: "failed", extension: { version: "1.0.1", outOfRange: [{ granted: false }] } });
  await first.plugins.rollback("someone/future");
  expect(first.view("someone/future")).toMatchObject({ state: "active", extension: { version: "1.0.0" } });

  await first.plugins.withdrawVersion("someone/future");
  expect(first.view("someone/future")).toMatchObject({ state: "failed", extension: { outOfRange: [{ granted: false }] } });
  expect(JSON.parse(fs.readFileSync(first.file, "utf8"))).toEqual({});
  await expect(first.plugins.withdrawVersion("someone/missing")).rejects.toThrow();
});

it("lets an SDK plugin past its engines.sdk the same way", async () => {
  const { plugins, view, file } = await host("0.14.0");
  await plugins.installFile(await packed("later", { sdk: "^9.0.0" }));
  expect(view("someone/later")).toMatchObject({ state: "failed", error: expect.stringContaining("needs plugin SDK ^9.0.0") });
  await plugins.allowVersion("someone/later");
  expect(view("someone/later").state).toBe("active");
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ "someone/later@1.0.0": { tomrade: [], sdk: [SDK_CONTRACT] } });
  // in range already: nothing to let in
  await plugins.installFile(await packed("fine", {}));
  await expect(plugins.allowVersion("someone/fine")).rejects.toThrow(/already runs/);
});

it("starts with a broken compatibility.json, keeps the records it can read, says what it left out, and never overwrites it", async () => {
  const seed = await host("0.12.4");
  await seed.plugins.installFile(await packed("future", { tomrade: ">=0.13.0" }));
  await seed.plugins.installFile(await packed("other", { tomrade: ">=0.13.0" }));

  fs.writeFileSync(seed.file, "{ not json");
  const broken = await host("0.12.4", seed.root);
  expect(broken.view("someone/future").state).toBe("failed");
  expect(broken.plugins.snapshot().compatibilityProblems).toEqual([expect.stringContaining("is not JSON")]);
  await expect(broken.plugins.allowVersion("someone/future")).rejects.toThrow(/repair it by hand/);
  expect(fs.readFileSync(seed.file, "utf8")).toBe("{ not json");

  const partial = JSON.stringify({ "someone/future@1.0.0": { tomrade: ["0.12.4"] }, "someone/other@1.0.0": { tomrade: "0.12.4" } });
  fs.writeFileSync(seed.file, partial);
  const mixed = await host("0.12.4", seed.root);
  expect(mixed.view("someone/future").state).toBe("active");
  expect(mixed.view("someone/other").state).toBe("failed");
  expect(mixed.plugins.snapshot().compatibilityProblems).toEqual([expect.stringContaining('"someone/other@1.0.0" is not a grant')]);
  await expect(mixed.plugins.allowVersion("someone/other")).rejects.toThrow(/repair it by hand/);
  expect(fs.readFileSync(seed.file, "utf8")).toBe(partial);
});
