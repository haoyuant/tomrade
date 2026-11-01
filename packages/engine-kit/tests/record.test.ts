import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { claudeRecord, claudeTranscriptTitle, findClaudeTranscript, promptTitle, claudeSessions } from "@tomradex/engine-kit";

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
    next: fs.statSync(talk).size,
    held: 3,
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

it("goes on from where the last read stopped: only what came since, a call waiting for its output read again with it", () => {
  const talk = path.join(dir, "going-on.jsonl");
  const said = (text: string) => line({ type: "user", message: { content: text } });
  const call = (id: string, command: string) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const result = (id: string, content: string) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
  // A record past one page: the panel's first read is its end, later ones only what was added.
  fs.writeFileSync(talk, said(`很早 ${"x".repeat(1024 * 1024)}`).repeat(3) + said("开始") + call("t1", "ls") + result("t1", "a.ts"));
  const first = claude.read(talk)!;
  expect(first.cut).toBe(true);
  expect(first.lines.slice(-2).map((l) => l.text)).toEqual(["开始", "Bash · ls"]);
  expect([first.next, first.held]).toEqual([fs.statSync(talk).size, first.lines.length]);

  // A call whose output is not written yet: the next read starts back at it, the line before it is held.
  const callAt = fs.statSync(talk).size;
  fs.appendFileSync(talk, said("再跑一次测试") + call("t2", "pnpm test"));
  const second = claude.read(talk, { after: first.next })!;
  expect(second.start).toBe(first.next);
  expect(second.lines).toEqual([{ who: "person", text: "再跑一次测试" }, { who: "tool", text: "Bash · pnpm test", detail: { input: "$ pnpm test" } }]);
  expect(second.held).toBe(1);
  expect(second.next).toBe(callAt + Buffer.byteLength(said("再跑一次测试")));

  // Its output and a half-written line arrive: the call is read again with its output, the half line waits.
  const before = fs.statSync(talk).size;
  fs.appendFileSync(talk, result("t2", "41 passed") + said("好了").slice(0, 10));
  const third = claude.read(talk, { after: second.next })!;
  expect(third.lines).toEqual([{ who: "tool", text: "Bash · pnpm test", detail: { input: "$ pnpm test", output: "41 passed" } }]);
  expect([third.held, third.next]).toEqual([1, before + Buffer.byteLength(result("t2", "41 passed"))]);
  // Read about as much as was added, not the page.
  expect(fs.statSync(talk).size - third.start!).toBeLessThan(1024);

  // Nothing new: nothing read, the same place.
  fs.writeFileSync(talk, fs.readFileSync(talk, "utf8").slice(0, -10) + said("好了"));
  const fourth = claude.read(talk, { after: third.next })!;
  expect(fourth.lines).toEqual([{ who: "person", text: "好了" }]);
  expect(claude.read(talk, { after: fourth.next })).toMatchObject({ lines: [], start: fourth.next, next: fourth.next, held: 0 });

  // The record shrank, or grew past a page since: its end is read afresh.
  fs.writeFileSync(talk, said("新的开始"));
  expect(claude.read(talk, { after: fourth.next })).toMatchObject({ start: 0, lines: [{ who: "person", text: "新的开始" }] });
  fs.appendFileSync(talk, said(`很长 ${"y".repeat(1024 * 1024)}`).repeat(4));
  expect(claude.read(talk, { after: Buffer.byteLength(said("新的开始")) })?.start).toBeGreaterThan(Buffer.byteLength(said("新的开始")));
});

