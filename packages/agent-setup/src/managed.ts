import fs from "node:fs";
import path from "node:path";
import type { EngineSetupFailure } from "@tomradex/agent";
import { readJsonOr, writeFileAtomic, writeJsonAtomic } from "@tomradex/contracts";
import { binKind, describeRun, localCli, machineHost, managedLaunch, type CliLaunch, type CliRunResult, type ManagedCli } from "@tomradex/engine-kit";
import { runCommand, type SetupRunResult } from "./run.js";

/**
 * Tomrade's own copy of an agent: its npm package installed into
 * `<agents>/<engine>/<version>/` by the bundled npm on Tomrade's runtime, with
 * none of the person's npm settings but how to reach the registry, and run
 * without PATH, shim or shell. A new version replaces the one in use only
 * once it answered a test message; the one before stays, to go back to.
 */

export interface ManagedConfig {
  /** One folder per agent, one per version inside it. */
  dir: string;
  /** The binary that runs as Node. */
  runtime: string;
  /** The bundled npm's `bin/npm-cli.js`; when it is not there, the machine's npm. */
  npmCli?: string;
  /** Electron's version, so native addons are fetched or built for it rather than for plain Node. */
  electron?: string;
}

export interface ManagedState {
  /** The command the engine's locator finds it under. */
  cli: string;
  package: string;
  /** The version that answered a test and is in use. */
  current?: string;
  /** The one in use before it, kept. */
  previous?: string;
  /** Installed and waiting on its test. */
  trial?: string;
  /** The person's own copy ran but failed its test: Tomrade's goes ahead of it, not only where theirs is missing. */
  prefer: boolean;
  /** The trial's test failed with no version in use yet: it waits behind the person's own copy for one that passes. */
  failed?: boolean;
}

export interface ManagedOffer {
  package: string;
  version: string;
  /** Unpacked, with this platform's native package; null when npm did not say. */
  bytes: number | null;
}

/**
 * What a package needs beyond its bin: an entry that runs when the bin is
 * still a placeholder (Claude Code's resolves its native package itself), and
 * the environment that keeps its self-updater off — the copy is pinned.
 */
const PACKAGE_EXTRAS: Record<string, { stubEntry?: string; env?: Record<string, string> }> = {
  "@anthropic-ai/claude-code": { stubEntry: "cli-wrapper.cjs", env: { DISABLE_AUTOUPDATER: "1" } },
  "opencode-ai": { env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } },
  "@earendil-works/pi-coding-agent": { env: { PI_SKIP_VERSION_CHECK: "1" } }
};

/** The person's npm settings a managed install keeps: how to reach the registry, nothing about what to install. */
const NPM_KEPT = ["registry", "proxy", "https-proxy", "cafile", "strict-ssl"];

/** `npm config get registry proxy …` output, its `key=value` lines, as the settings that are set. */
export function parseNpmConfig(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^([\w-]+)=(.*)$/.exec(line.trim());
    if (match && NPM_KEPT.includes(match[1]) && match[2] && match[2] !== "null" && match[2] !== "undefined") values[match[1]] = match[2];
  }
  return values;
}

export const npmrcOf = (values: Record<string, string>): string =>
  [...Object.entries(values).filter(([key]) => NPM_KEPT.includes(key)).map(([key, value]) => `${key}=${value}`), "update-notifier=false", ""].join("\n");

export function installArgs(opts: { package: string; version: string; prefix: string; npmrc: { user: string; global: string }; registry?: string }): string[] {
  return [
    "install", "--prefix", opts.prefix, `${opts.package}@${opts.version}`,
    "--no-audit", "--no-fund", "--foreground-scripts", "--include=optional",
    // The person's .npmrc may say ignore-scripts or omit=optional, which leave a native agent as its placeholder.
    "--userconfig", opts.npmrc.user, "--globalconfig", opts.npmrc.global,
    // Piped, npm prints nothing until it ends; at `http` it prints a line per fetch.
    "--loglevel", "http",
    ...(opts.registry ? ["--registry", opts.registry] : [])
  ];
}

/**
 * What npm installs with: none of the person's `npm_config_*`, Tomrade's node
 * first so postinstall scripts run on the runtime the agent will, and native
 * addons fetched for Electron's ABI rather than plain Node's.
 */
