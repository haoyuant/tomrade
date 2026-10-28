import type { AgentEvent, RunStatus } from "@tomradex/agent";

/** Every state a pet can show, in the order a profile editor lists them. */
export const PET_MOODS = ["idle", "thinking", "working", "waiting", "success", "error"] as const;
export type PetMood = (typeof PET_MOODS)[number];

export interface ThreadPetState {
  mood: PetMood;
  runId: string | null;
  /** The live run's pose between events: thinking until its first output, then working; null once it ends. */
  busy: "thinking" | "working" | null;
  sequence: number;
}

export interface PetModel {
  sequence: number;
  threads: Record<string, ThreadPetState>;
}

export const emptyPetModel = (): PetModel => ({ sequence: 0, threads: {} });

const moodForRun = (status: RunStatus): PetMood =>
  status === "running" ? "thinking" : status === "asked" ? "waiting" : status === "done" ? "success" : status === "error" ? "error" : "idle";

/** Pure reducer shared by the service and focused tests. */
export function reducePetModel(model: PetModel, threadId: string, event: AgentEvent): PetModel {
  const before = model.threads[threadId] ?? { mood: "idle" as const, runId: null, busy: null, sequence: 0 };
  let { mood, runId, busy } = before;
  // Output from another run, or from this one after it ended (a cancelled tool's late tick), says nothing about now.
  const stale = (id: string) => (runId !== null && id !== runId) || (id === runId && busy === null);

  switch (event.type) {
    case "run":
      // Each turn is a new run and thinks until its first output; the same run resuming keeps its pose.
      busy = event.run.status !== "running" ? null : event.run.id === runId && busy ? busy : "thinking";
      mood = busy ?? moodForRun(event.run.status);
      runId = event.run.id;
      break;
    case "progress":
      if (stale(event.runId)) return model;
      // `activity` is absent on usage-only ticks (e.g. after each streamed delta) — those
      // carry no signal about what the agent is doing, so leave mood as-is. A tool name,
      // or an explicit null (a tool just finished), means the turn has produced output.
      if (event.activity !== undefined) mood = busy = "working";
      runId = event.runId;
      break;
    case "delta":
      if (stale(event.runId)) return model;
      mood = busy = "working";
      runId = event.runId;
      break;
    case "message":
      if (event.message.runId && event.message.role !== "user" && !stale(event.message.runId)) {
        busy = "working";
        mood = event.message.block.type === "error" ? "error" : "working";
        runId = event.message.runId;
      }
      break;
    case "card":
      mood = "working";
      if (busy) busy = "working";
      break;
    case "pending":
      mood = event.pending ? "waiting" : (busy ?? "idle");
      break;
    case "done":
      busy = null;
      mood = moodForRun(event.run.status);
      runId = event.run.id;
      break;
  }

  // A streamed word after the first one changes nothing the pet shows: the same model means no redraw is sent.
  if (mood === before.mood && runId === before.runId && busy === before.busy) return model;
  const sequence = model.sequence + 1;
  return { sequence, threads: { ...model.threads, [threadId]: { mood, runId, busy, sequence } } };
}

/** How long a finished turn's success shows before the pet goes back to idle; an error stays until the next turn. */
export const SUCCESS_REST_MS = 30_000;

/** The success of `runId` gives way to idle; anything that happened since keeps its own mood. */
export function restPetThread(model: PetModel, threadId: string, runId: string | null): PetModel {
  const thread = model.threads[threadId];
  if (!thread || thread.mood !== "success" || thread.runId !== runId) return model;
  const sequence = model.sequence + 1;
  return { sequence, threads: { ...model.threads, [threadId]: { ...thread, mood: "idle", sequence } } };
}

export const moodForThread = (model: PetModel, threadId: string | null): PetMood =>
  (threadId ? model.threads[threadId]?.mood : undefined) ?? "idle";
