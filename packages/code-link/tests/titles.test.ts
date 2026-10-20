import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { findCodexRollout, findTranscript, promptTitle, readConversation, resumeCommand, transcriptTitle } from "@tomradex/code-link";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titles-"));
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const filler = (n: number) => line({ type: "user", message: { content: "x".repeat(n) } });

it("reads a conversation's title from its transcript: the tail first, then the head, the person's own over the agent's", () => {
  const short = path.join(dir, "short.jsonl");
  fs.writeFileSync(short, line({ type: "ai-title", aiTitle: "初稿" }) + filler(10) + line({ type: "ai-title", aiTitle: "设计终端侧栏" }));
  expect(transcriptTitle(short)).toBe("设计终端侧栏");
  fs.appendFileSync(short, line({ type: "custom-title", customTitle: "我起的名字" }) + line({ type: "ai-title", aiTitle: "后来的" }));
  expect(transcriptTitle(short)).toBe("我起的名字");
  // A long one with its only title near the start: found in the head.
  const long = path.join(dir, "long.jsonl");
  fs.writeFileSync(long, line({ type: "ai-title", aiTitle: "开头的标题" }) + filler(600 * 1024));
  expect(transcriptTitle(long)).toBe("开头的标题");
  fs.writeFileSync(path.join(dir, "none.jsonl"), filler(100));
  expect(transcriptTitle(path.join(dir, "none.jsonl"))).toBeNull();
  expect(transcriptTitle(path.join(dir, "missing.jsonl"))).toBeNull();
});

it("makes a title of a first prompt, finds an older session's transcript by its id, and resumes only agents that can", () => {
  expect(promptTitle("  我们来聊聊\n侧栏的设计  ")).toBe("我们来聊聊 侧栏的设计");
  expect(promptTitle("a".repeat(100))).toHaveLength(60);
  expect(promptTitle("<command-name>/clear</command-name>")).toBeNull();
  expect(promptTitle(undefined)).toBeNull();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const where = path.join(home, ".claude-work", "projects", "-repo");
  fs.mkdirSync(where, { recursive: true });
  fs.writeFileSync(path.join(where, "abc-123.jsonl"), "");
  expect(findTranscript("abc-123", home, {})).toBe(path.join(where, "abc-123.jsonl"));
  expect(findTranscript("nope", home, {})).toBeNull();
  expect(findTranscript("../etc", home, {})).toBeNull();

  expect(resumeCommand("claude-code", "abc-123")).toBe("claude --resume abc-123");
  expect(resumeCommand("codex", "abc-123")).toBe("codex resume abc-123");
  expect(resumeCommand("cursor", "abc-123")).toBeNull();
  expect(resumeCommand("claude-code", null)).toBeNull();
  expect(resumeCommand("claude-code", "x; rm -rf /")).toBeNull();
});

it("reads a conversation read-only from Claude Code's transcript and Codex's rollout, leaving the machinery out", () => {
  const claude = path.join(dir, "talk.jsonl");
  fs.writeFileSync(
    claude,
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
  expect(readConversation("claude-code", claude)).toEqual({
    cut: false,
    lines: [
      { who: "person", text: "侧栏该怎么分组？" },
      { who: "agent", text: "我建议分成两组。" },
      { who: "tool", text: "Bash · Show recent commits" }
    ]
  });
  const codex = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(
    codex,
    [
      { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "能恢复历史版本吗" }] } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["ls", "-la"] }) } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "可以。" }] } }
    ]
      .map((o) => JSON.stringify(o))
      .join("\n")
  );
  expect(readConversation("codex", codex)?.lines).toEqual([
    { who: "person", text: "能恢复历史版本吗" },
    { who: "tool", text: "shell · ls -la" },
    { who: "agent", text: "可以。" }
  ]);
  // A long record: only its tail, and it says the start was left out.
  const long = path.join(dir, "long-talk.jsonl");
  fs.writeFileSync(long, `${JSON.stringify({ type: "user", message: { content: "最早的一句" } })}\n${"x".repeat(3 * 1024 * 1024)}\n${JSON.stringify({ type: "user", message: { content: "最后一句" } })}\n`);
  expect(readConversation("claude-code", long)).toEqual({ cut: true, lines: [{ who: "person", text: "最后一句" }] });
  expect(readConversation("cursor", claude)).toBeNull();
  expect(readConversation("claude-code", path.join(dir, "absent.jsonl"))).toBeNull();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const day = path.join(home, ".codex", "sessions", "2026", "10", "04");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-2026-10-04T21-09-53-abc-1.jsonl"), "");
  expect(findCodexRollout("abc-1", home)).toBe(path.join(day, "rollout-2026-10-04T21-09-53-abc-1.jsonl"));
  expect(findCodexRollout("nope", home)).toBeNull();
});
