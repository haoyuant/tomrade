/** Codex's own steps and its reconnects, as the panel shows them. */
import { describe, expect, it } from "vitest";
import { codexRetry, codexStep } from "../src/steps.js";

describe("codexRetry", () => {
  it("reads the count and the cause out of a reconnect notice", () => {
    expect(codexRetry({ willRetry: true, error: { message: "Reconnecting... 2/5 (stream disconnected before completion: error sending request)" } }))
      .toEqual({ attempt: 2, max: 5, reason: "stream disconnected before completion: error sending request" });
  });
  it("ignores an error Codex will not retry", () => {
    expect(codexRetry({ willRetry: false, error: { message: "unauthorized" } })).toBeNull();
  });
});

describe("codexStep", () => {
  it("says a failed command with its exit code", () => {
    expect(codexStep({ type: "commandExecution", id: "c", command: "pnpm test", cwd: "/w", status: "failed", exitCode: 1, durationMs: 1200, aggregatedOutput: "FAIL" }))
      .toMatchObject({ tool: "shell", ok: false, summary: "pnpm test — exit 1", ms: 1200, label: "shell · pnpm test" });
  });
  it("lists the files an edit touched", () => {
    expect(codexStep({ type: "fileChange", id: "f", status: "completed", changes: [{ path: "a.ts" }, { path: "b.ts" }] }))
      .toMatchObject({ tool: "edit", ok: true, summary: "a.ts, b.ts" });
  });
  it("leaves Tomrade's own tools to the gateway", () => {
    expect(codexStep({ type: "mcpToolCall", id: "m", server: "tomrade", tool: "list_items", status: "completed" })).toBeNull();
    expect(codexStep({ type: "agentMessage", id: "t", text: "hi" })).toBeNull();
  });
});
