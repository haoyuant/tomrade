import type { Context } from "cordis";
import type { EngineAvailability, EngineNeed } from "@tomradex/agent";
import type {} from "@tomradex/mcp";
import { signedIn } from "./cli.js";
import { cliReason, type CliLocator } from "./locate.js";

interface LocalEngine {
  engineId: string;
  title: string;
  cli: CliLocator;
  /** The English tail of "not found — …". */
  install: string;
  /**
   * Whether the CLI can work yet: a run whose output answers, or the engine's own `ask` (null: no clear answer,
   * taken as yes). `need` is what a "no" means (default: signing in).
   */
  signIn?: ({ args: string[]; says(output: string): boolean | null } | { ask(command: string | undefined): Promise<boolean | null> }) & { reason: string; need?: EngineNeed };
  /** Where the CLI reads its sign-in and settings from, shown when it is not signed in. */
  configDir?(): string;
}

/** The CLI path the person chose in Settings, if any. */
export function chosenCommand(ctx: Context, engineId: string): string | undefined {
  const options = ctx.get("agent")?.settingsOf().engines[engineId] as { command?: unknown } | undefined;
  return typeof options?.command === "string" ? options.command : undefined;
}

function canWork(cli: CliLocator, manual: string | undefined, check: NonNullable<LocalEngine["signIn"]>): Promise<boolean> {
  return "ask" in check ? check.ask(manual).then((yes) => yes ?? true, () => true) : signedIn(cli, manual, check.args, check.says);
}

/** A local agent is ready when its CLI runs, the MCP server it calls back on is up, and it is signed in. */
export function localAvailability(ctx: Context, engine: LocalEngine): (opts?: { fresh?: boolean }) => Promise<EngineAvailability> {
  let probe: { at: number; command?: string; state: EngineAvailability } | null = null;
  return async (opts) => {
    const command = chosenCommand(ctx, engine.engineId);
    if (!opts?.fresh && probe && probe.command === command && Date.now() - probe.at < 30_000) return probe.state;
    const manual = engine.cli.manualOf(command);
    const cli = await engine.cli.locate({ manual, fresh: opts?.fresh });
    const state: EngineAvailability =
      cli.state !== "ready"
        ? { ok: false, reason: cliReason(engine.title, cli, engine.install), need: cli.state === "missing" ? "install" : "repair", cli }
        : !ctx.get("mcp")?.url
          ? { ok: false, reason: "the MCP server is not running — enable the mcp plugin", need: "service", cli }
          : engine.signIn && !(await canWork(engine.cli, manual, engine.signIn))
            ? { ok: false, reason: engine.signIn.reason, need: engine.signIn.need ?? "sign-in", cli, ...(engine.configDir ? { configDir: engine.configDir() } : {}) }
            : { ok: true, cli };
    probe = { at: Date.now(), command, state };
    return state;
  };
}
