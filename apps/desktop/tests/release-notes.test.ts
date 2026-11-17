import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
// @ts-expect-error a build script, with no types of its own
import { notesFileFor } from "../scripts/release-notes.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-release-notes-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

it("finds a version's notes, a prerelease's own before its base version's, and none that say nothing", () => {
  fs.writeFileSync(path.join(dir, "1.2.0.md"), "## en\n- Faster starts\n");
  fs.writeFileSync(path.join(dir, "1.3.0-beta.2.md"), "## en\n- Trying something\n");
  fs.writeFileSync(path.join(dir, "1.4.0.md"), "  \n");
  expect(notesFileFor("1.2.0", dir)).toBe(path.join(dir, "1.2.0.md"));
  expect(notesFileFor("1.2.0-beta.1", dir)).toBe(path.join(dir, "1.2.0.md"));
  expect(notesFileFor("1.3.0-beta.2", dir)).toBe(path.join(dir, "1.3.0-beta.2.md"));
  expect(notesFileFor("1.3.0", dir)).toBeNull();
  expect(notesFileFor("1.4.0", dir)).toBeNull();
  expect(notesFileFor("9.9.9", path.join(dir, "missing"))).toBeNull();
});
