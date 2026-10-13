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
  it.each(["rg missing src", "grep -q missing file", "egrep missing file", "fgrep missing file", "/usr/bin/grep 'a && b' file", "/bin/zsh -lc \"rg missing src\"", "rg missing a && grep missing b"])("shows exit 1 as no matches for %s", command => {
    expect(codexStep({ type: "commandExecution", command, status: "failed", exitCode: 1, aggregatedOutput: "" }))
      .toMatchObject({ ok: true, commandResult: { status: "no-match", exitCode: 1, output: "" } });
  });
  it.each(["test -f missing", "[ -f missing ]", "git diff --quiet", "git diff --exit-code"])("shows exit 1 as a false condition for %s", command => {
    expect(codexStep({ type: "commandExecution", command, status: "failed", exitCode: 1 }))
      .toMatchObject({ ok: true, commandResult: { status: "condition-false", exitCode: 1 } });
  });
  it.each(["npm test", "npm test && rg missing src", "cat missing && rg pattern src", "rg pattern src | head", "echo 'rg missing'", "rg pattern src; npm test", "rg $(cat pattern) src"])("keeps ambiguous or failing commands red: %s", command => {
    expect(codexStep({ type: "commandExecution", command, status: "failed", exitCode: 1 })?.commandResult?.status).toBe("failed");
  });
  it("does not hide a search error or discard its output", () => {
    expect(codexStep({ type: "commandExecution", command: "rg '[' src", status: "failed", exitCode: 2, aggregatedOutput: "regex parse error" }))
      .toMatchObject({ ok: false, commandResult: { status: "failed", exitCode: 2, output: "regex parse error" } });
  });
  it.each([
    ["completed", 0, "success"], ["declined", 1, "declined"], ["rejected", null, "declined"],
    ["timed_out", null, "timed-out"], ["timedOut", null, "timed-out"], ["failed", 124, "timed-out"],
    ["interrupted", null, "interrupted"], ["cancelled", null, "interrupted"], ["inProgress", null, "interrupted"],
    ["failed", null, "failed"]
  ])("maps %s / exit %s to %s", (status, exitCode, expected) => {
    expect(codexStep({ type: "commandExecution", command: "rg pattern src", status, exitCode })?.commandResult?.status).toBe(expected);
  });
  it("keeps only the last 30 lines and bounds a single long line", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    expect(codexStep({ type: "commandExecution", command: "npm test", status: "failed", exitCode: 1, aggregatedOutput: lines + "\n" })?.commandResult?.output)
      .toBe(lines.split("\n").slice(-30).join("\n"));
    expect(codexStep({ type: "commandExecution", command: "npm test", status: "failed", exitCode: 1, aggregatedOutput: "x".repeat(20_000) })?.commandResult?.output).toHaveLength(8000);
  });
  it("reads the snake-case rollout fields from TOM-81's raw event", () => {
    const item = { type: "CommandExecution", id: "exec-68b1585f-2379-4436-9398-2a6614af9f2b",
      command: ["/bin/zsh", "-lc", "sed -n '130,186p' packages/items/src/service.ts && sed -n '208,236p' packages/code-link/src/store.ts && sed -n '1,85p' packages/code-link/src/service.ts && rg -n 'lint' CLAUDE.md package.json .github/workflows -g '*.yml' -g '*.yaml'"],
      status: "failed", exit_code: 1, aggregated_output: "export type RepoPolicyPatch = Pick<RepoStatePatch, \"branchTemplate\" | \"autoDone\" | \"agentPush\" | \"readiness\">;\n\nexport interface ConnectResult {\n",
      duration: { secs: 0, nanos: 6958 } };
    expect(codexStep(item)).toMatchObject({ tool: "shell", commandResult: { exitCode: 1, output: item.aggregated_output.trimEnd() } });
    expect(codexStep({ type: "command_execution", command: "rg missing src", status: "failed", exit_code: 1, aggregated_output: "" }))
      .toMatchObject({ ok: true, commandResult: { status: "no-match" } });
  });
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
