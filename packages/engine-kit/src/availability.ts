import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import type { EngineAvailability, EngineNeed, LocalCliStatus } from "@tomradex/agent";
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
  /** A desktop app of the same agent that does not include the CLI: named when the CLI is missing but the app is there. */
  desktopApp?: DesktopApp;
}

export interface DesktopApp {
  title: string;
  /** macOS bundle names, looked for in /Applications and ~/Applications. */
  mac?: string[];
  /** Windows install folders, relative to %LOCALAPPDATA% or Program Files. */
  windows?: string[];
  /** Further places, as absolute paths. */
  paths?: string[];
}

/** Where a desktop app may be installed on this machine, whether or not it is. */
export function desktopAppPaths(app: DesktopApp, host: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string } = { platform: process.platform, env: process.env, home: os.homedir() }): string[] {
  const extra = app.paths ?? [];
  if (host.platform === "darwin") return [...extra, ...(app.mac ?? []).flatMap((name) => ["/Applications", path.posix.join(host.home, "Applications")].map((root) => path.posix.join(root, `${name}.app`)))];
  if (host.platform === "win32") {
    const env = (key: string) => Object.entries(host.env).find(([name]) => name.toUpperCase() === key)?.[1];
    const roots = [env("LOCALAPPDATA") ?? path.win32.join(host.home, "AppData", "Local"), env("PROGRAMFILES")].filter((dir): dir is string => !!dir);
    return [...extra, ...(app.windows ?? []).flatMap((dir) => roots.map((root) => path.win32.join(root, dir)))];
  }
  return extra;
}

/** A found CLI that lies in the agent's desktop app is that app's own copy: named by the app's title. */
function inside(found: LocalCliStatus, app: DesktopApp | undefined): LocalCliStatus {
  if (found.state !== "ready" || !found.path || !app) return found;
  const p = found.platform === "win32" ? path.win32 : path.posix;
  const norm = (file: string) => (found.platform === "win32" ? p.normalize(file).toLowerCase() : p.normalize(file));
  const held = desktopAppPaths(app).some((dir) => norm(found.path!).startsWith(norm(dir) + p.sep));
  return held ? { ...found, insideApp: app.title } : found;
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
    const found = await engine.cli.locate({ manual, fresh: opts?.fresh });
    // The app people install first rarely brings the CLI; say so rather than only "not found".
    const app = found.state === "missing" && engine.desktopApp && desktopAppPaths(engine.desktopApp).some((dir) => fs.existsSync(dir)) ? engine.desktopApp.title : null;
    const cli = app ? { ...found, desktopApp: app } : inside(found, engine.desktopApp);
    const state: EngineAvailability =
      cli.state !== "ready"
        ? { ok: false, reason: app ? `${engine.title}: the ${app} app is installed, but not its command-line tool ${cli.name}, which Tomrade runs — ${engine.install}` : cliReason(engine.title, cli, engine.install), need: cli.state === "missing" ? "install" : "repair", cli }
        : !ctx.get("mcp")?.url
          ? { ok: false, reason: "the MCP server is not running — enable the mcp plugin", need: "service", cli }
          : engine.signIn && !(await canWork(engine.cli, manual, engine.signIn))
            ? { ok: false, reason: engine.signIn.reason, need: engine.signIn.need ?? "sign-in", cli, ...(engine.configDir ? { configDir: engine.configDir() } : {}) }
            : { ok: true, cli };
    probe = { at: Date.now(), command, state };
    return state;
  };
}
