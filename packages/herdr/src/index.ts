import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { findCommand } from "@tomradex/engine-kit";
import type {} from "@tomradex/ipc";
import { HerdrError, herdrCall, herdrSocketPath, herdrStream, type HerdrEvent } from "./client.js";
import { openTerminal, type OpenedTerminal, type TerminalFrame, type TerminalMode, type TerminalMouse, type TerminalScroll, type TerminalStream } from "./terminal.js";
import { HERDR_WORDS } from "./words.js";
import { type Check, type CheckResult, contract, errorMessage, type TerminalBridge, type TerminalInput, type TerminalPaneEvent, type TerminalPaneInfo, type TerminalProcess, type TerminalProvider, type TerminalRevive, type TerminalScrollPosition, type TerminalStatus, type TerminalWorkspaceRef } from "@tomradex/contracts";

export { HerdrError, herdrCall, herdrSocketPath, herdrStream, type HerdrEvent } from "./client.js";
export * from "./terminal.js";

/** The herdr server answering on this machine's socket. */
export interface HerdrServer {
  version: string;
  protocol: number;
  socket: string;
}

/** How herdr reads the agent in a pane. */
export type HerdrStatus = TerminalStatus;

/** What herdr says about a pane Tomrade follows. */
export type HerdrPaneEvent = TerminalPaneEvent;

/** A pane's view in its scrollback, in rows: `offset` above the bottom, at most `max`, `rows` on screen. */
export type HerdrScroll = TerminalScrollPosition;

const scrollOf = (raw: unknown): HerdrScroll | null => {
  const s = raw as { offset_from_bottom?: unknown; max_offset_from_bottom?: unknown; viewport_rows?: unknown } | null;
  if (typeof s?.offset_from_bottom !== "number" || typeof s.max_offset_from_bottom !== "number" || typeof s.viewport_rows !== "number") return null;
  return { offset: s.offset_from_bottom, max: s.max_offset_from_bottom, rows: s.viewport_rows };
};

declare module "cordis" {
  interface Context {
    herdr: Herdr;
    terminals: TerminalProvider;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "herdr.bridge": () => HerdrBridge;
    /** A live terminal of a pane for this window; its frames come as `herdr.terminalFrame` under the returned id. */
    "herdr.terminalOpen": (paneId: string, opts: { mode?: TerminalMode; cols: number; rows: number }) => string;
    "herdr.terminalInput": (id: string, data: string | Uint8Array) => void;
    "herdr.terminalResize": (id: string, cols: number, rows: number) => void;
    "herdr.terminalScroll": (id: string, scroll: TerminalScroll) => void;
    "herdr.terminalMouse": (id: string, mouse: TerminalMouse) => void;
    "herdr.terminalClose": (id: string) => void;
  }
  interface Broadcasts {
    "herdr.terminalFrame": (id: string, frame: TerminalFrame) => void;
    "herdr.terminalClosed": (id: string, reason: string | null) => void;
  }
}

/** Where to get herdr; shown wherever it is missing. */
export const HERDR_INSTALL = "brew install herdr";

/** herdr's own installer, for macOS and Linux without Homebrew: it puts herdr in ~/.local/bin. */
export const HERDR_SCRIPT_INSTALL = "curl -fsSL https://herdr.dev/install.sh | sh";

/** herdr's own install guide, for a machine neither installer suits. */
export const HERDR_GUIDE = "https://herdr.dev/docs/install/";

/** How herdr installs on a machine: Homebrew's formula where brew is, herdr's installer on other Macs and Linux, otherwise only the guide. */
export interface HerdrInstall {
  command: string | null;
  guide: string;
}

export const herdrInstall = (found: { brew: boolean; platform?: NodeJS.Platform }): HerdrInstall => {
  const platform = found.platform ?? process.platform;
  const command = found.brew ? HERDR_INSTALL : platform === "darwin" || platform === "linux" ? HERDR_SCRIPT_INSTALL : null;
  return { command, guide: HERDR_GUIDE };
};

/** The oldest herdr whose terminal sessions take everything a window sends them (mouse events came in 0.9.2). */
export const BRIDGE_MIN_VERSION = "0.9.2";

/** Whether herdr can hand Tomrade a live terminal, and what to do when it cannot (`unsupported`: herdr's direct attach does not run on native Windows). */
export type HerdrBridge = TerminalBridge;

/** Compares dotted versions by their numbers; a suffix such as `-preview` is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

/** Where Tomrade keeps a project's herdr workspace: its sessions open there, one tab each. */
export type HerdrWorkspaceRef = TerminalWorkspaceRef;

