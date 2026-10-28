import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { codexRecord, codexRolloutTitle, findCodexRollout } from "@tomradex/engine-codex";

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
