import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CODE_WORDS } from "../src/words.js";
import { ghRow, probeGh } from "@tomradex/code-link";
import { FakeGh } from "@tomradex/testkit";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-gh-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const gh = new FakeGh(path.join(root, "bin"));
const empty = path.join(root, "empty");
fs.mkdirSync(empty);
const w = CODE_WORDS("en");

// FakeGh is a shell script.
describe.skipIf(process.platform === "win32")("gh, as the troubleshooter and repository settings read it", () => {
  it("found and signed in: ok, with its path and version", async () => {
    gh.answer("auth status", { stdout: "github.com\n  ✓ Logged in to github.com account someone" });
    const status = await probeGh({ PATH: gh.dir });
    expect(status).toEqual({ state: "ready", path: path.join(gh.dir, "gh"), version: "2.0.0" });
    expect(ghRow(status, w)).toEqual({
      state: "ok",
      line: `gh 2.0.0 at ${path.join(gh.dir, "gh")}, signed in`,
      facts: { "gh.path": path.join(gh.dir, "gh"), "gh.version": "2.0.0", "gh.auth": "ok" }
    });
  });

  it("found but signed out: advisory, saying it is optional and how to sign in", async () => {
    gh.reset();
    const status = await probeGh({ PATH: gh.dir });
    expect(status).toMatchObject({ state: "signed-out", version: "2.0.0" });
    const row = ghRow(status, w);
    expect(row).toMatchObject({ state: "skip", facts: { "gh.auth": "signed-out", "gh.version": "2.0.0" } });
    expect(row.line).toContain("Optional");
    expect(row.line).toContain("gh auth login");
  });

  it("missing: advisory, with where to install it — never a warning or a failure", async () => {
    const status = await probeGh({ PATH: empty });
    expect(status).toEqual({ state: "missing" });
    const row = ghRow(status, w);
    expect(row).toMatchObject({ state: "skip", facts: { "gh.path": "none", "gh.auth": "missing" } });
    expect(row.line).toContain("https://cli.github.com");
    expect(row.line).toContain("Optional");
  });
});
