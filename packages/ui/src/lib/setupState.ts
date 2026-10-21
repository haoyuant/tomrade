import type { EngineView } from "@tomradex/agent";
import type { WorkerStatus } from "@tomradex/llm";
import { engineHealth, engineProblem } from "./engines";

/** An engine a ticket can be handed to: it works on this computer, not only through Tomrade's tools. */
export const isLocalAgent = (engine: EngineView): boolean => engine.capabilities.includes("code") || engine.capabilities.includes("general");

/** The in-app agent on Tomrade's own models (the built-in Pi), as against an agent the person installed. */
const onModels = (engine: EngineView): boolean => !!engine.usesModels;

/**
 * The ways to an agent that takes tickets, in the order setup tries them: the
 * person's own install, then the copy Tomrade installs and runs itself, then
 * the built-in agent on a model they connect.
 */
export const ROUTES = ["own", "managed", "builtin"] as const;
export type SetupRoute = (typeof ROUTES)[number];

/** Agents the person installs, found here, that all failed to run — none works or is still being checked. */
export function ownFailed(engines: EngineView[]): EngineView[] {
  const own = engines.filter((e) => e.setup && isLocalAgent(e) && !onModels(e));
  if (own.some((e) => engineHealth(e) !== "broken")) return [];
  return own.filter((e) => engineProblem(e));
}

/** Why the built-in agent cannot take tickets on the connected model, in its own words; none while it can, or before a model is connected. */
export function builtinProblem(engines: EngineView[], worker: WorkerStatus): string | null {
  if (!worker.ok || worker.via !== "profile") return null;
  const inApp = engines.find((e) => onModels(e) && e.reason);
  return inApp?.reason && !(inApp.ok && isLocalAgent(inApp)) ? inApp.reason : null;
}

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
  const locals = working.filter(isLocalAgent);
  // The first route that works, as setup tells it; the built-in agent only once its model answered.
  const installed = locals.filter((e) => !onModels(e));
  const route: SetupRoute | null = installed.some((e) => e.cli?.source !== "managed") ? "own" : installed.length ? "managed" : workerReady && locals.some(onModels) ? "builtin" : null;
  return { complete, checking, assistant, locals, worker, route };
}

/** How long the first run waits on an agent still listing its models before it decides without it. */
export const FIRST_RUN_CHECK_MS = 20_000;

/**
 * The setup screen put away on this machine. Per device, though the seen list
 * travels with the account: one put away on another computer, or the plain
 * "setup-screen" older versions wrote, does not vouch for this one.
 */
export const setupSeenId = (device: string) => `setup-screen:${device}`;

/**
 * Whether the first run opens the setup screen: only while nothing works yet,
 * never once it was dealt with on this machine, and not before an agent still
 * listing its models has had a moment to answer. Null: not decided yet.
 */
export function firstRunSetup(
  state: { complete: boolean; checking: boolean },
  opts: { seen: (id: string) => boolean; device: string; waited: boolean }
): "open" | "closed" | null {
  if (state.complete || opts.seen(setupSeenId(opts.device))) return "closed";
  return state.checking && !opts.waited ? null : "open";
}
