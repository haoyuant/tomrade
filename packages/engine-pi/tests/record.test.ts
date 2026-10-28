import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { findPiSession, piRecord, piSessionFolder, piSessionTitle } from "@tomradex/engine-pi";

const entry = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const message = (id: string, message: Record<string, unknown>, timestamp = "2026-10-28T07:27:00.000Z") => entry({ type: "message", id, parentId: null, timestamp, message });

it("reads a pi session read-only: what was said and each call with its output, not the system prompt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-record-"));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(
    file,
    entry({ type: "session", version: 3, id: "abc", timestamp: "2026-10-28T07:27:00.000Z", cwd: "/repo" }) +
      message("m0", { role: "system", content: "", sections: { preamble: "You are pi" } }) +
      message("m1", { role: "user", content: [{ type: "text", text: "看看目录" }] }, "2026-10-28T07:27:01.000Z") +
      message("m2", { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 } }) +
      message("m3", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a.ts" }], isError: false }) +
      message("m4", { role: "user", content: "<system-reminder>machinery</system-reminder>" }) +
      message("m5", { role: "assistant", content: [{ type: "text", text: "有 a.ts。" }], usage: { input: 3, output: 2, cacheRead: 130, cacheWrite: 0 } }) +
      entry({ type: "usage", id: "u1", parentId: "m5", timestamp: "2026-10-28T07:28:00.000Z", kind: "cache_warm", usage: { input: 0, output: 1, cacheRead: 50, cacheWrite: 0 } })
  );
  expect(piRecord.read(file)?.lines).toEqual([
    { who: "person", text: "看看目录", at: Date.parse("2026-10-28T07:27:01.000Z") },
    { who: "tool", text: "bash · ls", detail: { input: "$ ls", output: "a.ts" }, at: Date.parse("2026-10-28T07:27:00.000Z") },
    { who: "agent", text: "有 a.ts。", at: Date.parse("2026-10-28T07:27:00.000Z") }
  ]);
  expect(piSessionTitle(file)).toBe("看看目录");
  // a name /name gave it wins over the first prompt
  fs.appendFileSync(file, entry({ type: "session_info", id: "n1", parentId: "u1", timestamp: "2026-10-28T07:29:00.000Z", name: "目录" }));
  expect(piRecord.title?.(file)).toBe("目录");
  // pi's `input` leaves the cache out
  expect(piRecord.usage?.(file)?.total).toEqual({ inputTokens: 313, uncachedInputTokens: 13, cacheReadTokens: 280, cacheWriteTokens: 20, outputTokens: 8 });
});

it("finds a session by its id under its working folder's sessions, else under any", () => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sessions-"));
  expect(piSessionFolder("/Users/me/repo")).toBe("--Users-me-repo--");
  const own = path.join(sessions, piSessionFolder("/Users/me/repo"));
  const other = path.join(sessions, piSessionFolder("/tmp/ws"));
  fs.mkdirSync(own);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(own, "2026-10-28T07-27-00-000Z_abc-1.jsonl"), "");
  fs.writeFileSync(path.join(other, "2026-10-28T07-30-00-000Z_def-2.jsonl"), "");
  expect(findPiSession("abc-1", "/Users/me/repo", sessions)).toBe(path.join(own, "2026-10-28T07-27-00-000Z_abc-1.jsonl"));
  expect(findPiSession("def-2", "/Users/me/repo", sessions)).toBe(path.join(other, "2026-10-28T07-30-00-000Z_def-2.jsonl"));
  expect(findPiSession("def-2", null, sessions)).toBe(path.join(other, "2026-10-28T07-30-00-000Z_def-2.jsonl"));
  expect(findPiSession("nope", null, sessions)).toBeNull();
  expect(findPiSession("../x", null, sessions)).toBeNull();
});
