import { Context, Service } from "cordis";
import { z } from "zod";
import { contract } from "@tomradex/contracts";
import type {} from "@tomradex/ipc";
import { machineHost, probeGit, runGitInstall, type GitInstallProgress, type GitStatus, type MachineHost } from "./git.js";
import { probeNpm } from "./npm.js";
import { MACHINE_WORDS } from "./words.js";

declare module "cordis" {
  interface Context {
    machineSetup: MachineSetup;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** The machine's git: found and answering, missing, or broken — with any install under way. */
    "machineSetup.git": () => GitStatus;
    /** Starts the platform's own git install in the background (a no-op while one runs) and answers with where things stand. */
    "machineSetup.installGit": () => GitStatus;
    "machineSetup.cancelGitInstall": () => boolean;
  }
}

export const MachineSetupConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    gitBinary: z.string().default("git")
  })
);
export type MachineSetupConfig = z.infer<typeof MachineSetupConfig>;

interface InstallRun {
  progress: GitInstallProgress;
  abort: AbortController | null;
}

/**
 * What the machine itself still lacks: finds git without ever popping Apple's
 * shim dialog, and installs it with the system's own mechanism on a click
 * where there is one (macOS Command Line Tools, winget). Setup screens show
 * the result; the troubleshooter gets the same probe as a checklist row.
 */
export class MachineSetup extends Service {
  static provide = "machineSetup";
  static Config = MachineSetupConfig;

  /** Replaceable, so tests never spawn real installers. */
  host: MachineHost = machineHost();
  private installRun: InstallRun | null = null;

  constructor(
    ctx: Context,
    public readonly config: MachineSetupConfig
  ) {
    super(ctx, "machineSetup");
    ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("machineSetup.git", () => ctx.machineSetup.git());
      ctx.ipc.handle("machineSetup.installGit", () => ctx.machineSetup.installGit());
      ctx.ipc.handle("machineSetup.cancelGitInstall", () => ctx.machineSetup.cancelInstall());
    });
    ctx.inject(["doctor"], (ctx) => {
      const doctor = contract(ctx, "doctor");
      if (!doctor) return;
      doctor.check({
        id: "npm",
        title: () => MACHINE_WORDS(doctor.locale())("checkNpm"),
        run: async () => {
          const words = MACHINE_WORDS(doctor.locale());
          const npm = await probeNpm(ctx.machineSetup.host);
          if (npm.state === "ready") return { state: "ok", line: words("npmFound", { version: npm.version ?? "" }), facts: { npm: npm.path ?? "" } };
          if (npm.state === "missing") return { state: "warn", line: words("npmMissing") };
          return { state: "fail", line: words("npmBroken", { path: npm.path ?? "npm", error: npm.error ?? "" }), ...(npm.error ? { evidence: npm.error } : {}) };
        }
      });
      doctor.check({
        id: "git",
        title: () => MACHINE_WORDS(doctor.locale())("checkGit"),
        run: async () => {
          const words = MACHINE_WORDS(doctor.locale());
          const status = await ctx.machineSetup.git();
          if (status.state === "ready") return { state: "ok", line: words("gitFound", { version: status.version ?? "" }), facts: { git: status.path ?? "" } };
          if (status.state === "missing") return { state: "warn", line: words("gitMissing") };
          return { state: "fail", line: words("gitBroken", { path: status.path ?? "git", error: status.error ?? "" }), ...(status.error ? { evidence: status.error } : {}) };
        }
      });
    });
  }

  async git(): Promise<GitStatus> {
    const status = await probeGit(this.host, this.config.gitBinary);
    return this.installRun ? { ...status, install: this.installRun.progress } : status;
  }

  async installGit(): Promise<GitStatus> {
    if (this.installRun?.abort) return this.git();
    const status = await probeGit(this.host, this.config.gitBinary);
    if (status.state === "ready" || !status.installer) return this.git();
    const abort = new AbortController();
    const run: InstallRun = { progress: { phase: "running" }, abort };
    this.installRun = run;
    void runGitInstall(status.installer, {
      host: this.host,
      probe: () => probeGit(this.host, this.config.gitBinary),
      report: (progress) => {
        run.progress = progress;
      },
      signal: abort.signal
    })
      .catch((error: unknown) => {
        run.progress = { phase: "failed", kind: "exit", message: error instanceof Error ? error.message : String(error) };
      })
      .finally(() => {
        run.abort = null;
      });
    return this.git();
  }

  cancelInstall(): boolean {
    if (!this.installRun?.abort) return false;
    this.installRun.abort.abort();
    return true;
  }
}

export default MachineSetup;
export { findExecutable, installerFor, machineHost, probeGit, runGitInstall } from "./git.js";
export type { GitInstallDeps, GitInstallProgress, GitInstallerKind, GitStatus, MachineHost, RunResult } from "./git.js";
export { probeNpm, type NpmStatus } from "./npm.js";
