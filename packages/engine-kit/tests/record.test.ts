import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { claudeRecord, claudeTranscriptTitle, findClaudeTranscript, promptTitle } from "@tomradex/engine-kit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-"));
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const filler = (n: number) => line({ type: "user", message: { content: "x".repeat(n) } });
const claude = claudeRecord({ variable: "CLAUDE_CONFIG_DIR", dir: ".claude" });

it("reads a conversation's title from its transcript: the tail first, then the head, the person's own over the agent's", () => {
  const short = path.join(dir, "short.jsonl");
  fs.writeFileSync(short, line({ type: "ai-title", aiTitle: "初稿" }) + filler(10) + line({ type: "ai-title", aiTitle: "设计终端侧栏" }));
  expect(claudeTranscriptTitle(short)).toBe("设计终端侧栏");
  fs.appendFileSync(short, line({ type: "custom-title", customTitle: "我起的名字" }) + line({ type: "ai-title", aiTitle: "后来的" }));
  expect(claude.title?.(short)).toBe("我起的名字");
  // A long one with its only title near the start: found in the head.
  const long = path.join(dir, "long.jsonl");
  fs.writeFileSync(long, line({ type: "ai-title", aiTitle: "开头的标题" }) + filler(600 * 1024));
  expect(claudeTranscriptTitle(long)).toBe("开头的标题");
  fs.writeFileSync(path.join(dir, "none.jsonl"), filler(100));
  expect(claudeTranscriptTitle(path.join(dir, "none.jsonl"))).toBeNull();
  expect(claudeTranscriptTitle(path.join(dir, "missing.jsonl"))).toBeNull();
});

it("makes a title of a first prompt, and finds an older session's transcript by its id under the accounts' folders", () => {
  expect(promptTitle("  我们来聊聊\n侧栏的设计  ")).toBe("我们来聊聊 侧栏的设计");
  expect(promptTitle("a".repeat(100))).toHaveLength(60);
  expect(promptTitle("<command-name>/clear</command-name>")).toBeNull();
  expect(promptTitle(undefined)).toBeNull();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const where = path.join(home, ".claude-work", "projects", "-repo");
  fs.mkdirSync(where, { recursive: true });
  fs.writeFileSync(path.join(where, "abc-123.jsonl"), "");
  const folders = { variable: "CLAUDE_CONFIG_DIR", dir: ".claude" };
  expect(findClaudeTranscript("abc-123", folders, home, {})).toBe(path.join(where, "abc-123.jsonl"));
  // The variable's folder counts too.
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), "moved-"));
  fs.mkdirSync(path.join(moved, "projects", "-x"), { recursive: true });
  fs.writeFileSync(path.join(moved, "projects", "-x", "m-1.jsonl"), "");
  expect(findClaudeTranscript("m-1", folders, home, { CLAUDE_CONFIG_DIR: moved })).toBe(path.join(moved, "projects", "-x", "m-1.jsonl"));
  // CodeBuddy keeps its transcripts the same way under its own folder, and only its own folders are looked in.
  const codebuddy = path.join(home, ".codebuddy", "projects", "-repo");
  fs.mkdirSync(codebuddy, { recursive: true });
  fs.writeFileSync(path.join(codebuddy, "cb-1.jsonl"), "");
  expect(findClaudeTranscript("cb-1", { variable: "CODEBUDDY_CONFIG_DIR", dir: ".codebuddy" }, home, {})).toBe(path.join(codebuddy, "cb-1.jsonl"));
  expect(findClaudeTranscript("cb-1", folders, home, {})).toBeNull();
  expect(findClaudeTranscript("nope", folders, home, {})).toBeNull();
  expect(findClaudeTranscript("../etc", folders, home, {})).toBeNull();
});

it("reads a conversation read-only from Claude Code's transcript, leaving the machinery out", () => {
  const talk = path.join(dir, "talk.jsonl");
  fs.writeFileSync(
    talk,
    [
      { type: "user", message: { content: "<command-name>/clear</command-name>" } },
      { type: "user", message: { content: "侧栏该怎么分组？" } },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "我建议分成两组。" }, { type: "tool_use", name: "Bash", input: { command: "git log -3", description: "Show recent commits" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "abc" }] } },
      { type: "user", isMeta: true, message: { content: "Caveat" } }
    ]
      .map((o) => JSON.stringify(o))
      .join("\n")
  );
  expect(claude.read(talk)).toEqual({
    cut: false,
    start: 0,
    lines: [
      { who: "person", text: "侧栏该怎么分组？" },
      { who: "agent", text: "我建议分成两组。" },
      { who: "tool", text: "Bash · Show recent commits", detail: { input: "$ git log -3" } }
    ]
  });
  expect(claude.read(path.join(dir, "absent.jsonl"))).toBeNull();
});

