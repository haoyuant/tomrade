import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { expect, it } from "vitest";
import type { Engine, EngineRecord } from "@tomradex/agent";
import { recordOf, resumeCommand } from "@tomradex/code-link";

const withEngines = (engines: Record<string, Partial<Engine>>) =>
  ({ get: (name: string) => (name === "agent" ? { engineOf: (id: string) => engines[id] } : undefined) }) as unknown as Context;

it("reads an agent's record as its engine declares it, CodeBuddy's as Claude Code's, and no other", () => {
  const own: EngineRecord = { find: () => "/x.json", read: () => ({ lines: [{ who: "agent", text: "hi" }], cut: false }) };
  const ctx = withEngines({ gemini: { local: { record: own } }, cursor: { local: {} } });
  expect(recordOf(ctx, "gemini")).toBe(own);
  expect(recordOf(ctx, "cursor")).toBeNull();
  expect(recordOf(ctx, "unknown")).toBeNull();
  expect(recordOf({ get: () => undefined } as unknown as Context, "gemini")).toBeNull();

  const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codebuddy-")), "cb.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "ai-title", aiTitle: "CodeBuddy 的标题" })}\n${JSON.stringify({ type: "user", message: { content: "你好" } })}\n`);
  const codebuddy = recordOf(ctx, "workbuddy");
  expect(codebuddy?.title?.(transcript)).toBe("CodeBuddy 的标题");
  expect(codebuddy?.read(transcript)?.lines).toEqual([{ who: "person", text: "你好" }]);
  // Its plugin's own record, once it declares one, comes first.
  expect(recordOf(withEngines({ workbuddy: { local: { record: own } } }), "workbuddy")).toBe(own);
});

it("resumes only agents that can", () => {
  expect(resumeCommand("claude-code", "abc-123")).toBe("claude --resume abc-123");
  expect(resumeCommand("codex", "abc-123")).toBe("codex resume abc-123");
  expect(resumeCommand("cursor", "abc-123")).toBeNull();
  expect(resumeCommand("claude-code", null)).toBeNull();
  expect(resumeCommand("claude-code", "x; rm -rf /")).toBeNull();
});
