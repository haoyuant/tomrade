import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexRecord, codexRolloutTitle, codexSessions, findCodexRollout } from "@tomradex/engine-codex";

it("reads a conversation read-only from Codex's rollout, names it by the first prompt, and finds it by its id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-"));
  const rollout = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(
    rollout,
    [
      { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "能恢复历史版本吗" }] } },
      { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["ls", "-la"] }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: "a.ts\nb.ts", metadata: { exit_code: 0 } }) } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c2", input: "\nconst r = await tools.exec_command({cmd: \"pwd\"});\nreturn r;" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c2", output: [{ type: "input_text", text: "Script completed" }, { type: "input_text", text: "/repo" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "可以。" }] } }
    ]
      .map((o) => JSON.stringify(o))
      .join("\n")
  );
  expect(codexRecord.read(rollout)?.lines).toEqual([
    { who: "person", text: "能恢复历史版本吗" },
    { who: "tool", text: "shell · ls -la", detail: { input: "$ ls -la", output: "a.ts\nb.ts" } },
    // Newer Codex: a free-form call, named by its first line.
    { who: "tool", text: "exec · const r = await tools.exec_command({cmd: \"pwd\"});", detail: { input: "\nconst r = await tools.exec_command({cmd: \"pwd\"});\nreturn r;", output: "Script completed\n/repo" } },
    { who: "agent", text: "可以。" }
  ]);
  expect(codexRolloutTitle(rollout)).toBe("能恢复历史版本吗");
  expect(codexRecord.title?.(rollout)).toBe("能恢复历史版本吗");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const day = path.join(home, "sessions", "2026", "10", "04");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-2026-10-04T21-09-53-abc-1.jsonl"), "");
  expect(findCodexRollout("abc-1", home)).toBe(path.join(day, "rollout-2026-10-04T21-09-53-abc-1.jsonl"));
  expect(findCodexRollout("nope", home)).toBeNull();
  expect(findCodexRollout("../x", home)).toBeNull();
});

it("goes on from where the last read of a rollout stopped, waiting on a call until its output is written", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-going-on-"));
  const rollout = path.join(dir, "rollout.jsonl");
  const item = (payload: unknown) => `${JSON.stringify({ type: "response_item", payload })}\n`;
  fs.writeFileSync(rollout, item({ type: "message", role: "user", content: [{ type: "input_text", text: "看看目录" }] }) + item({ type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["ls"] }) }));
  const first = codexRecord.read(rollout)!;
  expect(first.lines.map((l) => l.text)).toEqual(["看看目录", "shell · ls"]);
  expect(first.held).toBe(1);
  fs.appendFileSync(rollout, item({ type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: "a.ts", metadata: { exit_code: 0 } }) }) + item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "有 a.ts。" }] }));
  const next = codexRecord.read(rollout, { after: first.next })!;
  expect(next.start).toBe(first.next);
  expect(next.lines).toEqual([{ who: "tool", text: "shell · ls", detail: { input: "$ ls", output: "a.ts" } }, { who: "agent", text: "有 a.ts。" }]);
  expect([next.held, next.next]).toEqual([2, fs.statSync(rollout).size]);
});

it("counts a Codex session's tokens from its running totals, and the turn as what they grew since the person's last line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-"));
  const rollout = path.join(dir, "rollout.jsonl");
  const at = (s: number) => new Date(Date.UTC(2026, 9, 28, 10, 0, s)).toISOString();
  const said = (text: string, s: number) => `${JSON.stringify({ timestamp: at(s), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })}\n`;
  const totals = (s: number, input: number, cached: number, output: number) =>
    `${JSON.stringify({ timestamp: at(s), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output }, last_token_usage: {} } } })}\n`;
  fs.writeFileSync(rollout, said("<environment_context>…", 0) + said("first", 1) + totals(3, 1000, 600, 50) + totals(5, 2500, 1800, 80) + `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } })}\n`);
  const first = codexRecord.usage!(rollout);
  expect(first?.total).toEqual({ inputTokens: 2500, uncachedInputTokens: 700, cacheReadTokens: 1800, cacheWriteTokens: 0, outputTokens: 80 });
  expect(first?.turn).toEqual({ startedAt: Date.parse(at(1)), lastAt: Date.parse(at(5)), tokens: first!.total });
  expect(codexRecord.usage!(rollout, first)).toBe(first);
  fs.appendFileSync(rollout, said("second", 10) + totals(12, 4000, 3000, 130));
  const second = codexRecord.usage!(rollout, first);
  // the totals are the session's; this turn is what they grew by
  expect(second?.total).toEqual({ inputTokens: 4000, uncachedInputTokens: 1000, cacheReadTokens: 3000, cacheWriteTokens: 0, outputTokens: 130 });
  expect(second?.turn).toEqual({ startedAt: Date.parse(at(10)), lastAt: Date.parse(at(12)), tokens: { inputTokens: 1500, uncachedInputTokens: 300, cacheReadTokens: 1200, cacheWriteTokens: 0, outputTokens: 50 } });
  // counted again from where it stopped, nothing is counted twice
  expect(codexRecord.usage!(rollout, second)).toBe(second);
  expect(codexRecord.usage!(rollout)).toEqual({ ...second, state: expect.anything() });
  // a resumed session whose totals start from nothing again adds on
  fs.appendFileSync(rollout, totals(20, 100, 0, 10));
  expect(codexRecord.usage!(rollout, second)?.total.outputTokens).toBe(140);
});

describe("sessions by folder", () => {
  const rollout = (home: string, day: string, id: string, cwd: string, extra = "") => {
    const dir = path.join(home, "sessions", ...day.split("-"));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${day}T00-00-00-${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id, cwd } }).replace("}}", `${extra}}}`)}\n`);
    return file;
  };

  it("finds the rollouts that ran in a folder, reading only their heads, and stops at old days", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sessions-"));
    const mine = rollout(home, "2026-10-30", "a", "/repo/a", ',"git":{"commit_hash":"x","branch":"feature/a"}');
    rollout(home, "2026-10-30", "b", "/repo/other");
    const old = rollout(home, "2026-01-01", "c", "/repo/a");
    fs.utimesSync(old, new Date("2026-01-01"), new Date("2026-01-01"));
    expect(codexSessions(["/repo/a"], { since: Date.parse("2026-10-01"), limit: 5 }, home)).toMatchObject([{ file: mine, cwd: "/repo/a", branch: "feature/a" }]);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
