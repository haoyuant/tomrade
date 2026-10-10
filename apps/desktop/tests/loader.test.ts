import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatches, readConfig, readRows, writePatchRow } from "../src/loader.js";

let dir: string;
const file = (name: string) => path.join(dir, name);
const write = (name: string, body: string) => {
  fs.writeFileSync(file(name), body, "utf8");
  return file(name);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loader-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("reading a composition", () => {
  it("takes the rows and the modules from one file", () => {
    const config = readConfig(
      write(
        "tomrade.yml",
        `modules:
  - id: db
    title: Database
    required: true
  - id: llm
    title: Language model
plugins:
  - id: db
    name: "@tomradex/db"
`
      )
    );
    expect(config.modules).toEqual([
      { id: "db", title: "Database", required: true },
      { id: "llm", title: "Language model", required: false }
    ]);
    expect(config.rows).toEqual([{ id: "db", name: "@tomradex/db" }]);
  });

  it("a file with no modules block is a composition with nothing required", () => {
    expect(readConfig(write("tomrade.yml", "plugins:\n  - id: db\n    name: x\n")).modules).toEqual([]);
  });

  it("says which entry is wrong rather than booting half a list", () => {
    const bad = write("bad.yml", "modules:\n  - id: db\nplugins: []\n");
    expect(() => readConfig(bad)).toThrow(/modules\[0\] needs a string id and title/);
  });
});

describe("writing a switch back to the patch file", () => {
  it("creates the file when there is none", () => {
    writePatchRow(file("patch.yml"), "mcp", { disabled: true });
    expect(readRows(file("patch.yml"))).toEqual([{ id: "mcp", disabled: true }]);
  });

  it("updates the row it already has, and leaves the others alone", () => {
    const patch = write("patch.yml", "plugins:\n  - id: mcp\n    disabled: true\n  - id: llm\n    config:\n      model: local\n");
    writePatchRow(patch, "mcp", { disabled: false });
    expect(readRows(patch)).toEqual([
      { id: "mcp", disabled: false },
      { id: "llm", config: { model: "local" } }
    ]);
  });

  it("keeps the comments and the hand-written rows around it", () => {
    const patch = write(
      "patch.yml",
      `# my own overrides
plugins:
  # a plugin the app does not ship
  - id: mine
    name: /opt/mine/index.js
`
    );
    writePatchRow(patch, "mcp", { disabled: true });
    const body = fs.readFileSync(patch, "utf8");
    expect(body).toContain("# my own overrides");
    expect(body).toContain("# a plugin the app does not ship");
    expect(readRows(patch)).toEqual([{ id: "mine", name: "/opt/mine/index.js" }, { id: "mcp", disabled: true }]);
  });

  it("is what a later boot reads: the patch decides the row", () => {
    const base = readConfig(write("tomrade.yml", "plugins:\n  - id: mcp\n    name: \"@tomradex/mcp\"\n")).rows;
    const patch = file("patch.yml");
    writePatchRow(patch, "mcp", { disabled: true });
    expect(applyPatches(base, [readRows(patch)])).toEqual([{ id: "mcp", name: "@tomradex/mcp", disabled: true }]);
  });
});
