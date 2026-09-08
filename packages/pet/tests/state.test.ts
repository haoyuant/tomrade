import { describe, expect, it } from "vitest";
import type { AgentEvent, RunView } from "@tomrade/agent";
import { desktopThreadState, emptyPetModel, moodForThread, reducePetModel } from "@tomrade/pet";

const run = (id: string, status: RunView["status"]): RunView => ({
  id,
  threadId: "thread",
  status,
  engine: "test",
  stop: null,
  error: null,
  usage: null,
  costUsd: null,
  changes: 0,
  reverted: false,
  keptOnRevert: 0,
  startedAt: 1,
  endedAt: status === "running" ? null : 2
});

const apply = (events: AgentEvent[]) => events.reduce((model, event) => reducePetModel(model, "thread", event), emptyPetModel());

describe("pet state", () => {
  it("maps the agent lifecycle without reading renderer IPC", () => {
    let model = apply([{ type: "run", run: run("r1", "running") }]);
    expect(moodForThread(model, "thread")).toBe("thinking");
    model = reducePetModel(model, "thread", { type: "progress", runId: "r1", activity: "list_items" });
    expect(moodForThread(model, "thread")).toBe("working");
    model = reducePetModel(model, "thread", { type: "progress", runId: "r1", activity: null });
    expect(moodForThread(model, "thread")).toBe("thinking");
    model = reducePetModel(model, "thread", { type: "delta", runId: "r1", text: "hello" });
    expect(moodForThread(model, "thread")).toBe("working");
    model = reducePetModel(model, "thread", { type: "pending", pending: { threadId: "thread", kind: "ask", workflow: null, question: { id: "q", text: "Continue?" }, accepts: "text" } });
    expect(moodForThread(model, "thread")).toBe("waiting");
    model = reducePetModel(model, "thread", { type: "done", run: run("r1", "done") });
    expect(moodForThread(model, "thread")).toBe("success");
    model = reducePetModel(model, "thread", { type: "done", run: run("r2", "error") });
    expect(moodForThread(model, "thread")).toBe("error");
  });

  it("ignores stale progress and chooses a deterministic desktop state", () => {
    let model = apply([{ type: "run", run: run("current", "running") }]);
    const unchanged = reducePetModel(model, "thread", { type: "delta", runId: "old", text: "late" });
    expect(unchanged).toBe(model);
    model = reducePetModel(model, "waiting-thread", {
      type: "pending",
      pending: { threadId: "waiting-thread", kind: "ask", workflow: null, question: { id: "q", text: "Need input" }, accepts: "text" }
    });
    expect(desktopThreadState(model)).toEqual({ threadId: "waiting-thread", mood: "waiting" });
    model = reducePetModel(model, "error-thread", { type: "done", run: { ...run("failed", "error"), threadId: "error-thread" } });
    expect(desktopThreadState(model)).toEqual({ threadId: "error-thread", mood: "error" });
  });
});