/** How long to wait before subscribing again after the stream ends; doubled each time it fails, up to the maximum. */
export const RECONNECT_MS = 2_000;
export const RECONNECT_MAX_MS = 60_000;
/** How long a server Tomrade started has to answer before the launch goes elsewhere. */
export const START_TIMEOUT_MS = 10_000;
/** At most this many starts by `revive` within the window, so a server that keeps dying is not started over and over. */
export const REVIVE_LIMIT = 3;
export const REVIVE_WINDOW_MS = 5 * 60_000;
/** The longest a pane's next control session waits for the one before it to settle once that one's herdr has started, so a herdr that never answers holds nothing up. */
export const CONTROL_SETTLE_MS = 2_000;
/** How long a reading of herdr's own clients holds: the process list is read at most this often. */
export const CLIENTS_TTL_MS = 5_000;

/**
 * Whether `ps ax -o tty=,args=` shows a client of herdr's own: herdr on a terminal, run bare, on a named or remote
 * session, or as `session attach` — not its server, Tomrade's control sessions, or a one-off CLI call.
 */
export function herdrClientIn(ps: string): boolean {
  return ps.split("\n").some((line) => {
    const [tty, cmd, ...args] = line.trim().split(/\s+/);
    if (!tty || !cmd || tty === "?" || tty === "??" || path.basename(cmd) !== "herdr") return false;
    if (!args.length) return true;
    if (args[0] === "session") return args[1] === "attach";
    return (args[0] === "--session" || args[0] === "--remote") && args.length === 2;
  });
}

/** What herdr reads off one pane: the agent it detected there, that agent's own session id, how it reads that agent, and the title on the pane. */
export type HerdrPaneInfo = TerminalPaneInfo;

/** How `revive` went: the server answers (already, or started now), did not come up, is held by the limit, or herdr is not here. */
export type HerdrRevive = TerminalRevive;

export interface HerdrConfig {
  /** The first wait before subscribing again; tests make it short. */
  reconnectMs?: number;
  /** The socket to use instead of the one herdr's variables and defaults name; tests point it at a fake. */
  socket?: string;
  /** The herdr CLI to run instead of the one found on this machine; tests point it at a stand-in. */
  bin?: string;
  /** A machine-local file remembering that Tomrade has started herdr's server before, so the person is told only the first time. */
  statePath?: string;
  startTimeoutMs?: number;
  /** How many starts `revive` makes within REVIVE_WINDOW_MS; tests make it small. */
  reviveLimit?: number;
}

/** What Tomrade remembers about herdr on this machine. */
interface HerdrState {
  serverStartedAt?: number;
  /** Each project's workspace, by project id. */
  workspaces?: Record<string, string>;
}

/** A server answering on the socket, and whether Tomrade just started it. */
interface HerdrUp {
  server: HerdrServer;
  started: boolean;
}

const STATUSES = new Set<string>(["idle", "working", "blocked", "done", "unknown"]);
const statusOf = (value: unknown): HerdrStatus => (typeof value === "string" && STATUSES.has(value) ? (value as HerdrStatus) : "unknown");

/**
 * herdr on this machine — the terminal workspace manager coding agents run
 * in. Tomrade does not bundle it: when it is installed, a ticket can run in
 * one of its panes and be followed there — its server started headless for a
 * launch if it is not running, and never stopped by Tomrade; when it is not
 * installed, nothing here is called.
 */
export class Herdr extends Service implements TerminalProvider {
  static provide = "herdr";

  readonly kind = "herdr" as const;

  private readonly listeners = new Set<(event: HerdrPaneEvent) => void>();
  /** The panes being followed, each with its own status stream (herdr subscribes to status per pane), and who follows it. */
  private readonly watched = new Map<string, { stream: { close(): void } | null; timer: NodeJS.Timeout | null; delay: number; last: string | null; holds: Set<symbol> }>();
  private global: { stream: { close(): void } | null; timer: NodeJS.Timeout | null; delay: number } | null = null;
  private disposed = false;
  private readonly reconnectMs: number;
  private readonly socket: string | null;
  private readonly bin: string | null;
  private readonly statePath: string | null;
  private readonly startTimeoutMs: number;
  private readonly reviveLimit: number;
  /** The server start under way, shared by every launch that wants one meanwhile. */
  private starting: Promise<HerdrUp | null> | null = null;
  /** When `revive` started the server, oldest first. */
  private revived: number[] = [];
  private reviving: Promise<HerdrRevive> | null = null;
  private toldStarted = false;
  /** The last reading of herdr's own clients, for `CLIENTS_TTL_MS`. */
  private clientsRead: { at: number; attached: Promise<boolean> } | null = null;
  /** The terminals open now, closed with the service. */
  private readonly terminals = new Set<TerminalStream>();
  /** Each pane's latest control session until it settles: attached, refused or ended, or `CONTROL_SETTLE_MS` after its herdr started. */
  private readonly controlling = new Map<string, Promise<void>>();
  /** A project workspace being made, shared by launches into it meanwhile. */
  private readonly making = new Map<string, Promise<void>>();

