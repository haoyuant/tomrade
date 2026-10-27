import { expect, it } from "vitest";
import type { ThreadMessage } from "@tomradex/agent";
import { firstCodeStep, foldSteps, startBriefId, traceState, workDone, writesCode } from "../src/lib/steps";

it("maps command outcomes to distinct labels and reserves red warnings for failures", () => {
  const cases = [
    ["success", "commandSuccess", "i-check", false], ["no-match", "commandNoMatch", "i-search", false],
    ["condition-false", "commandConditionFalse", "i-search", false], ["failed", "commandFailed", "i-warn", true],
    ["declined", "commandDeclined", "i-stop", false], ["timed-out", "commandTimedOut", "i-clock", false],
    ["interrupted", "commandInterrupted", "i-stop", false]
  ] as const;
  for (const [status, label, icon, failed] of cases) {
    expect(traceState({ type: "trace", tool: "shell", args: {}, ok: false, summary: "", ms: 0,
      commandResult: { status, exitCode: null, output: "" } })).toEqual({ label: `agentPanel.${label}`, icon, failed });
  }
  expect(traceState({ type: "trace", tool: "shell", args: {}, ok: false, summary: "exit 1", ms: 0 }))
    .toEqual({ label: null, icon: "i-warn", failed: true });
});

let seq = 0;
const trace = (ok = true): ThreadMessage => ({ id: `m${++seq}`, threadId: "t", seq, role: "agent", runId: "r", at: 0, block: { type: "trace", tool: "Bash", args: {}, ok, summary: "", ms: 1 } });
const text = (): ThreadMessage => ({ id: `m${++seq}`, threadId: "t", seq, role: "agent", runId: "r", at: 0, block: { type: "text", text: "hi" } });
const shape = (entries: ReturnType<typeof foldSteps>) => entries.map((e) => ("fold" in e ? `fold${e.fold.length}` : e.block.type === "trace" ? (e.block.ok ? "ok" : "fail") : e.block.type));

it("leaves a short run of steps open", () => {
  expect(shape(foldSteps([text(), trace(), trace(), trace(), text()]))).toEqual(["text", "ok", "ok", "ok", "text"]);
});

it("folds the earlier steps of a long run and keeps the last three open", () => {
  expect(shape(foldSteps([trace(), trace(), trace(), trace(), trace(), trace()]))).toEqual(["fold3", "ok", "ok", "ok"]);
});

it("never folds a failed step", () => {
  expect(shape(foldSteps([trace(), trace(), trace(false), trace(), trace(), trace(), trace(), trace()]))).toEqual(["fold2", "fail", "fold2", "ok", "ok", "ok"]);
});

const user = (text: string): ThreadMessage => ({ id: `m${++seq}`, threadId: "t", seq, role: "user", runId: "r", at: 0, block: { type: "text", text } });
const brief = "Implement TOM-1 — \"Cart badge\".\nFollow the playbook first: open_playbook(\"code.implement\").\n\nTicket:\nAdd a badge to the cart.\n\nConventions:\n- this run owns exactly TOM-1; implement only its stated outcome and acceptance criteria";

it("folds the machine-written brief that opened a ticket's session, and only that", () => {
  const messages = [user(brief), user("make it blue")];
  expect(startBriefId(messages, true)).toBe(messages[0].id);
  // a free-form conversation keeps every message as it is
  expect(startBriefId(messages, false)).toBeNull();
  // the person's own words are never folded, however long
  expect(startBriefId([user("x".repeat(400))], true)).toBeNull();
  expect(startBriefId([user("Work on TOM-1: Cart badge. Follow the selected delivery playbook")], true)).toBeNull();
  // a continued session's brief is folded the same way
  expect(startBriefId([user("Continue TOM-1 — \"Cart badge\" on branch tom-1/cart-badge.")], true)).toBeTruthy();
});

const step = (tool: string, args: unknown = {}, output?: string, ok = true): ThreadMessage => ({
  id: `m${++seq}`, threadId: "t", seq, role: "agent", runId: "r", at: 0,
  block: { type: "trace", tool, args, ok, summary: "", ms: 1, ...(output !== undefined ? { commandResult: { status: "success", exitCode: 0, output } } : {}) }
});

it("says what a folded stretch of steps came to: files changed, commands run, and the latest test counts", () => {
  const folded = foldSteps([
    step("write_file", { path: "a.ts" }), step("edit", { file_path: "a.ts" }), step("Edit", { file_path: "b.ts" }),
    step("bash", {}, " Tests  2 failed | 10 passed"), step("bash", {}, " Test Files  3 passed (3)\n      Tests  12 passed (12)"),
    step("read_file", { path: "c.ts" }), step("Bash"), step("Bash"), step("Bash")
  ]);
  const fold = folded[0] as { fold: ThreadMessage[]; work: ReturnType<typeof workDone> };
  expect(fold.work).toEqual({ steps: 6, files: 2, commands: 2, passed: 12, failed: null });
  expect(workDone([{ tool: "bash", output: "5 passed, 1 failed in 0.3s" }])).toMatchObject({ passed: 5, failed: 1 });
  expect(workDone([{ tool: "read_file" }])).toEqual({ steps: 1, files: 0, commands: 0, passed: null, failed: null });
});

it("marks where a conversation turns to code: the first changed file after something was said", () => {
  const said = text();
  const write = step("write_file", { path: "a.ts" });
  expect(firstCodeStep([user("go"), said, step("read_file"), write, step("edit")])).toBe(write.id);
  // a thread that starts on code has nothing to set apart, nor one that never writes
  expect(firstCodeStep([user("go"), step("edit"), text()])).toBeNull();
  expect(firstCodeStep([user("go"), text(), step("bash")])).toBeNull();
});

it("says whether the run going now has changed a file — the moment its coding can move to the background", () => {
  const inRun = (m: ThreadMessage, runId: string): ThreadMessage => ({ ...m, runId });
  const messages = [inRun(user("write it"), "r1"), inRun(step("bash", { command: "ls" }), "r1"), inRun(step("write_file", { path: "a.ts" }), "r1"), inRun(user("more"), "r2"), inRun(step("bash", {}), "r2")];
  expect(writesCode(messages, "r1")).toBe(true);
  expect(writesCode(messages, "r2")).toBe(false);
});

it("folds the handover that opens a conversation writing code in the background, ticket or not", () => {
  const opener = user("Carry on in the background — Dedupe chat\n\nThe person moved the coding out of the conversation…");
  expect(startBriefId([opener, user("and tests")], false)).toBe(opener.id);
  expect(startBriefId([opener], true)).toBe(opener.id);
});