function installEnv(base: NodeJS.ProcessEnv, opts: { nodeDir: string; electron?: string; platform: NodeJS.Platform }): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !/^npm_config_/i.test(key)));
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? (opts.platform === "win32" ? "Path" : "PATH");
  const sep = opts.platform === "win32" ? ";" : ":";
  return {
    ...env,
    [key]: [opts.nodeDir, ...(env[key] ?? "").split(sep).filter(Boolean)].join(sep),
    ELECTRON_RUN_AS_NODE: "1",
    ...(opts.electron ? { npm_config_runtime: "electron", npm_config_target: opts.electron, npm_config_disturl: "https://electronjs.org/headers" } : {})
  };
}

/** The `node` that runs Tomrade's runtime, for install scripts and an agent's tools. */
function nodeShim(runtime: string, platform: NodeJS.Platform): { name: string; content: string } {
  return platform === "win32"
    ? { name: "node.cmd", content: ["@echo off", "rem Written by Tomrade at every start. Do not edit.", "set ELECTRON_RUN_AS_NODE=1", `"${runtime}" %*`, ""].join("\r\n") }
    : { name: "node", content: ["#!/bin/sh", "# Written by Tomrade at every start. Do not edit.", "export ELECTRON_RUN_AS_NODE=1", `exec "${runtime}" "$@"`, ""].join("\n") };
}

/** The package's bin named as the engine's command, under an install prefix, as an absolute file; a placeholder gives way to the package's own entry. */
export function managedBin(prefix: string, pkg: string, cli: string): { file: string; kind: ReturnType<typeof binKind> } | null {
  const root = path.join(prefix, "node_modules", ...pkg.split("/"));
  const manifest = readJsonOr<{ bin?: string | Record<string, string> } | null>(path.join(root, "package.json"), null);
  const bins = typeof manifest?.bin === "string" ? { [cli]: manifest.bin } : (manifest?.bin ?? {});
  const entry = bins[cli];
  if (!entry) return null;
  const file = path.resolve(root, entry);
  const kind = binKind(file);
  const fallback = PACKAGE_EXTRAS[pkg]?.stubEntry;
  if (kind === "stub" && fallback && fs.existsSync(path.join(root, fallback))) return { file: path.join(root, fallback), kind: "node" };
  return { file, kind };
}

/** The platform's own native package among the optional dependencies (`@openai/codex-darwin-arm64`), as a spec npm can view. */
export function nativeSpec(optional: Record<string, string>, platform: NodeJS.Platform, arch: string): string | null {
  const os = { darwin: "(darwin|macos|mac)", win32: "(win32|windows|win)", linux: "linux" }[platform as string] ?? platform;
  const match = new RegExp(`(^|[-/])${os}-${arch}$`);
  const name = Object.keys(optional).find((dep) => match.test(dep));
  if (!name) return null;
  const range = optional[name];
  return range.startsWith("npm:") ? range.slice(4) : `${name}@${range}`;
}

type Exec = (launch: CliLaunch, args: string[], opts: { signal: AbortSignal; timeoutMs: number }) => Promise<SetupRunResult>;
type Run = (launch: CliLaunch, args: string[], timeoutMs: number) => Promise<CliRunResult>;

const folderName = (engineId: string) => engineId.replace(/[^\w.-]/g, "_");
const VIEW_MS = 30_000;
const VERSION_MS = 20_000;

export class ManagedCopies {
  private offers = new Map<string, { at: number; offer: Promise<ManagedOffer | { failure: EngineSetupFailure }> }>();

  constructor(
    readonly config: ManagedConfig,
    private platform: NodeJS.Platform = process.platform,
    /** Tells the engine's locator which copy to use; tests watch it instead. */
    private use: (cli: string, copy: ManagedCli | null) => void = (cli, copy) => localCli(cli).useManaged(copy),
    private exec: Exec = runCommand,
    private run: Run = machineHost().run
  ) {}

  get nodeDir(): string {
    return path.join(this.config.dir, "node");
  }

