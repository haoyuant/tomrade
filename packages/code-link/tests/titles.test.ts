import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { findTranscript, promptTitle, resumeCommand, transcriptTitle } from "@tomradex/code-link";

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
