import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LOCK_FILE } from "@tomradex/plugin-kit";
import { beginStart, hasOwnPlugins, requestSafeStart, startFinished, takeSafeRequest } from "../src/safe-start.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-safe-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

it("notices a start that never got as far as its window", () => {
  const marker = path.join(dir, "starting");
  expect(beginStart(marker)).toBe(false);
  startFinished(marker);
  expect(beginStart(marker)).toBe(false);
  // This one stopped before the window loaded.
  expect(beginStart(marker)).toBe(true);
});

it("holds a requested safe start for one start only", () => {
  const request = path.join(dir, "start-safe");
  expect(takeSafeRequest(request)).toBe(false);
  requestSafeStart(request);
  expect(takeSafeRequest(request)).toBe(true);
  expect(takeSafeRequest(request)).toBe(false);
});

it("offers a safe start only when there is something of the person's to leave out", () => {
  const patch = path.join(dir, "tomrade.patch.yml");
  const plugins = path.join(dir, "plugins");
  expect(hasOwnPlugins(patch, plugins)).toBe(false);
  fs.mkdirSync(plugins);
  fs.writeFileSync(path.join(plugins, LOCK_FILE), JSON.stringify({ v: 1, plugins: [] }));
  expect(hasOwnPlugins(patch, plugins)).toBe(false);
  fs.writeFileSync(path.join(plugins, LOCK_FILE), JSON.stringify({ v: 1, plugins: [{ id: "someone/deep" }] }));
  expect(hasOwnPlugins(patch, plugins)).toBe(true);
  fs.rmSync(path.join(plugins, LOCK_FILE));
  fs.writeFileSync(patch, "plugins: []\n");
  expect(hasOwnPlugins(patch, plugins)).toBe(true);
});