  constructor(ctx: Context, config: HerdrConfig = {}) {
    super(ctx, "herdr");
    this.reconnectMs = config.reconnectMs ?? RECONNECT_MS;
    this.socket = config.socket ?? null;
    this.bin = config.bin ?? null;
    this.statePath = config.statePath ?? null;
    this.startTimeoutMs = config.startTimeoutMs ?? START_TIMEOUT_MS;
    this.reviveLimit = config.reviveLimit ?? REVIVE_LIMIT;
  }

  [Service.init]() {
    // The terminal backend everywhere herdr can attach; native Windows has its own (`@tomradex/pty-host`).
    if (process.platform !== "win32") this.ctx.provide("terminals", this);
    this.ctx.inject(["doctor"], (ctx) => contract(ctx, "doctor")?.check(this.check(ctx)));
    this.ctx.inject(["ipc"], (ctx) => this.serveTerminals(ctx));
    this.ctx.effect(() => () => {
      this.disposed = true;
      this.stopGlobal();
      for (const paneId of [...this.watched.keys()]) this.unwatch(paneId);
      for (const terminal of [...this.terminals]) terminal.close();
    });
  }

  socketPath(): string {
    return this.socket ?? herdrSocketPath();
  }

  /** Where the herdr CLI is — the first on PATH or in the folders installers use — or null when this machine has none. */
  binary(): string | null {
    return this.bin || findCommand("herdr");
  }