it("counts a Claude Code session's tokens: each reply once over its entries, its subagents too, and the turn from the person's last line", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
  const file = path.join(home, "s-1.jsonl");
  const at = (s: number) => new Date(Date.UTC(2026, 9, 28, 10, 0, s)).toISOString();
  const usage = (input: number, output: number, read = 0, write = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });
  const reply = (id: string, s: number, u: ReturnType<typeof usage>, content: unknown[] = [{ type: "text", text: "ok" }]) => line({ type: "assistant", timestamp: at(s), message: { id, content, usage: u } });
  const said = (text: string, s: number) => line({ type: "user", timestamp: at(s), message: { content: text } });
  // one reply written as three entries (thinking, text, a tool call), each carrying the same usage
  fs.writeFileSync(file,
    said("first", 0) +
    reply("m1", 2, usage(10, 100, 1000, 50), [{ type: "thinking", thinking: "…" }]) +
    reply("m1", 3, usage(10, 100, 1000, 50)) +
    reply("m1", 4, usage(10, 100, 1000, 50), [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]) +
    line({ type: "user", timestamp: at(5), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb" }] } }) +
    reply("m2", 6, usage(5, 20, 2000))
  );
  const first = claude.usage!(file);
  expect(first?.total).toEqual({ inputTokens: 3065, uncachedInputTokens: 15, cacheReadTokens: 3000, cacheWriteTokens: 50, outputTokens: 120 });
  expect(first?.turn).toEqual({ startedAt: Date.parse(at(0)), lastAt: Date.parse(at(6)), tokens: first!.total });
  // nothing written since: the same count, read no further
  expect(claude.usage!(file, first)).toBe(first);

  // the person speaks again; a reply is cut mid-write, then finished; a subagent runs in this turn
  const sub = path.join(home, "s-1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-a1.jsonl"),
    line({ type: "user", isSidechain: true, timestamp: at(11), message: { content: "look around" } }) +
    line({ type: "assistant", isSidechain: true, timestamp: at(12), message: { id: "s1", content: [], usage: usage(7, 3) } }) +
    line({ type: "assistant", isSidechain: true, timestamp: at(12), message: { id: "s1", content: [], usage: usage(7, 3) } }));
  const cut = reply("m3", 15, usage(1, 9, 4000));
  fs.appendFileSync(file, said("second", 10) + cut.slice(0, 40));
  const mid = claude.usage!(file, first);
  expect(mid?.turn).toEqual({ startedAt: Date.parse(at(10)), lastAt: Date.parse(at(10)), tokens: { inputTokens: 7, uncachedInputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3 } });
  fs.appendFileSync(file, cut.slice(40) + reply("m3", 16, usage(1, 9, 4000)));
  const now = claude.usage!(file, mid);
  expect(now?.turn?.tokens).toEqual({ inputTokens: 4008, uncachedInputTokens: 8, cacheReadTokens: 4000, cacheWriteTokens: 0, outputTokens: 12 });
  expect(now?.turn?.lastAt).toBe(Date.parse(at(16)));
  expect(now?.total.outputTokens).toBe(120 + 3 + 9);
  // counted step by step, it adds up to the same as counting it all at once
  expect(claude.usage!(file)).toEqual({ ...now, state: expect.anything() });
  // a subagent of an earlier turn counts in the session, not in the turn
  fs.appendFileSync(file, said("third", 20));
  const third = claude.usage!(file, now);
  expect(third?.total).toEqual(now?.total);
  expect(third?.turn).toEqual({ startedAt: Date.parse(at(20)), lastAt: Date.parse(at(20)), tokens: expect.objectContaining({ inputTokens: 0, outputTokens: 0 }) });
  // a record that cannot be read counts nothing
  expect(claude.usage!(path.join(home, "missing.jsonl"))).toBeNull();
});

it("starts a count over when the record shrank, and leaves a compacted conversation's summary out of the turns", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
  const file = path.join(home, "s-2.jsonl");
  const reply = (id: string, output: number) => line({ type: "assistant", message: { id, content: [], usage: { input_tokens: 1, output_tokens: output } } });
  fs.writeFileSync(file, line({ type: "user", message: { content: "go" } }) + reply("a", 5) + line({ type: "user", isCompactSummary: true, message: { content: "This session is being continued…" } }) + reply("b", 7));
  const before = claude.usage!(file);
  expect(before?.turn?.tokens.outputTokens).toBe(12);
  fs.writeFileSync(file, line({ type: "user", message: { content: "again" } }) + reply("c", 2));
  expect(claude.usage!(file, before)?.total.outputTokens).toBe(2);
});

it("counts a record larger than one step of reading, a line across the steps' edge whole", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-")), "s-3.jsonl");
  const reply = (id: string, output: number) => line({ type: "assistant", message: { id, content: [{ type: "text", text: "x".repeat(3 * 1024 * 1024) }], usage: { input_tokens: 1, output_tokens: output } } });
  fs.writeFileSync(file, line({ type: "user", message: { content: "go" } }) + reply("a", 5) + line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "y".repeat(5 * 1024 * 1024) }] } }) + reply("b", 7));
  expect(claude.usage!(file)?.total.outputTokens).toBe(12);
});

it("finds the transcripts of sessions that ran in a folder, under every account, with the branch they ended on", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sessions-"));
  const folders = { variable: "CLAUDE_CONFIG_DIR", dir: ".claude" };
  const write = (root: string, slug: string, name: string, lines: unknown[]) => {
    const dir = path.join(home, root, "projects", slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    return file;
  };
  const first = write(".claude", "-repo-my-app", "one.jsonl", [{ gitBranch: "main" }, { gitBranch: "feature/a" }]);
  const second = write(".claude-work", "-repo-my-app", "two.jsonl", [{ gitBranch: "HEAD" }]);
  write(".claude", "-repo-other", "three.jsonl", [{ gitBranch: "x" }]);
  const stale = write(".claude", "-repo-my-app", "old.jsonl", []);
  fs.utimesSync(stale, new Date(1000), new Date(1000));
  const found = claudeSessions(folders, ["/repo/my.app"], { since: 2000, limit: 5 }, home, {});
  expect(found.map((s) => s.file).sort()).toEqual([first, second].sort());
  expect(found.find((s) => s.file === first)).toMatchObject({ cwd: "/repo/my.app", branch: "feature/a" });
  expect(found.find((s) => s.file === second)?.branch).toBeNull();
  fs.rmSync(home, { recursive: true, force: true });
});
