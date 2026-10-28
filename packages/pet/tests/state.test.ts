import { describe, expect, it } from "vitest";
import type { AgentEvent, RunView } from "@tomradex/agent";
import { emptyPetModel, moodForThread, reducePetModel } from "@tomradex/pet";

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
  it("keeps the same model for events that change nothing it shows, so a stream of words sends no redraws", () => {
    let model = apply([{ type: "run", run: run("r1", "running") }]);
    model = reducePetModel(model, "thread", { type: "delta", runId: "r1", text: "first" });
    expect(moodForThread(model, "thread")).toBe("working");
    const working = model;
    for (const text of ["second", "third", "fourth"]) model = reducePetModel(model, "thread", { type: "delta", runId: "r1", text });
    model = reducePetModel(model, "thread", { type: "progress", runId: "r1" });
    expect(model).toBe(working);
    // A change it shows is still a new model.
    expect(reducePetModel(model, "thread", { type: "done", run: run("r1", "done") })).not.toBe(working);
  });

  it("maps the agent lifecycle without reading renderer IPC", () => {
    let model = apply([{ type: "run", run: run("r1", "running") }]);
    expect(moodForThread(model, "thread")).toBe("thinking");
    model = reducePetModel(model, "thread", { type: "progress", runId: "r1", activity: "list_items" });
    expect(moodForThread(model, "thread")).toBe("working");
    model = reducePetModel(model, "thread", { type: "progress", runId: "r1", activity: null });
    expect(moodForThread(model, "thread")).toBe("working");
    model = reducePetModel(model, "thread", { type: "delta", runId: "r1", text: "hello" });
    expect(moodForThread(model, "thread")).toBe("working");
    model = reducePetModel(model, "thread", { type: "pending", pending: { threadId: "thread", kind: "ask", workflow: null, question: { id: "q", text: "Continue?" }, accepts: "text" } });
    expect(moodForThread(model, "thread")).toBe("waiting");
    model = reducePetModel(model, "thread", { type: "done", run: run("r1", "done") });
    expect(moodForThread(model, "thread")).toBe("success");
    model = reducePetModel(model, "thread", { type: "done", run: run("r2", "error") });
    expect(moodForThread(model, "thread")).toBe("error");
  });

  it("thinks only until each turn's first output", () => {
    const ask = { threadId: "thread", kind: "ask" as const, workflow: null, question: { id: "q", text: "Allow?" }, accepts: "text" as const };
    let model = apply([{ type: "run", run: run("r1", "running") }]);
    model = reducePetModel(model, "thread", { type: "progress", runId: "r1", usage: { inputTokens: 10, outputTokens: 0 } });
    expect(moodForThread(model, "thread")).toBe("thinking");
    model = reducePetModel(model, "thread", { type: "delta", runId: "r1", text: "Let me look" });
    model = reducePetModel(model, "thread", { type: "progress", runId: "r1", activity: "list_items" });
    model = reducePetModel(model, "thread", { type: "progress", runId: "r1", activity: null });
    expect(moodForThread(model, "thread")).toBe("working");
    model = reducePetModel(model, "thread", { type: "pending", pending: ask });
    expect(moodForThread(model, "thread")).toBe("waiting");
    model = reducePetModel(model, "thread", { type: "pending", pending: null });
    expect(moodForThread(model, "thread")).toBe("working");
    model = reducePetModel(model, "thread", { type: "done", run: run("r1", "done") });
    model = reducePetModel(model, "thread", { type: "run", run: run("r2", "running") });
    expect(moodForThread(model, "thread")).toBe("thinking");
  });

  it("ignores a finished run's late ticks and a question cleared after it", () => {
    let model = apply([{ type: "run", run: run("r1", "running") }, { type: "delta", runId: "r1", text: "x" }, { type: "done", run: run("r1", "cancelled") }]);
    const ended = model;
    model = reducePetModel(model, "thread", { type: "progress", runId: "r1", activity: null });
    expect(model).toBe(ended);
    model = reducePetModel(model, "thread", { type: "run", run: run("r2", "running") });
    model = reducePetModel(model, "thread", { type: "done", run: run("r2", "asked") });
    expect(moodForThread(model, "thread")).toBe("waiting");
    model = reducePetModel(model, "thread", { type: "pending", pending: null });
    expect(moodForThread(model, "thread")).toBe("idle");
  });

  it("stays on working through the delta's own usage-only progress tick", () => {
    let model = apply([{ type: "run", run: run("r1", "running") }]);
    model = reducePetModel(model, "thread", { type: "delta", runId: "r1", text: "The " });
    expect(moodForThread(model, "thread")).toBe("working");
    // io.delta's follow-up progress call carries usage but no activity key.
    model = reducePetModel(model, "thread", { type: "progress", runId: "r1", usage: { inputTokens: 0, outputTokens: 1 } });
    expect(moodForThread(model, "thread")).toBe("working");
    model = reducePetModel(model, "thread", { type: "delta", runId: "r1", text: "answer" });
    expect(moodForThread(model, "thread")).toBe("working");
    model = reducePetModel(model, "thread", { type: "progress", runId: "r1", usage: { inputTokens: 0, outputTokens: 2 } });
    expect(moodForThread(model, "thread")).toBe("working");
  });

  it("ignores stale progress and keeps each thread's state to itself", () => {
    let model = apply([{ type: "run", run: run("current", "running") }]);
    const unchanged = reducePetModel(model, "thread", { type: "delta", runId: "old", text: "late" });
    expect(unchanged).toBe(model);
    model = reducePetModel(model, "waiting-thread", {
      type: "pending",
      pending: { threadId: "waiting-thread", kind: "ask", workflow: null, question: { id: "q", text: "Need input" }, accepts: "text" }
    });
    expect([moodForThread(model, "waiting-thread"), moodForThread(model, "thread"), moodForThread(model, null)]).toEqual(["waiting", "thinking", "idle"]);
  });
});
