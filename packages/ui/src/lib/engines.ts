import type { EngineTry, EngineView } from "@tomradex/agent";

/**
 * Whether this machine has the engine at all. An in-app engine is here by
 * definition; one behind a CLI is here once the CLI is found — signed out,
 * broken, chosen by hand, or found somewhere it cannot run (WSL, a desktop
 * app) still counts, since the row explains what to do. Only an agent nobody
 * installed is kept out of the way.
 */
export const detectedHere = (engine: Pick<EngineView, "ok" | "cli" | "need">): boolean =>
  engine.ok || (engine.cli ? engine.cli.state !== "missing" || !!engine.cli.wsl || !!engine.cli.desktopApp || !!engine.cli.manual : engine.need !== "install");

/**
 * Whether an engine that says it is ready has shown it can run. Found and
 * signed in is not enough: a try with its settings now settles it. Until then
 * an agent a test message can reach is still being checked — one that could
 * not list its models cannot run a turn — while one on Tomrade's models, or
 * one that runs only in a terminal, goes by its models.
 */
export type EngineHealth = "works" | "checking" | "broken";

type HealthOf = Pick<EngineView, "ok" | "tried" | "picks" | "usesModels" | "terminalOnly">;

const modelPick = (engine: Pick<EngineView, "picks">) => engine.picks?.find((pick) => pick.key === "model");
const triable = (engine: HealthOf) => !engine.usesModels && !engine.terminalOnly;

export function engineHealth(engine: HealthOf): EngineHealth {
  if (!engine.ok) return "broken";
  if (engine.tried) return engine.tried.ok ? "works" : "broken";
  const model = modelPick(engine);
  if (model?.failed) return "broken";
  return model?.pending || triable(engine) ? "checking" : "works";
}

/** Found and signed in, never tried: only a test message tells whether it works. */
export const awaitsTry = (engine: HealthOf): boolean => engine.ok && !engine.tried && triable(engine) && !modelPick(engine)?.failed;

/** The last try with the engine's current settings, when it came back without a real reply. */
export const failedTry = (engine: Pick<EngineView, "tried">): EngineTry | undefined => (engine.tried && !engine.tried.ok ? engine.tried : undefined);

/** What keeps an engine that says it is ready from running, in its agent's words; none when nothing is known to. */
export function engineProblem(engine: HealthOf): { kind: "tried" | "models"; detail: string } | null {
  if (!engine.ok) return null;
  if (engine.tried) return engine.tried.ok ? null : { kind: "tried", detail: engine.tried.error ?? "" };
  const failed = modelPick(engine)?.failed;
  return failed ? { kind: "models", detail: failed } : null;
}
