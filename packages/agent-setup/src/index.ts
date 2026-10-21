import { Context, Service } from "cordis";
import type { Engine, EngineSetupProgress, EngineSetupStep } from "@tomradex/agent";
import type {} from "@tomradex/ipc";
import { launchFor } from "@tomradex/engine-kit";
import { machineSetupHost, runCommand, runInstall, runSignIn, type SetupHost, type SetupRunResult } from "./run.js";

declare module "cordis" {
  interface Context {
    agentSetup: AgentSetup;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** Starts the step in the background (a no-op while it already runs) and answers with where it stands. */
    "agentSetup.start": (engineId: string, step: EngineSetupStep) => EngineSetupProgress;
    "agentSetup.cancel": (engineId: string) => boolean;
    /** Where the engine's last-started step stands; null when none ran yet. */
    "agentSetup.state": (engineId: string) => EngineSetupProgress | null;
  }
  interface Broadcasts {
    /** Every move of a running setup step. */
    "agentSetup.event": (progress: EngineSetupProgress) => void;
  }
}

interface Running {
  progress: EngineSetupProgress;
  abort: AbortController | null;
}

/**
 * One-click setup: Tomrade installs a chosen agent's CLI itself, in the
 * background with progress, and watches its sign-in until the engine's own
 * probe says it works — no terminal and no admin rights. The engines declare
 * what to run (`setup.installers`, `setup.signInRun`); this service only
 * interprets those declarations, and the screens word the outcome.
 */
export class AgentSetup extends Service {
  static provide = "agentSetup";
  static inject = ["agent"];

  private runs = new Map<string, Running>();
  /** Replaceable, so tests never spawn real installers. */
  host: SetupHost = machineSetupHost();

  constructor(ctx: Context) {
    super(ctx, "agentSetup");
    ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("agentSetup.start", (engineId, step) => ctx.agentSetup.start(engineId, step));
      ctx.ipc.handle("agentSetup.cancel", (engineId) => ctx.agentSetup.cancel(engineId));
      ctx.ipc.handle("agentSetup.state", (engineId) => ctx.agentSetup.state(engineId));
    });
  }

  state(engineId: string): EngineSetupProgress | null {
    return this.runs.get(engineId)?.progress ?? null;
  }

  cancel(engineId: string): boolean {
    const run = this.runs.get(engineId);
    if (!run?.abort) return false;
    run.abort.abort();
    return true;
  }

  start(engineId: string, step: EngineSetupStep): EngineSetupProgress {
    const held = this.runs.get(engineId);
    if (held?.abort && held.progress.step === step) return held.progress;
    if (held?.abort) throw new Error(`${engineId} is still busy with its ${held.progress.step} step — cancel it first`);
    const engine = this.ctx.agent.engineOf(engineId);
    if (!engine) throw new Error(`No engine "${engineId}"`);
    const abort = new AbortController();
    const run: Running = { progress: { engineId, step, phase: "running" }, abort };
    this.runs.set(engineId, run);
    const report = (progress: EngineSetupProgress) => {
      run.progress = progress;
      this.ctx.get("ipc")?.send("agentSetup.event", progress);
    };
    const task = step === "install" ? this.install(engine, report, abort.signal) : this.signIn(engine, report, abort.signal);
    task
      .catch((error: unknown) => {
        report({ engineId, step, phase: "failed", failure: { kind: "exit", message: error instanceof Error ? error.message : String(error) } });
      })
      .finally(() => {
        run.abort = null;
      });
    return run.progress;
  }

  private async install(engine: Engine, report: (p: EngineSetupProgress) => void, signal: AbortSignal): Promise<void> {
    await runInstall({
      engineId: engine.id,
      installers: engine.local?.setup?.installers ?? [],
      host: this.host,
      detect: async () => {
        const state = await engine.available({ fresh: true });
        const cli = state.cli;
        return {
          ready: cli?.state === "ready",
          ...(cli?.version ? { version: cli.version } : {}),
          ...(cli?.state === "broken" && cli.path ? { path: cli.path } : {}),
          ...(cli?.error ?? state.reason ? { error: cli?.error ?? state.reason } : {})
        };
      },
      report,
      signal
    });
  }

  private async signIn(engine: Engine, report: (p: EngineSetupProgress) => void, signal: AbortSignal): Promise<void> {
    const signInRun = engine.local?.setup?.signInRun;
    // The engine's probe over a fresh look: exactly what "ready" means everywhere else.
    const probe = async () => (await engine.available({ fresh: true })).ok;
    const state = await engine.available({ fresh: true });
    if (state.ok) return void report({ engineId: engine.id, step: "sign-in", phase: "done" });
    // What it needs is not a sign-in (a model to pick, a service down): say that instead of waiting on one.
    if (state.need && state.need !== "sign-in") {
      return void report({ engineId: engine.id, step: "sign-in", phase: "failed", failure: { kind: "exit", message: state.reason ?? state.need } });
    }
    const file = state.cli?.path;
    const start = signInRun && file
      ? () => {
          const takes: ((text: string) => void)[] = [];
          const result: Promise<SetupRunResult> = runCommand(launchFor(file, { platform: this.host.platform, env: this.host.env }), signInRun.args, {
            signal,
            timeoutMs: 10 * 60_000,
            env: this.host.env,
            onOutput: (text) => takes.forEach((take) => take(text))
          });
          return { result, onOutput: (take: (text: string) => void) => void takes.push(take) };
        }
      : null;
    await runSignIn({ engineId: engine.id, start, probe, report, signal });
  }
}

export default AgentSetup;
export { applicableInstallers, classifyFailure, installerLaunch, machineSetupHost, runCommand, runInstall, runSignIn } from "./run.js";
export type { InstallDeps, SetupHost, SetupRunResult, SignInDeps } from "./run.js";
