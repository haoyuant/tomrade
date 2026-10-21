import type { EngineView } from "@tomradex/agent";
import type { WorkerStatus } from "@tomradex/llm";
import { engineHealth } from "./engines";

/** An engine a ticket can be handed to: it works on this computer, not only through Tomrade's tools. */
export const isLocalAgent = (engine: EngineView): boolean => engine.capabilities.includes("code") || engine.capabilities.includes("general");

/** The worker profile's one-token test as the gate reads it; "pending" while it runs or is still unasked. */
export type WorkerTested = { ok: boolean } | "pending";

/**
 * Whether Tomrade can work yet. Either a model or a signed-in local agent is
 * enough: a model also runs the built-in agent, and a local agent lends its
 * model for planning — so one step sets up both. An agent counts once it has
 * shown it runs, not when it is merely found (`engineHealth`), and a worker
 * profile once a real call answered (`workerTest`) — a lent model already
 * proved itself through its agent.
 */
export function setupState(engines: EngineView[], worker: WorkerStatus, workerTest?: WorkerTested) {
  const working = engines.filter((e) => engineHealth(e) === "works");
  const assistant = working.filter((e) => e.capabilities.includes("backlog"));
  const viaProfile = worker.ok && worker.via === "profile";
  const workerReady = worker.ok && (!viaProfile || (workerTest !== undefined && workerTest !== "pending" && workerTest.ok));
  const complete = workerReady && assistant.length > 0;
  // An agent still listing its models, or a profile still answering its test, may yet turn out to work.
  const checking =
    !complete &&
    ((viaProfile && assistant.length > 0 && (workerTest === undefined || workerTest === "pending")) ||
      engines.some((e) => engineHealth(e) === "checking" && e.capabilities.includes("backlog")));
  return { complete, checking, assistant, locals: working.filter(isLocalAgent), worker };
}

/** How long the first run waits on an agent still listing its models before it decides without it. */
export const FIRST_RUN_CHECK_MS = 20_000;

/**
 * Whether the first run opens the setup screen: only while nothing works yet,
 * never once it was dealt with, and not before an agent still listing its
 * models has had a moment to answer. Null: not decided yet.
 */
export function firstRunSetup(state: { complete: boolean; checking: boolean }, opts: { seen: boolean; waited: boolean }): "open" | "closed" | null {
  if (opts.seen || state.complete) return "closed";
  return state.checking && !opts.waited ? null : "open";
}
