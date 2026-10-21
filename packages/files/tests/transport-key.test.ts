/**
 * The Files transport is keyed by its remote. Remotes once carried the token in
 * their URL, so the key did too; what was kept under such a key must follow the
 * clean URL, or the first sync after the upgrade would start from nothing.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { gitRunner } from "@tomradex/git";
import { GitProjection } from "../src/git-sync.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-transport-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const key = (url: string, directory: string) => createHash("sha256").update(JSON.stringify([url, "main", directory])).digest("hex");

function legacy(local: string, url: string, directory: string): string {
  const old = key(url, directory);
  const transport = path.join(local, ".git", "files-sync", "transport", old);
  fs.mkdirSync(path.join(transport, ".git"), { recursive: true });
  fs.writeFileSync(path.join(transport, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  fs.mkdirSync(path.join(local, ".git", "files-sync", "targets"), { recursive: true });
  fs.writeFileSync(path.join(local, ".git", "files-sync", "targets", `${old}.json`), JSON.stringify({ v: 2, head: "abc" }));
  return old;
}

it("moves a transport and its sync state from a credentialed key to the clean one", () => {
  const local = path.join(root, "store-a");
  const clean = "https://github.com/me/files.git";
  const old = legacy(local, "https://x-access-token:ghp_old@github.com/me/files.git", "project-files");
  const projection = new GitProjection(gitRunner("git"), "git", local, { url: clean, branch: "main", directory: "project-files" });
  expect(projection.key).toBe(key(clean, "project-files"));
  expect(fs.existsSync(projection.dir)).toBe(true);
  expect(fs.existsSync(path.join(local, ".git", "files-sync", "transport", old))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(local, ".git", "files-sync", "targets", `${projection.key}.json`), "utf8"))).toEqual({ v: 2, head: "abc" });
});

it("leaves another remote's transport, and another folder of the same remote, where they are", () => {
  const local = path.join(root, "store-b");
  const other = legacy(local, "https://x-access-token:ghp_old@github.com/me/other.git", "project-files");
  const otherFolder = legacy(local, "https://x-access-token:ghp_old@github.com/me/files.git", "docs");
  const projection = new GitProjection(gitRunner("git"), "git", local, { url: "https://github.com/me/files.git", branch: "main", directory: "project-files" });
  expect(fs.existsSync(projection.dir)).toBe(false);
  for (const k of [other, otherFolder]) expect(fs.existsSync(path.join(local, ".git", "files-sync", "transport", k))).toBe(true);
});
