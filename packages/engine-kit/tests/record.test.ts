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
    lines: [
      { who: "person", text: "侧栏该怎么分组？" },
      { who: "agent", text: "我建议分成两组。" },
      { who: "tool", text: "Bash · Show recent commits" }
    ]
  });
  // A long record: only its tail, and it says the start was left out.
  const long = path.join(dir, "long-talk.jsonl");
  fs.writeFileSync(long, `${JSON.stringify({ type: "user", message: { content: "最早的一句" } })}\n${"x".repeat(3 * 1024 * 1024)}\n${JSON.stringify({ type: "user", message: { content: "最后一句" } })}\n`);
  expect(claude.read(long)).toEqual({ cut: true, lines: [{ who: "person", text: "最后一句" }] });
  expect(claude.read(path.join(dir, "absent.jsonl"))).toBeNull();
});
