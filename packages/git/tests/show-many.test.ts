import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { GitFolder, gitRunner } from "../src/index.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-show-many-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@localhost", "-c", "user.name=T", ...args], { cwd, encoding: "utf8" });

it("reads files at a commit just as show reads each, in batches past 12 MB and with show wherever the batch cannot say", { timeout: 60_000 }, async () => {
  const dir = path.join(root, "repo");
  fs.mkdirSync(path.join(dir, ".tomrade", "state"), { recursive: true });
  const write = (rel: string, body: string | Buffer) => fs.writeFileSync(path.join(dir, rel), body);
  write(".tomrade/project.json", '{"project":{"id":"p"}}\n');
  write(".tomrade/state/items.jsonl", '{"id":"1","title":"中文 🐙 ü"}\n{"id":"2"}\n');
  write(".tomrade/state/empty.jsonl", "");
  write(".tomrade/state/with space.jsonl", '{"a":1}');
  write(".tomrade/state/not-utf8.jsonl", Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
  // Past one batch's 12 MB together, so they come in two.
  write(".tomrade/state/big-a.jsonl", `${"a".repeat(7 * 1024 * 1024)}\n`);
  write(".tomrade/state/big-b.jsonl", `${"中".repeat(2 * 1024 * 1024)}\n`);
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");

  const g = new GitFolder(gitRunner("git", dir), dir);
  const listed = await g.listAt("HEAD", ".tomrade");
  const rels = [...listed, ".tomrade/state/missing.jsonl", ".tomrade/state"];
  const many = await g.showMany("HEAD", rels);
  expect([...many.keys()].sort()).toEqual([...rels].sort());
  for (const rel of rels) expect(many.get(rel), rel).toEqual(await g.show("HEAD", rel));
  expect(many.get(".tomrade/state/missing.jsonl")).toBeNull();
  expect(many.get(".tomrade/state/items.jsonl")).toBe('{"id":"1","title":"中文 🐙 ü"}\n{"id":"2"}\n');
  // filesAt as it read before: the manifest and the tables, by their folder paths.
  const files = await g.filesAt("HEAD", ".tomrade");
  expect([...files.keys()].sort()).toEqual(listed.map((rel) => rel.split("/").join(path.sep)).sort());
  expect(await g.showMany("HEAD", [])).toEqual(new Map());

  // Without the bytes that are not UTF-8, every answer comes from the batches: the sizes once, then two reads.
  git(dir, "rm", "-q", ".tomrade/state/not-utf8.jsonl");
  git(dir, "commit", "-q", "-m", "two");
  const calls: string[] = [];
  const run = gitRunner("git", dir);
  const counted = new GitFolder((args, opts) => (calls.push(args[0]!), run(args, opts)), dir);
  const clean = [...(await g.listAt("HEAD", ".tomrade")), ".tomrade/state/missing.jsonl"];
  const read = await counted.showMany("HEAD", clean);
  expect(calls).toEqual(["cat-file", "cat-file", "cat-file"]);
  for (const rel of clean) expect(read.get(rel), rel).toEqual(await g.show("HEAD", rel));
});
