import fs from "node:fs";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { Engine, EngineSetupProgress, EngineSetupStep, EngineSignIn } from "@tomradex/agent";
import type {} from "@tomradex/ipc";
import { archiveFolder, chosenCommand, localCli } from "@tomradex/engine-kit";
import { installArgs, ManagedCopies, type ManagedOffer } from "./managed.js";
import { machineSetupHost, paced, runCommand, runInstall, runSignIn, type SetupHost, type SetupRunResult } from "./run.js";

declare module "cordis" {
  interface Context {
    agentSetup: AgentSetup;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** Starts the step in the background (a no-op while it already runs) and answers with where it stands; `registry` is passed to npm for that install only, `method` picks how to sign in. */
    "agentSetup.start": (engineId: string, step: EngineSetupStep, options?: SetupStartOptions) => EngineSetupProgress;
    "agentSetup.cancel": (engineId: string) => boolean;
    /** Where the engine's last-started step stands; null when none ran yet. */
    "agentSetup.state": (engineId: string) => EngineSetupProgress | null;
    /** What installing Tomrade's own copy of the agent would put in: its npm package, newest version and size; null when it is not npm-distributed. */
    "agentSetup.managed": (engineId: string) => ManagedOffer | null;
  }
  interface Broadcasts {
    /** Every move of a running setup step. */
    "agentSetup.event": (progress: EngineSetupProgress) => void;
  }
}

export interface SetupStartOptions {
  registry?: string;
  /** One of the sign-in methods the agent offers (`progress.methods`). */
  method?: string;
  /** Install Tomrade's own copy into its folder rather than the person's global one. */
  managed?: boolean;
}