it("gives each tool call its whole input and the output filed under its id, an edit as removed and added lines", () => {
  const talk = path.join(dir, "tools.jsonl");
  fs.writeFileSync(
    talk,
    [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test", description: "Run tests" } }, { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/a.ts", old_string: "one\ntwo", new_string: "three" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "41 passed" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "updated" }, { type: "image", source: {} }] }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Read", input: { file_path: "/b.ts", limit: 10 } }] } }
    ]
      .map((o) => JSON.stringify(o))
      .join("\n")
  );
  expect(claude.read(talk)?.lines).toEqual([
    { who: "tool", text: "Bash · Run tests", detail: { input: "$ pnpm test", output: "41 passed" } },
    { who: "tool", text: "Edit · /a.ts", detail: { input: "/a.ts\n- one\n- two\n+ three", output: "updated\n[image]" } },
    // No result yet: the input alone.
    { who: "tool", text: "Read · /b.ts", detail: { input: JSON.stringify({ file_path: "/b.ts", limit: 10 }, null, 2) } }
  ]);
  // A huge output is shortened.
  fs.writeFileSync(talk, [{ type: "assistant", message: { content: [{ type: "tool_use", id: "big", name: "Bash", input: { command: "cat log" } }] } }, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "big", content: "y".repeat(50_000) }] } }].map((o) => JSON.stringify(o)).join("\n"));
  expect(claude.read(talk)?.lines[0]?.detail?.output).toHaveLength(20_001);
});

it("reads a long record a stretch at a time, back to its first line, each line once and whole", () => {
  const long = path.join(dir, "long-talk.jsonl");
  const said = (i: number) => line({ type: "user", message: { content: `第 ${i} 句 ${"字".repeat(2000)}` } });
  // About 7 MB of multi-byte lines, a 3 MB one among them, and a call whose result sits past its stretch's end.
  let text = "";
  for (let i = 0; i < 600; i++) text += said(i);
  text += line({ type: "user", message: { content: `大的一句 ${"x".repeat(3 * 1024 * 1024)}` } });
  for (let i = 600; i < 800; i++) text += said(i);
  text += line({ type: "assistant", message: { content: [{ type: "tool_use", id: "edge", name: "Bash", input: { command: "ls" } }] } });
  const tail = 2 * 1024 * 1024 - 10;
  const resultAt = Buffer.byteLength(text);
  text += line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "edge", content: "a.ts" }] } });
  text += line({ type: "user", message: { content: `最后一句 ${"z".repeat(tail)}` } });
  fs.writeFileSync(long, text);

  const seen: string[] = [];
  let read = claude.read(long);
  let reads = 1;
  const edge = () => seen.find((t) => t.startsWith("Bash"));
  seen.unshift(...read!.lines.map((l) => l.text.slice(0, 12)));
  expect(read!.cut).toBe(true);
  while (read!.cut) {
    read = claude.read(long, { before: read!.start! });
    reads++;
    seen.unshift(...read!.lines.map((l) => (l.who === "tool" ? `${l.text}:${l.detail?.output}` : l.text.slice(0, 12))));
  }
  expect(reads).toBeGreaterThan(2);
  expect(read!.start).toBe(0);
  expect(seen[0]).toBe("第 0 句 字字字字字字");
  expect(seen.filter((t) => t.startsWith("第 ")).length).toBe(800);
  expect(seen.filter((t) => t.startsWith("大的一句")).length).toBe(1);
  expect(seen.at(-1)).toBe("最后一句 zzzzzzz");
  expect(edge()).toBe("Bash · ls:a.ts");
  // A stretch that ends right before a call's result still finds it, just past its end.
  expect(claude.read(long, { before: resultAt })?.lines.at(-1)).toEqual({ who: "tool", text: "Bash · ls", detail: { input: "$ ls", output: "a.ts" } });
  // Asking past the end, or before the start, reads nothing wrong.
  expect(claude.read(long, { before: 0 })).toEqual({ lines: [], cut: false, start: 0 });
  expect(claude.read(long, { before: text.length * 10 })?.lines.at(-1)?.text.startsWith("最后一句")).toBe(true);
});

it("stamps each line with when its entry was written, where the record says", () => {
  const stamped = path.join(dir, "stamped.jsonl");
  fs.writeFileSync(stamped, line({ type: "user", timestamp: "2026-10-27T01:02:03.000Z", message: { content: "你好" } }) + line({ type: "assistant", message: { content: [{ type: "text", text: "在。" }] } }));
  expect(claude.read(stamped)?.lines).toEqual([{ who: "person", text: "你好", at: Date.parse("2026-10-27T01:02:03.000Z") }, { who: "agent", text: "在。" }]);
});
