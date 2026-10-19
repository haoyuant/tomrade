import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCK_FILE, packPlugin } from "@tomradex/plugin-kit";
import { ExtensionStore } from "@tomradex/plugins";
import { boot, ConfigUnreadable } from "../src/boot.js";

let dir: string;
const write = (name: string, body: string) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  return file;
};
const logged = () => {
  const logs = path.join(dir, "logs");
  return fs.existsSync(logs) ? fs.readdirSync(logs).map((name) => fs.readFileSync(path.join(logs, name), "utf8")).join("") : "";
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-boot-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a start whose files cannot be read", () => {
  it("names a broken patch file, and leaves the reason in the log", async () => {
    const configFile = write("tomrade.yml", "plugins: []\n");
    const patch = write("tomrade.patch.yml", "plugins:\n  - id: a\n    disabled: [true\n");
    const error = await boot({ configFile, patchFiles: [patch], vars: { userData: dir } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigUnreadable);
    expect((error as Error).message).toContain(patch);
    await vi.waitFor(() => expect(logged()).toContain(patch));
  });

  it("names a corrupt extension lock", async () => {
    const configFile = write("tomrade.yml", "plugins: []\n");
    const root = path.join(dir, "plugins");
    const lock = write(path.join("plugins", LOCK_FILE), "{ not json");
    const error = await boot({ configFile, vars: { userData: dir }, extensions: { root, trustedKeys: {} } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigUnreadable);
    expect((error as Error).message).toContain(lock);
  });
});

describe("a full-mode extension's rows", () => {
  /** Installs a full-mode package with these rows into a plugins folder under the test's directory. */
  async function install(name: string, rows: unknown[]) {
    const src = path.join(dir, "src", name);
    write(path.join("src", name, "tomrade-plugin.json"), JSON.stringify({ id: `someone/${name}`, version: "1.0.0", title: name, license: "MIT", engines: { sdk: "^0.2.0", tomrade: ">=0.1.0" }, context: "full", rows }));
    write(path.join("src", name, "dist/index.js"), "export default { apply() {} };");
    const { file } = await packPlugin(src, path.join(dir, `${name}.tomrade-plugin`));
    const root = path.join(dir, "plugins");
    await new ExtensionStore({ root, lockFile: path.join(root, LOCK_FILE), trustedKeys: {}, importer: (url) => import(url) }).installFile(file);
    return root;
  }

  it("are laid on after the app's rows and before the person's patch file, which has the last word", async () => {
    const configFile = write("tomrade.yml", "plugins:\n  - id: model\n    name: ./model.js\n    config:\n      from: app\n  - id: search\n    name: ./search.js\n");
    write("model.js", "export default { apply() {} };");
    write("search.js", "export default { apply() {} };");
    const root = await install("deep", [{ id: "model", config: { from: "deep", where: "${userData}" } }, { id: "search", disabled: true }, { id: "deep-extra", name: "./dist/index.js" }]);
    const patch = write("tomrade.patch.yml", "plugins:\n  - id: model\n    config:\n      from: person\n");
    const { rows, ctx } = await boot({ configFile, patchFiles: [patch], vars: { userData: dir }, extensions: { root, trustedKeys: {} } });
    try {
      expect(rows.find((r) => r.id === "model")!.config).toEqual({ from: "person" });
      expect(rows.find((r) => r.id === "search")!.disabled).toBe(true);
      expect(rows.find((r) => r.id === "deep-extra")).toMatchObject({ name: expect.stringMatching(/dist[\\/]index\.js$/), from: "someone/deep" });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("are left out, with the reason in the log, when they name a variable this start does not have", async () => {
    const configFile = write("tomrade.yml", "plugins:\n  - id: model\n    name: ./model.js\n");
    write("model.js", "export default { apply() {} };");
    const root = await install("odd", [{ id: "model", config: { where: "${nowhere}" } }]);
    const { rows, ctx } = await boot({ configFile, vars: { userData: dir }, extensions: { root, trustedKeys: {} } });
    try {
      expect(rows.find((r) => r.id === "model")!.config).toBeUndefined();
      await vi.waitFor(() => expect(logged()).toContain("someone/odd: its rows were not applied"));
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