  /** Writes the `node` shim for the runtime's current path — an update moves the app — and points every locator at its copy. */
  start(): void {
    const shim = nodeShim(this.config.runtime, this.platform);
    writeFileAtomic(path.join(this.nodeDir, shim.name), shim.content, this.platform === "win32" ? {} : { mode: 0o755 });
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(this.config.dir);
    } catch {}
    for (const id of ids) {
      const state = this.stateOf(id);
      if (state) this.point(id, state);
    }
  }

  prefix(engineId: string, version: string): string {
    return path.join(this.config.dir, folderName(engineId), version);
  }

  private stateFile(engineId: string): string {
    return path.join(this.config.dir, folderName(engineId), "state.json");
  }

  stateOf(engineId: string): ManagedState | null {
    const state = readJsonOr<ManagedState | null>(this.stateFile(engineId), null);
    return state && typeof state.cli === "string" && typeof state.package === "string" ? state : null;
  }

  private save(engineId: string, state: ManagedState): void {
    writeJsonAtomic(this.stateFile(engineId), state);
    this.point(engineId, state);
  }

  /** The copy a version gives, ready to start; null when it is not installed or its bin is a placeholder. */
  copyOf(engineId: string, state: Pick<ManagedState, "cli" | "package">, version: string, prefer: boolean): ManagedCli | null {
    const bin = managedBin(this.prefix(engineId, version), state.package, state.cli);
    if (!bin || bin.kind === "stub") return null;
    const env = PACKAGE_EXTRAS[state.package]?.env;
    return { file: bin.file, version, runtime: this.config.runtime, nodeDir: this.nodeDir, prefer, ...(env ? { env } : {}) };
  }

  /** A trial goes first, so the test it waits on reaches it; then the version in use. */
  private point(engineId: string, state: ManagedState): void {
    const version = state.trial ?? state.current;
    this.use(state.cli, version ? this.copyOf(engineId, state, version, (!!state.trial && !state.failed) || state.prefer) : null);
  }

  /** The bundled npm on Tomrade's runtime, else `fallback` (the machine's). */
  npm(fallback: CliLaunch | null): CliLaunch | null {
    const cli = this.config.npmCli && fs.existsSync(this.config.npmCli) ? this.config.npmCli : null;
    if (!cli) return fallback;
    return { file: cli, argv: (args) => ({ command: this.config.runtime, args: [cli, ...args] }), env: (base = process.env) => ({ ...base, ELECTRON_RUN_AS_NODE: "1" }) };
  }

  /** That npm with the install's own environment. */
  installing(npm: CliLaunch): CliLaunch {
    return { ...npm, env: (base) => installEnv(npm.env(base), { nodeDir: this.nodeDir, electron: this.config.electron, platform: this.platform }) };
  }

  /** The npmrc files this install reads: the person's registry, proxy and CA, read through npm itself, and an empty global one. */
  async writeNpmrc(npm: CliLaunch, prefix: string, signal: AbortSignal): Promise<{ user: string; global: string }> {
    const answer = await this.exec(npm, ["config", "get", ...NPM_KEPT], { signal, timeoutMs: VIEW_MS });
    const files = { user: path.join(prefix, ".tomrade-npmrc"), global: path.join(prefix, ".tomrade-npmrc-global") };
    writeFileAtomic(files.user, npmrcOf(answer.code === 0 ? parseNpmConfig(answer.output) : {}));
    writeFileAtomic(files.global, "");
    return files;
  }

  /** The newest version on the registry and how big it unpacks, asked again after a while. */
  offer(pkg: string, npm: CliLaunch, registry?: string, arch: string = process.arch): Promise<ManagedOffer | { failure: EngineSetupFailure }> {
    const key = `${pkg} ${registry ?? ""}`;
    const held = this.offers.get(key);
    if (held && Date.now() - held.at < 10 * 60_000) return held.offer;
    const view = (spec: string, fields: string[]) =>
      this.exec(npm, ["view", spec, ...fields, "--json", ...(registry ? ["--registry", registry] : [])], { signal: new AbortController().signal, timeoutMs: VIEW_MS });
    const offer = (async (): Promise<ManagedOffer | { failure: EngineSetupFailure }> => {
      const main = await view(`${pkg}@latest`, ["version", "dist.unpackedSize", "optionalDependencies"]);
      const info = jsonOf(main.output) as { version?: string; "dist.unpackedSize"?: number; optionalDependencies?: Record<string, string> } | null;
      if (main.code !== 0 || !info?.version) return { failure: { kind: main.code === null ? "timeout" : "registry", message: lastLine(main.output) || `npm view ${pkg} failed` } };
      const native = nativeSpec(info.optionalDependencies ?? {}, this.platform, arch);
      const extra = native ? Number(jsonOf((await view(native, ["dist.unpackedSize"])).output)) : 0;
      const size = (info["dist.unpackedSize"] ?? 0) + (Number.isFinite(extra) ? extra : 0);
      return { package: pkg, version: info.version, bytes: size > 0 ? size : null };
    })();
    this.offers.set(key, { at: Date.now(), offer });
    void offer.then((answer) => "failure" in answer && this.offers.delete(key));
    return offer;
  }

  /** Whether a version installed into its folder runs: its bin, what kind it is, and its `--version`. */
  async check(engineId: string, state: Pick<ManagedState, "cli" | "package">, version: string): Promise<{ ready: boolean; version?: string; path?: string; error?: string; kind?: EngineSetupFailure["kind"] }> {
    const bin = managedBin(this.prefix(engineId, version), state.package, state.cli);
    if (!bin) return { ready: false, error: `${state.package} has no ${state.cli} command` };
    if (bin.kind === "stub") return { ready: false, path: bin.file, kind: "native-missing", error: "the native part did not install" };
    const copy = this.copyOf(engineId, state, version, true);
    const launch = copy && managedLaunch(copy, { platform: this.platform, env: process.env });
    if (!launch) return { ready: false, path: bin.file, kind: "native-missing", error: "the native part did not install" };
    const answer = describeRun(await this.run(launch, ["--version"], VERSION_MS), VERSION_MS);
    return answer.ok ? { ready: true, version: answer.detail } : { ready: false, path: bin.file, error: answer.detail };
  }

  /** A version installed: it goes on trial, first for this agent until its test says whether it stays. */
  begin(engineId: string, next: { cli: string; package: string; version: string; prefer: boolean }): void {
    const state = this.stateOf(engineId);
    if (state?.trial && state.trial !== next.version && state.trial !== state.current) this.remove(engineId, state.trial);
    this.save(engineId, { ...(state?.current ? { current: state.current } : {}), ...(state?.previous ? { previous: state.previous } : {}), cli: next.cli, package: next.package, trial: next.version, prefer: next.prefer });
  }

  /**
   * A test came back on the copy on trial. Passed, it becomes the one in use and
   * the one before is kept; failed, the one in use stays, or — with none yet —
   * the trial stays behind the person's own copy, for a test after signing in.
   */
  settle(engineId: string, ok: boolean): ManagedState | null {
    const state = this.stateOf(engineId);
    if (!state?.trial) return state;
    if (ok) {
      const previous = state.current && state.current !== state.trial ? state.current : state.previous;
      const next: ManagedState = { cli: state.cli, package: state.package, current: state.trial, ...(previous ? { previous } : {}), prefer: state.prefer };
      this.save(engineId, next);
      for (const version of this.versions(engineId)) if (version !== next.current && version !== next.previous) this.remove(engineId, version);
      return next;
    }
    if (state.current) {
      this.remove(engineId, state.trial);
      const next: ManagedState = { cli: state.cli, package: state.package, current: state.current, ...(state.previous ? { previous: state.previous } : {}), prefer: state.prefer };
      this.save(engineId, next);
      return next;
    }
    const next: ManagedState = { ...state, prefer: false, failed: true };
    this.save(engineId, next);
    return next;
  }

  /** A version whose install failed, unless it is one this agent uses. */
  discard(engineId: string, version: string): void {
    const state = this.stateOf(engineId);
    if (version !== state?.current && version !== state?.previous && version !== state?.trial) this.remove(engineId, version);
  }

  private versions(engineId: string): string[] {
    try {
      return fs.readdirSync(path.join(this.config.dir, folderName(engineId)), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private remove(engineId: string, version: string): void {
    fs.rmSync(this.prefix(engineId, version), { recursive: true, force: true });
  }
}

/** The JSON npm printed, past any warning lines before it. */
function jsonOf(text: string): unknown {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^[[{\d"]/.test(lines[i])) continue;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {}
  }
  return null;
}

const lastLine = (output: string) => output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
