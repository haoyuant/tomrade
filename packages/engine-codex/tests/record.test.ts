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
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["ls", "-la"] }) } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "可以。" }] } }
    ]
      .map((o) => JSON.stringify(o))
      .join("\n")
  );
  expect(codexRecord.read(rollout)?.lines).toEqual([
    { who: "person", text: "能恢复历史版本吗" },
    { who: "tool", text: "shell · ls -la" },
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
