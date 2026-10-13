/**
 * The Start dialog remembers how it was left: the surface, the agent and the
 * knobs it last ran with rest in a machine-local file beside the settings file,
 * and are handed back to open the next dialog. Anything the person has since
 * removed is dropped field by field, so a stale memory falls back to defaults
 * instead of failing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StartDefaultsStore } from "@tomradex/code-link";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-defaults-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
const file = () => path.join(root, `code-link-${n++}.json`);

describe("remembering how Start was left", () => {
  it("hands back what the last start settled, across a restart of the store", () => {
    const where = file();
    expect(new StartDefaultsStore(where).read()).toBeNull();
    new StartDefaultsStore(where).write({ mode: "terminal", engine: "codex", options: { model: "gpt-5", effort: "high" }, playbook: "document.write" });
    // A new store over the same file is what a restart of the app reads.
    expect(new StartDefaultsStore(where).read()).toEqual({
      mode: "terminal",
      engine: "codex",
      options: { model: "gpt-5", effort: "high" },
      playbook: "document.write"
    });
    // A later start replaces it whole rather than merging with what is gone.
    new StartDefaultsStore(where).write({ mode: "run", engine: "claude-code", permissionMode: "acceptEdits" });
    expect(new StartDefaultsStore(where).read()).toEqual({ mode: "run", engine: "claude-code", permissionMode: "acceptEdits" });
  });

  it("keeps a headless run's permission mode and drops a terminal's, which has none", () => {
    const where = file();
    const store = new StartDefaultsStore(where);
    store.write({ mode: "run", engine: "claude-code", permissionMode: "bypassPermissions" });
    expect(store.read()?.permissionMode).toBe("bypassPermissions");
    store.write({ mode: "terminal", engine: "claude-code", permissionMode: "bypassPermissions" });
    expect(store.read()?.permissionMode).toBe("bypassPermissions");
  });

  it("falls back to defaults when the saved configuration no longer fits: no engine, no choices, unusable options", () => {
    const store = () => new StartDefaultsStore(file());
    // No file, a file that is not JSON, JSON that is not an object, and a file with nothing usable left.
    expect(store().read()).toBeNull();
    const broken = file();
    fs.writeFileSync(broken, "{ not json");
    expect(new StartDefaultsStore(broken).read()).toBeNull();
    const list = file();
    fs.writeFileSync(list, "[1,2,3]");
    expect(new StartDefaultsStore(list).read()).toBeNull();
    const empty = file();
    fs.writeFileSync(empty, JSON.stringify({ mode: "run", updatedAt: 1 }));
    expect(new StartDefaultsStore(empty).read()).toBeNull();
    // An option or an engine removed since is dropped; the rest of the memory stands.
    const partial = file();
    fs.writeFileSync(partial, JSON.stringify({ mode: "run", engine: 7, options: { model: "", effort: 3, profile: "work" }, permissionMode: 5, playbook: "", updatedAt: 1 }));
    expect(new StartDefaultsStore(partial).read()).toEqual({ mode: "run", options: { profile: "work" } });
    // A mode this version does not know is not a memory it can use.
    const unknown = file();
    fs.writeFileSync(unknown, JSON.stringify({ mode: "sideways", engine: "codex", updatedAt: 1 }));
    expect(new StartDefaultsStore(unknown).read()).toBeNull();
  });

  it("remembers nothing, and fails at nothing, without a file to write to", () => {
    const store = new StartDefaultsStore(null);
    expect(() => store.write({ mode: "run", engine: "codex" })).not.toThrow();
    expect(store.read()).toBeNull();
    // A folder that does not exist yet is made for it.
    const nested = path.join(root, "nested", "deeper", "code-link.json");
    new StartDefaultsStore(nested).write({ mode: "run", engine: "codex" });
    expect(new StartDefaultsStore(nested).read()).toEqual({ mode: "run", engine: "codex" });
  });
});
