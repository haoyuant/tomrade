import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { claudeRecord } from "@tomradex/engine-kit";
import { readSnapshot, saveSnapshot, snapshotFile } from "../src/snapshots.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-"));
const claude = claudeRecord({ variable: "CLAUDE_CONFIG_DIR", dir: ".claude" });
const said = (i: number, pad = 0) => `${JSON.stringify({ type: "user", message: { content: `第 ${i} 句${"字".repeat(pad)}` } })}\n`;

it("saves a conversation as its lines, reads it back a stretch at a time, and keeps one per conversation", async () => {
  const transcript = path.join(dir, "talk.jsonl");
  fs.writeFileSync(
    transcript,
    said(0) +
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } })}\n` +
      `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts" }] } })}\n`
  );
  const to = snapshotFile(dir, "claude-code", "talk-1")!;
  expect(await saveSnapshot(to, "claude-code", claude, transcript, 1000)).toEqual({ cut: false });
  expect(readSnapshot(to)).toMatchObject({ cut: false, start: 0, lines: [{ who: "person", text: "第 0 句" }, { who: "tool", text: "Bash · ls", detail: { input: "$ ls", output: "a.ts" } }] });
  // Taken up again and ended again: the same file, now with what came after.
  fs.appendFileSync(transcript, said(1));
  await saveSnapshot(to, "claude-code", claude, transcript, 2000);
  expect(readSnapshot(to)?.lines.at(-1)).toEqual({ who: "person", text: "第 1 句" });
  expect(fs.readdirSync(dir).filter((f) => f.startsWith("claude-code-talk-1"))).toEqual(["claude-code-talk-1.jsonl"]);

  expect(snapshotFile(dir, "claude-code", "../x")).toBeNull();
  expect(await saveSnapshot(path.join(dir, "none.jsonl"), "claude-code", claude, path.join(dir, "absent.jsonl"))).toBeNull();
  expect(fs.existsSync(path.join(dir, "none.jsonl"))).toBe(false);
  expect(readSnapshot(path.join(dir, "absent.jsonl"))).toBeNull();
});

it("keeps only the end of a conversation past its limit, read across the record's stretches, and says so", async () => {
  const transcript = path.join(dir, "long.jsonl");
  // About 5 MB: more than one stretch of the record.
  fs.writeFileSync(transcript, Array.from({ length: 2500 }, (_, i) => said(i, 700)).join(""));
  const to = snapshotFile(dir, "claude-code", "long-1")!;
  expect(await saveSnapshot(to, "claude-code", claude, transcript, 1, 1024 * 1024)).toEqual({ cut: true });
  const head = JSON.parse(fs.readFileSync(to, "utf8").split("\n")[0]!);
  expect(head).toEqual({ snapshot: 1, agent: "claude-code", at: 1, cut: true });
  const lines = readSnapshot(to)!.lines;
  expect(lines.at(-1)?.text.startsWith("第 2499 句")).toBe(true);
  expect(lines.length).toBeGreaterThan(100);
  expect(lines.length).toBeLessThan(2500);
  expect(fs.statSync(to).size).toBeLessThan(1024 * 1024 + 1024);
  // Under its limit, all of it, from both of the record's stretches.
  expect(await saveSnapshot(to, "claude-code", claude, transcript, 2)).toEqual({ cut: false });
  // The snapshot reads back a stretch at a time too, down to its first line.
  let read = readSnapshot(to)!;
  let count = read.lines.length;
  while (read.cut) {
    read = readSnapshot(to, read.start)!;
    count += read.lines.length;
  }
  expect(read.lines[0]?.text.startsWith("第 0 句")).toBe(true);
  expect(count).toBe(2500);
});
