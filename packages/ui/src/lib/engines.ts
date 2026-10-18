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
