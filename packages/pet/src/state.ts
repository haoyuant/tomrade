import type { AgentEvent, RunStatus } from "@tomrade/agent";

export type PetMood = "idle" | "thinking" | "working" | "waiting" | "success" | "error" | "walk";
export type TaskPetMood = Exclude<PetMood, "walk">;

export interface ThreadPetState {
  mood: TaskPetMood;
  runId: string | null;
  sequence: number;
}

export interface PetModel {
  sequence: number;
  threads: Record<string, ThreadPetState>;
}

export const emptyPetModel = (): PetModel => ({ sequence: 0, threads: {} });

const moodForRun = (status: RunStatus): TaskPetMood =>
  status === "running" ? "thinking" : status === "asked" ? "waiting" : status === "done" ? "success" : status === "error" ? "error" : "idle";

/** Pure reducer shared by the service and focused tests. */
export function reducePetModel(model: PetModel, threadId: string, event: AgentEvent): PetModel {
  const before = model.threads[threadId] ?? { mood: "idle" as const, runId: null, sequence: 0 };
  let mood = before.mood;
  let runId = before.runId;

  switch (event.type) {
    case "run":
      mood = moodForRun(event.run.status);
      runId = event.run.id;
      break;
    case "progress":
      if (runId && event.runId !== runId) return model;
      // `activity` is absent on usage-only ticks (e.g. after each streamed delta) — those
      // carry no signal about what the agent is doing, so leave mood as-is. Only an explicit
      // null (a tool just finished) or a tool name should move the mood.
      if (event.activity !== undefined) mood = event.activity ? "working" : "thinking";
      runId = event.runId;
      break;
    case "delta":
      if (runId && event.runId !== runId) return model;
      mood = "working";
      runId = event.runId;
      break;
    case "message":
      if (event.message.runId && (!runId || event.message.runId === runId) && event.message.role !== "user") {
        mood = event.message.block.type === "error" ? "error" : "working";
        runId = event.message.runId;
      }
      break;
    case "card":
      mood = "working";
      break;
    case "pending":
      mood = event.pending ? "waiting" : runId ? "thinking" : "idle";
      break;
    case "done":
      mood = moodForRun(event.run.status);
      runId = event.run.id;
      break;
  }

  const sequence = model.sequence + 1;
  return { sequence, threads: { ...model.threads, [threadId]: { mood, runId, sequence } } };
}

export const moodForThread = (model: PetModel, threadId: string | null): TaskPetMood =>
  (threadId ? model.threads[threadId]?.mood : undefined) ?? "idle";

const PRIORITY: Record<TaskPetMood, number> = { idle: 0, success: 1, thinking: 2, working: 3, waiting: 4, error: 5 };

/** Highest urgency wins; ties use latest event then thread id, independent of map insertion order. */
export function desktopThreadState(model: PetModel): { threadId: string | null; mood: TaskPetMood } {
  const selected = Object.entries(model.threads).sort(
    ([aId, a], [bId, b]) => PRIORITY[b.mood] - PRIORITY[a.mood] || b.sequence - a.sequence || aId.localeCompare(bId)
  )[0];
  return selected ? { threadId: selected[0], mood: selected[1].mood } : { threadId: null, mood: "idle" };
}
