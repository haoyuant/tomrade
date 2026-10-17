import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCK_FILE } from "@tomradex/plugin-kit";
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
