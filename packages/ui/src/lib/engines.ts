import type { EngineView } from "@tomradex/agent";

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
 * signed in is not enough: a try with its settings now settles it, else the
 * models it listed — an agent that could not list them cannot run a turn.
 */
export type EngineHealth = "works" | "checking" | "broken";

const modelPick = (engine: Pick<EngineView, "picks">) => engine.picks?.find((pick) => pick.key === "model");

export function engineHealth(engine: Pick<EngineView, "ok" | "tried" | "picks">): EngineHealth {
  if (!engine.ok) return "broken";
  if (engine.tried) return engine.tried.ok ? "works" : "broken";
  const model = modelPick(engine);
  if (model?.failed) return "broken";
  return model?.pending ? "checking" : "works";
}

/** What keeps an engine that says it is ready from running, in its agent's words; none when nothing is known to. */
export function engineProblem(engine: Pick<EngineView, "ok" | "tried" | "picks">): { kind: "tried" | "models"; detail: string } | null {
  if (!engine.ok) return null;
  if (engine.tried) return engine.tried.ok ? null : { kind: "tried", detail: engine.tried.error ?? "" };
  const failed = modelPick(engine)?.failed;
  return failed ? { kind: "models", detail: failed } : null;
}