export const AgentSetupConfig = z.object({
  /** Where Tomrade's own copies of agents live; absent, none are offered. */
  agentsDir: z.string().optional(),
  /** The binary that runs as Node: the bundled npm, and the copies' scripts. */
  nodeBinary: z.string().default(process.execPath),
  /** The bundled npm's `bin/npm-cli.js`. */
  npmCli: z.string().optional()
}).prefault({});
export type AgentSetupConfig = z.infer<typeof AgentSetupConfig>;

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
  static Config = AgentSetupConfig;

  private runs = new Map<string, Running>();
  /** Replaceable, so tests never spawn real installers. */
  host: SetupHost = machineSetupHost();
  readonly managed: ManagedCopies | null;

  constructor(ctx: Context, config: AgentSetupConfig = AgentSetupConfig.parse({})) {
    super(ctx, "agentSetup");
    this.managed = config.agentsDir ? new ManagedCopies({ dir: config.agentsDir, runtime: config.nodeBinary, ...(config.npmCli ? { npmCli: config.npmCli } : {}), ...(process.versions.electron ? { electron: process.versions.electron } : {}) }) : null;
    try {
      this.managed?.start();
    } catch (error) {
      ctx.logger("agent-setup").warn(error);
    }
    // A copy on trial stays only once a test message on it got its answer.
    ctx.on("agent/engine-tried", (engineId, tried) => void this.settle(engineId, tried.ok).catch((error: unknown) => ctx.logger("agent-setup").warn(error)));
    ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("agentSetup.start", (engineId, step, options) => ctx.agentSetup.start(engineId, step, options));
      ctx.ipc.handle("agentSetup.cancel", (engineId) => ctx.agentSetup.cancel(engineId));
      ctx.ipc.handle("agentSetup.state", (engineId) => ctx.agentSetup.state(engineId));
      ctx.ipc.handle("agentSetup.managed", (engineId) => ctx.agentSetup.managedOffer(engineId));
    });
  }

  /** The npm package an engine installs from, when it declares one and runs its bin, not a package runner (registry agents run through npx). */
  private async packageOf(engine: Engine): Promise<string | null> {
    const npm = engine.local?.setup?.installers?.find((installer) => installer.kind === "npm");
    if (npm?.kind !== "npm" || (await engine.available()).cli?.name === "npx") return null;
    return npm.package;
  }

  async managedOffer(engineId: string): Promise<ManagedOffer | null> {
    const engine = this.ctx.agent.engineOf(engineId);
    const pkg = engine && (await this.packageOf(engine));
    const npm = this.managed?.npm(await this.host.npm());
    if (!pkg || !npm || !this.managed) return null;
    const offer = await this.managed.offer(pkg, npm);
    return "failure" in offer ? null : offer;
  }

  private async settle(engineId: string, ok: boolean): Promise<void> {
    const engine = this.ctx.agent.engineOf(engineId);
    if (!engine || !this.managed?.stateOf(engineId)?.trial) return;
    // Only a test that ran on Tomrade's copy says anything about it.
    if ((await engine.available()).cli?.source !== "managed") return;
    this.managed.settle(engineId, ok);
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

  start(engineId: string, step: EngineSetupStep, options: SetupStartOptions = {}): EngineSetupProgress {
    const held = this.runs.get(engineId);
    if (held?.abort && held.progress.step === step) return held.progress;
    if (held?.abort) throw new Error(`${engineId} is still busy with its ${held.progress.step} step — cancel it first`);
    const engine = this.ctx.agent.engineOf(engineId);
    if (!engine) throw new Error(`No engine "${engineId}"`);
    const abort = new AbortController();
    const run: Running = { progress: { engineId, step, phase: "running" }, abort };
    this.runs.set(engineId, run);
    // The state answers with the latest at once; the broadcast is paced, so a chatty installer does not flood the window.
    const broadcast = paced((progress) => this.ctx.get("ipc")?.send("agentSetup.event", progress));
    const report = (progress: EngineSetupProgress) => {
      run.progress = progress;
      broadcast(progress);
    };
    const task = step === "sign-in" ? this.signIn(engine, report, abort.signal, options.method)
      : options.managed ? this.installManaged(engine, report, abort.signal, options.registry)
      : this.install(engine, report, abort.signal, options.registry);
    task
      .catch((error: unknown) => {
        report({ engineId, step, phase: "failed", failure: { kind: "exit", message: error instanceof Error ? error.message : String(error) } });
      })
      .finally(() => {
        run.abort = null;
      });
    return run.progress;
  }

  private async install(engine: Engine, report: (p: EngineSetupProgress) => void, signal: AbortSignal, registry?: string): Promise<void> {
    await runInstall({
      engineId: engine.id,
      installers: engine.local?.setup?.installers ?? [],
      host: this.host,
      // An archive lands in a folder of Tomrade's own that the locator already reads; one it still misses becomes the engine's command, so no one edits Settings.
      adopt: async (file) => {
        const agent = this.ctx.agent.settingsOf();
        this.ctx.settings.set({ ...this.ctx.settings.get(), agent: { ...agent, engines: { ...agent.engines, [engine.id]: { ...(agent.engines[engine.id] ?? {}), command: file } } } });
      },
      detect: async () => {
        const state = await engine.available({ fresh: true });
        const cli = state.cli;
        // A desktop app's own copy does not count: installing puts the official CLI ahead of it.
        return {
          ready: cli?.state === "ready" && !cli.insideApp,
          ...(cli?.version ? { version: cli.version } : {}),
          ...(cli?.state === "broken" && cli.path ? { path: cli.path } : {}),
          ...(cli?.error ?? state.reason ? { error: cli?.error ?? state.reason } : {})
        };
      },
      report,
      signal,
      ...(registry ? { registry } : {})
    });
  }

  /**
   * Tomrade's own copy: the newest version into a folder of its own, checked to
   * run, then put on trial — first for this agent until a test message says
   * whether it stays. The person's npm, PATH and global folder are untouched.
   */
  private async installManaged(engine: Engine, report: (p: EngineSetupProgress) => void, signal: AbortSignal, registry?: string): Promise<void> {
    const engineId = engine.id;
    const pkg = await this.packageOf(engine);
    const cli = (await engine.available()).cli;
    const npm = this.managed?.npm(await this.host.npm());
    if (!this.managed || !pkg || !cli) return void report({ engineId, step: "install", phase: "failed", failure: { kind: "unsupported", message: `${engine.title} has no npm package Tomrade can install itself` } });
    if (!npm) return void report({ engineId, step: "install", phase: "failed", failure: { kind: "not-found", message: "npm was not found — update Tomrade, which brings its own" } });
    const managed = this.managed;
    report({ engineId, step: "install", phase: "running", installer: "npm", stage: "resolve", startedAt: Date.now() });
    const offer = await managed.offer(pkg, npm, registry);
    if ("failure" in offer) return void report({ engineId, step: "install", phase: "failed", installer: "npm", failure: offer.failure });
    const state = { cli: cli.name, package: pkg };
    const prefix = managed.prefix(engineId, offer.version);
    const end = await runInstall({
      engineId,
      installers: [{ kind: "npm", package: pkg }],
      host: this.host,
      resolve: async (_installer, mirror) => {
        fs.mkdirSync(prefix, { recursive: true });
        const npmrc = await managed.writeNpmrc(npm, prefix, signal);
        return { launch: managed.installing(npm), args: installArgs({ package: pkg, version: offer.version, prefix, npmrc, ...(mirror ? { registry: mirror } : {}) }) };
      },
      detect: () => managed.check(engineId, state, offer.version),
      report,
      signal,
      ...(registry ? { registry } : {})
    });
    if (end.phase !== "done") return managed.discard(engineId, offer.version);
    // The person's own copy ran and still brought them here: its test failed, so Tomrade's goes first from now on.
    managed.begin(engineId, { ...state, version: offer.version, prefer: cli.state === "ready" && cli.source !== "managed" });
  }

  private async signIn(engine: Engine, report: (p: EngineSetupProgress) => void, signal: AbortSignal, method?: string): Promise<void> {
    const signInRun = engine.local?.setup?.signInRun;
    // The engine's probe over a fresh look: exactly what "ready" means everywhere else.
    const probe = async () => (await engine.available({ fresh: true })).ok;
    const state = await engine.available({ fresh: true });
    if (state.ok) return void report({ engineId: engine.id, step: "sign-in", phase: "done" });
    // What it needs is not a sign-in (a model to pick, a service down): say that instead of waiting on one.
    if (state.need && state.need !== "sign-in") {
      return void report({ engineId: engine.id, step: "sign-in", phase: "failed", failure: { kind: "exit", message: state.reason ?? state.need } });
    }
    const own = engine.local?.signIn;
    if (own) return this.signInOwn(engine, own, probe, report, signal, method);
    // The locator's own launch: a desktop app's copy or Tomrade's own copy through its runtime, the folders a fresh PATH added ahead.
    const launch = signInRun && state.cli?.path ? await localCli(state.cli.name).launch(chosenCommand(this.ctx, engine.id)) : null;
    const start = signInRun && launch
      ? () => {
          const takes: ((text: string) => void)[] = [];
          const result: Promise<SetupRunResult> = runCommand(launch, signInRun.args, {
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

  /** The ways the agent itself offers, each step showing them: its own method run and watched, a terminal one left to the terminal. */
  private async signInOwn(engine: Engine, own: EngineSignIn, probe: () => Promise<boolean>, report: (p: EngineSetupProgress) => void, signal: AbortSignal, chosen?: string): Promise<void> {
    const methods = await own.methods(signal);
    const runnable = methods.filter((m) => m.kind !== "other");
    const method = runnable.find((m) => m.id === chosen) ?? runnable.find((m) => m.kind === "agent") ?? runnable[0];
    const shown = (progress: EngineSetupProgress) => report({ ...progress, methods, ...(method ? { method: method.id } : {}) });
    if (!method) {
      return shown({ engineId: engine.id, step: "sign-in", phase: "failed", failure: { kind: "unsupported", message: `${engine.title} offers no way to sign in that Tomrade can start` } });
    }
    if (method.kind === "terminal") await own.start(method.id, { signal, onOutput: () => {} });
    const start = method.kind === "agent"
      ? () => {
          const takes: ((text: string) => void)[] = [];
          const result: Promise<SetupRunResult> = own.start(method.id, { signal, onOutput: (text) => takes.forEach((take) => take(text)) }).then(
            () => ({ code: 0, output: "" }),
            (error: unknown) => ({ code: null, output: "", error: { message: error instanceof Error ? error.message : String(error) } })
          );
          return { result, onOutput: (take: (text: string) => void) => void takes.push(take) };
        }
      : null;
    await runSignIn({ engineId: engine.id, start, probe, report: shown, signal });
  }
}

export default AgentSetup;
export { applicableInstallers, classifyFailure, installerLaunch, machineSetupHost, paced, runArchive, runCommand, runInstall, runSignIn, stageOf } from "./run.js";
export { ArchiveError, archiveDir, listZip, unpackArchive, type ArchiveTarget } from "./archive.js";
export { ManagedCopies, type ManagedConfig, type ManagedOffer, type ManagedState } from "./managed.js";
export type { ArchiveDeps, ArchiveResponse, InstallDeps, SetupHost, SetupRunResult, SignInDeps } from "./run.js";
