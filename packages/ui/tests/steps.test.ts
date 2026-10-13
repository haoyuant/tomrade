import { expect, it } from "vitest";
import type { ThreadMessage } from "@tomradex/agent";
import { foldSteps } from "../src/lib/steps";

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
