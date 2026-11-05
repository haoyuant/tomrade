import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { GitFolder, gitRunner, type Git } from "../src/index.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-set-remote-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it("adds a missing remote, sets a different URL, and leaves one already right alone", async () => {
  const dir = path.join(root, "repo");
  execFileSync("git", ["init", "-q", dir]);
  const ran: string[][] = [];
  const real = gitRunner("git", dir);
  const counted: Git = (args, opts) => (ran.push(args), real(args, opts));
  const g = new GitFolder(counted, dir);
  const origin = () => execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8" }).trim();
  const verbs = () => ran.splice(0).map((args) => args.slice(0, 2).join(" "));

  await g.setRemote("https://example.com/a.git");
  expect(origin()).toBe("https://example.com/a.git");
  expect(verbs()).toEqual(["remote get-url", "remote add"]);

  await g.setRemote("https://example.com/b.git");
  expect(origin()).toBe("https://example.com/b.git");
  expect(verbs()).toEqual(["remote get-url", "remote set-url"]);

  const config = fs.statSync(path.join(dir, ".git", "config")).mtimeMs;
  await g.setRemote("https://example.com/b.git");
  expect(verbs()).toEqual(["remote get-url"]);
  expect(fs.statSync(path.join(dir, ".git", "config")).mtimeMs).toBe(config);
});
