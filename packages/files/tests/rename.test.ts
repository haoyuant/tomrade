import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { renameWhenFree } from "../src/scopes.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-rename-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A store folder with a file in it held open, as a git command still running in it holds its files. */
function held(name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const fd = fs.openSync(path.join(dir, "index"), "w");
  return { dir, release: () => fs.closeSync(fd) };
}

it("moves a folder once whatever held it lets go, as Windows will not move it before", async () => {
  const store = held("store");
  setTimeout(store.release, 300);
  await renameWhenFree(store.dir, `${store.dir}-parked`);
  expect(fs.existsSync(`${store.dir}-parked`)).toBe(true);
  expect(fs.existsSync(store.dir)).toBe(false);
});

it.runIf(process.platform === "win32")("fails as the rename itself would once its patience runs out", async () => {
  const store = held("stuck");
  try {
    const started = Date.now();
    await expect(renameWhenFree(store.dir, `${store.dir}-parked`, 300)).rejects.toMatchObject({ code: expect.stringMatching(/^(EBUSY|EPERM|EACCES)$/) });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  } finally {
    store.release();
  }
});

it("fails at once for a reason waiting cannot cure", async () => {
  await expect(renameWhenFree(path.join(root, "missing"), path.join(root, "anywhere"))).rejects.toMatchObject({ code: "ENOENT" });
});