  /** The herdr CLI's version, or null when herdr is not installed. */
  installed(): Promise<string | null> {
    const bin = this.binary();
    if (!bin) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout).trim().replace(/^herdr\s+/, "") || null);
      });
    });
  }

  /**
   * Whether a herdr client of its own runs on this machine, to show what `show` brings forward. herdr's API lists no
   * clients, so the process list says; false where there is none to read.
   */
  clientAttached(): Promise<boolean> {
    const now = Date.now();
    if (this.clientsRead && now - this.clientsRead.at < CLIENTS_TTL_MS) return this.clientsRead.attached;
    const attached =
      process.platform === "win32"
        ? Promise.resolve(false)
        : new Promise<boolean>((resolve) => execFile("ps", ["ax", "-o", "tty=,args="], { timeout: 3000, maxBuffer: 8 << 20 }, (err, stdout) => resolve(!err && herdrClientIn(String(stdout)))));
    this.clientsRead = { at: now, attached };
    return attached;
  }

  /** The running server, or null when none answers on the socket. */
  async server(): Promise<HerdrServer | null> {
    const socket = this.socketPath();
    try {
      const pong = await herdrCall<{ version?: string; protocol?: number }>(socket, "ping", {}, 2000);
      return { version: pong.version ?? "", protocol: pong.protocol ?? 0, socket };
    } catch {
      return null;
    }
  }

  /**
   * A server on the socket: the one running, or — herdr installed but not running — `herdr server`
   * started headless and detached on the same socket, ready once it answers ping. Launches at the
   * same time share one start. Null when herdr is not installed or did not come up in time.
   */
  private async ensureServer(): Promise<HerdrUp | null> {
    const running = await this.server();
    if (running) return { server: running, started: false };
    this.starting ??= this.startServer().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * The server answering again after it went away, for a window showing its panes: started as a launch starts it,
   * and herdr restores its panes, same ids, and resumes their agents. Shares a start already under way. Unless
   * `force` (the person asked), at most `reviveLimit` starts in REVIVE_WINDOW_MS. Never stops a server.
   */
  revive(force = false): Promise<HerdrRevive> {
    this.reviving ??= this.reviveOnce(force).finally(() => {
      this.reviving = null;
    });
    return this.reviving;
  }

  private async reviveOnce(force: boolean): Promise<HerdrRevive> {
    if (await this.server()) return "running";
    if (!(await this.installed())) return "notInstalled";
    const now = Date.now();
    this.revived = this.revived.filter((at) => now - at < REVIVE_WINDOW_MS);
    if (!force && this.revived.length >= this.reviveLimit) return "held";
    this.revived.push(now);
    const up = await this.ensureServer();
    return up ? (up.started ? "started" : "running") : "failed";
  }

  private async startServer(): Promise<HerdrUp | null> {
    const bin = this.binary();
    if (!bin || this.disposed) return null;
    // A start that finished between this caller's ping and now.
    const running = await this.server();
    if (running) return { server: running, started: false };
    let failed = false;
    try {
      // Detached and unreferenced: herdr's panes outlive Tomrade by design, so quitting never stops it.
      // Panes inherit the server's environment; Electron's own switches are not theirs.
      const child = spawn(bin, ["server"], { cwd: os.homedir(), env: this.cliEnv(), detached: true, stdio: "ignore" });
      child.once("error", () => (failed = true));
      child.once("exit", (code) => (failed ||= code !== 0));
      child.unref();
    } catch {
      return null;
    }
    const deadline = Date.now() + this.startTimeoutMs;
    while (!failed && Date.now() < deadline) {
      const server = await this.server();
      if (server) return { server, started: true };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.ctx.logger.warn(`herdr server ${failed ? "did not start" : `did not answer within ${this.startTimeoutMs / 1000} s`} (${bin})`);
    return null;
  }

  /** True the first time ever, on this machine, that a launch started herdr's server: the person is told then, once. */
  private firstStart(): boolean {
    if (this.toldStarted) return false;
    this.toldStarted = true;
    if (!this.statePath) return true;
    if (this.readState().serverStartedAt) return false;
    this.writeState({ serverStartedAt: Date.now() });
    return true;
  }

  private memory: HerdrState = {};

  private readState(): HerdrState {
    if (!this.statePath) return this.memory;
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8")) as HerdrState;
    } catch {
      return {};
    }
  }

  private writeState(patch: HerdrState): void {
    const next = { ...this.readState(), ...patch };
    if (!this.statePath) {
      this.memory = next;
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(next));
    } catch (err) {
      this.ctx.logger.warn(`could not write herdr's state for Tomrade: ${errorMessage(err)}`);
    }
  }

  /** Whether a live terminal can be had, and the fix when it cannot; never starts anything. */
  async bridge(): Promise<HerdrBridge> {
    if (process.platform === "win32") return { state: "unsupported" };
    const version = await this.installed();
    if (!version) return { state: "notInstalled" };
    if (compareVersions(version, BRIDGE_MIN_VERSION) < 0) return { state: "tooOld", version, need: BRIDGE_MIN_VERSION, fix: this.upgradeCommand() };
    const server = await this.server();
    if (!server) return { state: "notRunning", version };
    // The CLI that bridges talks the server's private protocol, which only the same build is sure to speak.
    if (server.version && server.version !== version) return { state: "stale", version, server: server.version, fix: "herdr server stop" };
    return { state: "ready", version };
  }

  /** How this herdr is upgraded: through Homebrew when that is where it came from, else herdr's own updater. */
  upgradeCommand(): string {
    const bin = this.binary();
    let real = bin ?? "";
    try {
      if (bin) real = fs.realpathSync(bin);
    } catch {
      // a broken link reads as not Homebrew's
    }
    return /\/(Cellar|homebrew|linuxbrew)\//.test(real) ? "brew upgrade herdr" : "herdr update";
  }

  /** The environment the CLI runs in: the socket Tomrade uses, and none of Electron's own switches. */
  private cliEnv(): NodeJS.ProcessEnv {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ELECTRON_")));
    return this.socket ? { ...env, HERDR_SOCKET_PATH: this.socket } : env;
  }

  /**
   * A live terminal of a pane: `control` takes its input and size from any other owner, `observe`
   * watches beside others. Refused with a HerdrError named for the bridge's state when it is not ready.
   */
  async terminal(paneId: string, opts: { mode?: TerminalMode; cols: number; rows: number }): Promise<TerminalStream> {
    const mode = opts.mode ?? "control";
    // A control session takes the pane from whoever holds it when it attaches, even one let go before then: one
    // attaching after a newer one leaves the pane to nobody. So each waits for the pane's previous one to settle.
    let settle = () => {};
    const previous = mode === "control" ? this.controlling.get(paneId) : undefined;
    if (mode === "control") {
      const mine = new Promise<void>((resolve) => (settle = resolve));
      this.controlling.set(paneId, mine);
      void mine.then(() => this.controlling.get(paneId) === mine && this.controlling.delete(paneId));
    }
    let stream: OpenedTerminal;
    try {
      // Its time to settle starts with its herdr: the checks before that, slow on a loaded machine, must not use it up.
      if (previous) await previous;
      const bridge = await this.bridge();
      const bin = this.binary();
      if (bridge.state !== "ready" || !bin) throw new HerdrError(bridge.state, `herdr cannot stream ${paneId}: ${bridge.state}`);
      if (this.disposed) throw new HerdrError("closed", "herdr is gone");
      stream = openTerminal({ bin, paneId, mode, cols: opts.cols, rows: opts.rows, env: this.cliEnv() });
    } catch (err) {
      settle();
      throw err;
    }
    void Promise.race([stream.settled, new Promise((resolve) => setTimeout(resolve, CONTROL_SETTLE_MS).unref())]).then(settle);
    // herdr knows whether the pane's program asked for the kitty keyboard protocol; its stream only takes bytes.
    if (mode === "control") stream.key = (key) => void this.call("pane.send_input", { pane_id: paneId, keys: [key] }).catch(() => stream.input("\r"));
    this.terminals.add(stream);
    stream.onClose(() => this.terminals.delete(stream));
    return stream;
  }

  /** One request to the server; a refusal is a `HerdrError` with herdr's own code. */
  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return herdrCall<T>(this.socketPath(), method, params);
  }

  /** Installed, but its server does not answer: a stream that ended went with the server, not its pane. */
  async serverGone(): Promise<boolean> {
    return !!this.binary() && !(await this.server());
  }

  /** The processes herdr sees in a pane's foreground; none when it does not answer. */
  async processes(paneId: string): Promise<TerminalProcess[]> {
    return this.call<{ process_info: { foreground_processes?: TerminalProcess[] } }>("pane.process_info", { pane_id: paneId }).then((r) => r.process_info.foreground_processes ?? [], () => []);
  }

  /** Bring a pane to the front in herdr — its workspace, then the pane itself. False when herdr cannot: gone, or the pane with it. */
  async focus(paneId: string): Promise<boolean> {
    try {
      const { pane } = await this.call<{ pane: { workspace_id: string } }>("pane.get", { pane_id: paneId });
      await this.call("workspace.focus", { workspace_id: pane.workspace_id });
      await this.call("pane.focus", { pane_id: paneId });
      return true;
    } catch (err) {
      if (!(err instanceof HerdrError)) throw err;
      return false;
    }
  }

  /**
   * Bring a pane to the front and say so in herdr's window. "noClient" when no herdr client is
   * attached to see it: herdr's API lists no clients, but a toast with nobody to show it answers
   * `no_foreground_client`. Null when herdr or the pane is gone.
   */
  async show(paneId: string, title: string): Promise<"shown" | "noClient" | null> {
    if (!(await this.focus(paneId))) return null;
    try {
      const { reason } = await this.call<{ reason?: string }>("notification.show", { title: title.slice(0, 80), body: "", sound: "none" });
      return reason === "no_foreground_client" ? "noClient" : "shown";
    } catch (err) {
      if (!(err instanceof HerdrError)) throw err;
      return "shown";
    }
  }

  /**
   * A pane for a command, with the command typed into its shell (a plain shell without one), on a server started for it when
   * none runs (see `ensureServer`). With `workspace`, the pane is a new tab — labelled `label` — in
   * that project's workspace, made the first time and again when herdr no longer has it; without,
   * a workspace of its own labelled `label`. Nothing is focused — the person is somewhere else — and
   * the pane is theirs to find. `startedServer` is "first" the first time ever Tomrade started the
   * server here. Null when herdr does not answer.
   */
  async launch(input: { cwd: string; label?: string; command?: string; workspace?: HerdrWorkspaceRef }): Promise<{ paneId: string; workspaceId: string; startedServer?: "first" | "again" } | null> {
    const up = await this.ensureServer();
    if (!up) return null;
    try {
      const pane = input.workspace ? await this.tabIn(input.workspace, input.cwd, input.label) : await this.ownWorkspace(input.cwd, input.label);
      // Typed, with Enter: a newline in the text is not a keypress to herdr.
      if (input.command) await this.call("pane.send_input", { pane_id: pane.paneId, text: input.command, keys: ["enter"] });
      return { ...pane, ...(up.started ? { startedServer: this.firstStart() ? ("first" as const) : ("again" as const) } : {}) };
    } catch (err) {
      if (!(err instanceof HerdrError)) throw err;
      return null;
    }
  }

  private async ownWorkspace(cwd: string, label: string | undefined): Promise<{ paneId: string; workspaceId: string }> {
    const created = await this.call<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { cwd, ...(label ? { label } : {}), focus: false });
    return { paneId: created.root_pane.pane_id, workspaceId: created.workspace.workspace_id };
  }

  /** A new tab in the project's workspace; the workspace's own first tab when it was just made. */
  private async tabIn(ref: HerdrWorkspaceRef, cwd: string, label: string | undefined): Promise<{ paneId: string; workspaceId: string }> {
    const known = await this.projectWorkspace(ref);
    if (known) {
      try {
        const created = await this.call<{ root_pane: { pane_id: string } }>("tab.create", { workspace_id: known, cwd, ...(label ? { label } : {}), focus: false });
        return { paneId: created.root_pane.pane_id, workspaceId: known };
      } catch (err) {
        if (!(err instanceof HerdrError) || err.code !== "workspace_not_found") throw err;
      }
    }
    // Launches into the same project at once share one new workspace.
    const pending = this.making.get(ref.key);
    if (pending) {
      await pending;
      return this.tabIn(ref, cwd, label);
    }
    // Remembered before anyone waiting hears it is made.
    const making = this.call<{ workspace: { workspace_id: string }; tab?: { tab_id?: string }; root_pane: { pane_id: string } }>("workspace.create", { cwd, label: ref.label, focus: false }).then((created) => {
      this.writeState({ workspaces: { ...this.readState().workspaces, [ref.key]: created.workspace.workspace_id } });
      return created;
    });
    this.making.set(ref.key, making.then(() => undefined, () => undefined));
    try {
      const created = await making;
      // The workspace's first tab is this session's: named for it, like the tabs after it.
      if (label && created.tab?.tab_id) await this.ok("tab.rename", { tab_id: created.tab.tab_id, label });
      return { paneId: created.root_pane.pane_id, workspaceId: created.workspace.workspace_id };
    } finally {
      this.making.delete(ref.key);
    }
  }

  /** The project's workspace herdr still has under the project's name; null when it has to be made. */
  private async projectWorkspace(ref: HerdrWorkspaceRef): Promise<string | null> {
    const id = this.readState().workspaces?.[ref.key];
    if (!id) return null;
    try {
      const { workspace } = await this.call<{ workspace: { label?: string } }>("workspace.get", { workspace_id: id });
      // herdr gives a closed workspace's id to a later one: only ours, by its name, is taken.
      return workspace.label === ref.label ? id : null;
    } catch (err) {
      if (!(err instanceof HerdrError) || err.code !== "workspace_not_found") throw err;
      return null;
    }
  }

  /** Close a pane and end what runs in it. True once it is gone, also when it already was; false when herdr does not answer. */
  async closePane(paneId: string): Promise<boolean> {
    try {
      await this.call("pane.close", { pane_id: paneId });
      return true;
    } catch (err) {
      if (!(err instanceof HerdrError)) throw err;
      return err.code === "pane_not_found";
    }
  }

  /** Whether the pane is still there; null when herdr itself does not answer, which says nothing about the pane. */
  async paneAlive(paneId: string): Promise<boolean | null> {
    try {
      await this.call("pane.get", { pane_id: paneId });
      return true;
    } catch (err) {
      if (!(err instanceof HerdrError)) throw err;
      return err.code === "pane_not_found" ? false : null;
    }
  }

  /** Every pane herdr has, as it reads them; null when herdr does not answer. */
  async panes(): Promise<HerdrPaneInfo[] | null> {
    try {
      const { panes } = await this.call<{ panes: Array<{ pane_id: string; agent?: string | null; agent_session?: { kind?: string; value?: string } | null; agent_status?: string; terminal_title_stripped?: string | null }> }>("pane.list");
      return panes.map((p) => ({
        paneId: p.pane_id,
        agent: p.agent ?? null,
        agentSession: p.agent_session?.kind === "id" && p.agent_session.value ? p.agent_session.value : null,
        status: statusOf(p.agent_status),
        title: p.terminal_title_stripped?.trim() || null
      }));
    } catch {
      return null;
    }
  }

  /** Hand text to the agent in a pane, as a prompt. False when no agent is there, or it is blocked on something else. */
  async prompt(paneId: string, text: string): Promise<boolean> {
    try {
      await this.call("agent.prompt", { target: paneId, text });
      return true;
    } catch (err) {
      if (!(err instanceof HerdrError)) throw err;
      return false;
    }
  }

  /**
   * Keystrokes into a pane through herdr's pane surface, which works before an agent is detected and takes the pane
   * from nobody — unlike a control session (TOM-412). The text goes first, then the keys. False when herdr would not.
   */
  sendInput(paneId: string, input: TerminalInput): Promise<boolean> {
    if (!input.text && !input.keys?.length) return Promise.resolve(false);
    return this.ok("pane.send_input", { pane_id: paneId, ...(input.text ? { text: input.text } : {}), ...(input.keys?.length ? { keys: input.keys } : {}) });
  }

  /**
   * How herdr brings the pane's agent back after a restart of its own: the agent's session id,
   * and the command that resumes it — connected to Tomrade again, which herdr's own integrations
   * would not do. The first word must be a command on PATH.
   */
  async reportSession(paneId: string, agent: string, sessionId: string, resumeArgv: string[]): Promise<boolean> {
    return this.ok("pane.report_agent_session", { pane_id: paneId, source: "tomrade", agent, agent_session_id: sessionId, resume_argv: resumeArgv });
  }

  /** What herdr's sidebar shows on a pane, as `name: value` tokens; null clears one. Per pane, since a project's sessions share a workspace. */
  async reportMetadata(paneId: string, tokens: Record<string, string | null>): Promise<boolean> {
    return this.ok("pane.report_metadata", { pane_id: paneId, source: "tomrade", tokens });
  }

  /** A toast in herdr's own window, for the person at the terminal. */
  async notify(title: string, body = "", sound: "none" | "done" | "request" = "request"): Promise<boolean> {
    return this.ok("notification.show", { title: title.slice(0, 80), body: body.slice(0, 240), sound });
  }

  /** A request whose only answer that matters is whether herdr took it. */
  private async ok(method: string, params: Record<string, unknown>): Promise<boolean> {
    try {
      await this.call(method, params);
      return true;
    } catch (err) {
      if (!(err instanceof HerdrError)) throw err;
      return false;
    }
  }

  /** The last lines on a pane's screen, styling stripped; null when the pane is gone. */
  async readTail(paneId: string, lines = 20): Promise<string | null> {
    try {
      const { read } = await this.call<{ read: { text?: string } }>("pane.read", { pane_id: paneId, source: "recent", lines });
      return read.text ?? "";
    } catch (err) {
      if (!(err instanceof HerdrError)) throw err;
      return null;
    }
  }

  /**
   * Where a pane's view is in its scrollback: now, then on every change (output, scrolls, resizes, typing that snaps
   * it back to the bottom). Lives until the returned function is called or herdr ends the subscription; a terminal
   * attached again after that listens again.
   */
  onScroll(paneId: string, listener: (scroll: HerdrScroll) => void): () => void {
    let last = "";
    let stopped = false;
    const tell = (raw: unknown) => {
      const scroll = scrollOf(raw);
      const key = scroll ? `${scroll.offset}:${scroll.max}:${scroll.rows}` : last;
      if (stopped || !scroll || key === last) return;
      last = key;
      listener(scroll);
    };
    const stream = herdrStream(this.socketPath(), [{ type: "pane.scroll_changed", pane_id: paneId }], (event) => event.event === "pane.scroll_changed" && tell(event.data.scroll), () => undefined, () => {
      void this.call<{ pane: { scroll?: unknown } }>("pane.get", { pane_id: paneId }).then(({ pane }) => tell(pane.scroll), () => undefined);
    });
    return () => {
      stopped = true;
      stream.close();
    };
  }

  /** Put a pane's view this many rows above the bottom of its scrollback. False when herdr would not. */
  async scrollTo(paneId: string, offset: number): Promise<boolean> {
    return this.ok("pane.scroll", { pane_id: paneId, offset_from_bottom: Math.max(0, Math.round(offset)) });
  }

  /** Hear about the panes being watched. The stream to herdr lives while someone listens, and comes back when herdr does. */
  onPane(listener: (event: HerdrPaneEvent) => void): () => void {
    return this.ctx.effect(() => {
      this.listeners.add(listener);
      this.startGlobal();
      return () => {
        this.listeners.delete(listener);
        if (!this.listeners.size) this.stopGlobal();
      };
    }, "herdr.onPane");
  }

  /**
   * Follow a pane's status: herdr tells it per pane, so each gets a subscription of its own. The returned function
   * lets this hold go; the pane is followed while anyone holds it.
   */
  watch(paneId: string): () => void {
    const hold = Symbol(paneId);
    const entry = this.watched.get(paneId);
    if (entry) entry.holds.add(hold);
    else {
      this.watched.set(paneId, { stream: null, timer: null, delay: this.reconnectMs, last: null, holds: new Set([hold]) });
      this.subscribePane(paneId);
    }
    return () => {
      const current = this.watched.get(paneId);
      if (!current?.holds.delete(hold)) return;
      if (!current.holds.size) this.unwatch(paneId);
    };
  }

  watching(): string[] {
    return [...this.watched.keys()];
  }

  private unwatch(paneId: string): void {
    const entry = this.watched.get(paneId);
    if (!entry) return;
    this.watched.delete(paneId);
    entry.stream?.close();
    if (entry.timer) clearTimeout(entry.timer);
  }

  private emit(event: HerdrPaneEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.ctx.logger.warn(`a herdr listener failed: ${errorMessage(err)}`);
      }
    }
  }

  private subscribePane(paneId: string): void {
    const entry = this.watched.get(paneId);
    if (!entry || this.disposed) return;
    entry.timer = null;
    entry.stream = herdrStream(this.socketPath(), [{ type: "pane.agent_status_changed", pane_id: paneId }], (event) => this.onPaneEvent(paneId, event), (error) => {
      const current = this.watched.get(paneId);
      if (!current || current.stream !== entry.stream) return;
      current.stream = null;
      // Refused for a pane herdr no longer has: that pane is over.
      if (error && (error.code === "pane_not_found" || error.code === "invalid_request")) {
        this.unwatch(paneId);
        this.emit({ kind: "exited", paneId });
        return;
      }
      current.delay = error ? Math.min(current.delay * 2, RECONNECT_MAX_MS) : this.reconnectMs;
      current.timer = setTimeout(() => this.subscribePane(paneId), current.delay);
      current.timer.unref?.();
    });
    // Subscribed: what the pane says right now, so a change made while nobody listened is not missed.
    void this.call<{ agent: { agent_status?: string; agent?: string | null } }>("agent.get", { target: paneId }).then(({ agent }) => {
      const current = this.watched.get(paneId);
      if (current) {
        current.delay = this.reconnectMs;
        this.onPaneEvent(paneId, { event: "pane.agent_status_changed", data: { pane_id: paneId, agent_status: agent.agent_status, agent: agent.agent ?? null } });
      }
    }, () => undefined);
  }

  private onPaneEvent(paneId: string, event: HerdrEvent): void {
    const entry = this.watched.get(paneId);
    if (!entry || event.event !== "pane.agent_status_changed") return;
    const status = statusOf(event.data.agent_status);
    const agent = typeof event.data.agent === "string" ? event.data.agent : null;
    const key = `${agent ?? ""}:${status}`;
    if (entry.last === key) return;
    entry.last = key;
    this.emit({ kind: "status", paneId, status, agent });
  }

  /** Pane ends are told for every pane at once; one stream hears them all. */
  private startGlobal(): void {
    if (this.global || this.disposed) return;
    this.global = { stream: null, timer: null, delay: this.reconnectMs };
    this.subscribeGlobal();
  }

  private stopGlobal(): void {
    const global = this.global;
    if (!global) return;
    this.global = null;
    global.stream?.close();
    if (global.timer) clearTimeout(global.timer);
  }

  private subscribeGlobal(): void {
    const global = this.global;
    if (!global || this.disposed) return;
    global.timer = null;
    const stream = herdrStream(this.socketPath(), [{ type: "pane.exited" }, { type: "pane.closed" }], (event) => {
      const paneId = typeof event.data.pane_id === "string" ? event.data.pane_id : null;
      if (!paneId || !this.watched.has(paneId)) return;
      this.unwatch(paneId);
      this.emit({ kind: "exited", paneId });
    }, (error) => {
      if (this.global !== global || global.stream !== stream) return;
      global.stream = null;
      global.delay = error ? Math.min(global.delay * 2, RECONNECT_MAX_MS) : this.reconnectMs;
      global.timer = setTimeout(() => this.subscribeGlobal(), global.delay);
      global.timer.unref?.();
    }, () => {
      global.delay = this.reconnectMs;
      // Back after a gap: a watched pane that went while nobody listened is reported now.
      for (const paneId of this.watched.keys()) {
        void this.paneAlive(paneId).then((alive) => {
          if (alive === false && this.watched.has(paneId)) {
            this.unwatch(paneId);
            this.emit({ kind: "exited", paneId });
          }
        });
      }
    });
    global.stream = stream;
  }

  /** Terminals for the app's windows, by an id of their own; they close with the window channel. */
  private serveTerminals(ctx: Context): void {
    const open = new Map<string, TerminalStream>();
    let next = 0;
    const of = (id: string) => open.get(id);
    ctx.ipc.handle("herdr.bridge", () => this.bridge());
    ctx.ipc.handle("herdr.terminalOpen", async (paneId, opts) => {
      const stream = await this.terminal(paneId, opts);
      const id = `t${++next}`;
      open.set(id, stream);
      stream.onFrame((frame) => ctx.ipc.send("herdr.terminalFrame", id, frame));
      stream.onClose((reason) => {
        open.delete(id);
        ctx.ipc.send("herdr.terminalClosed", id, reason);
      });
      return id;
    });
    ctx.ipc.handle("herdr.terminalInput", (id, data) => of(id)?.input(data));
    ctx.ipc.handle("herdr.terminalResize", (id, cols, rows) => of(id)?.resize(cols, rows));
    ctx.ipc.handle("herdr.terminalScroll", (id, scroll) => of(id)?.scroll(scroll));
    ctx.ipc.handle("herdr.terminalMouse", (id, mouse) => of(id)?.mouse(mouse));
    ctx.ipc.handle("herdr.terminalClose", (id) => of(id)?.close());
    ctx.effect(() => () => {
      for (const stream of [...open.values()]) stream.close();
    });
  }

  /** The troubleshooter's line about herdr: there or not, never a problem in itself. */
  private check(ctx: Context): Check {
    return {
      id: "herdr",
      title: () => "herdr",
      run: async (): Promise<CheckResult> => {
        const w = HERDR_WORDS(contract(ctx, "doctor")?.locale());
        const version = await this.installed();
        if (!version) return { state: "skip", line: w("notInstalled") };
        // Only a live terminal needs these; everything else herdr does for Tomrade still works.
        if (compareVersions(version, BRIDGE_MIN_VERSION) < 0) return { state: "warn", line: w("tooOld", { version, need: BRIDGE_MIN_VERSION, fix: this.upgradeCommand() }), facts: { herdr: version } };
        const server = await this.server();
        if (!server) return { state: "ok", line: w("installedNotRunning", { version }), facts: { herdr: version } };
        if (server.version && server.version !== version) return { state: "warn", line: w("stale", { version, server: server.version, fix: "herdr server stop" }), facts: { herdr: version, herdrServer: server.version } };
        return { state: "ok", line: w("running", { version: server.version, socket: server.socket }), facts: { herdr: server.version } };
      }
    };
  }
}

export default Herdr;
