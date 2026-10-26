import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "cordis";
import {
  contract,
  errorMessage,
  type Check,
  type CheckResult,
  type TerminalBridge,
  type TerminalLaunch,
  type TerminalMode,
  type TerminalPaneEvent,
  type TerminalPaneInfo,
  type TerminalProcess,
  type TerminalProvider,
  type TerminalRevive,
  type TerminalScrollPosition,
  type TerminalStream
} from "@tomradex/contracts";
import { hostCall, hostStream, openTerminal } from "./client.js";
import { pipePath, PtyHostError, type PaneInfo } from "./protocol.js";
import { defaultShell } from "./shell.js";
import { PTY_HOST_WORDS } from "./words.js";

export { hostCall } from "./client.js";
export { pipePath, PROTOCOL, PtyHostError } from "./protocol.js";
export { defaultShell, onPath } from "./shell.js";

declare module "cordis" {
  interface Context {
    terminals: TerminalProvider;
  }
}

export interface PtyHostConfig {
  /** The pipe to use instead of this user's; tests point it at one of their own. */
  pipe?: string;
  /** What keeps this instance's host apart from another Tomrade's on the machine: its data folder. */
  scope?: string;
  /** The binary the host runs on, as Node: Electron's own with ELECTRON_RUN_AS_NODE. */
  nodeBinary?: string;
  /** Where the host writes what it did. */
  logFile?: string;
  /** The app's version, which the host reports. */
  version?: string;
  reconnectMs?: number;
  startTimeoutMs?: number;
  /** How long a host with no terminal stays before it exits. */
  idleMs?: number;
}

/** How long to wait before subscribing again after the stream ends; doubled each time it fails, up to the maximum. */
export const RECONNECT_MS = 2_000;
export const RECONNECT_MAX_MS = 60_000;
export const START_TIMEOUT_MS = 10_000;
/** At most this many starts by `revive` within the window, so a host that keeps dying is not started over and over. */
export const REVIVE_LIMIT = 3;
export const REVIVE_WINDOW_MS = 5 * 60_000;
/** The size a pane starts at, until a window attaches and sizes it. */
const START_COLS = 120;
const START_ROWS = 32;

/** The ConPTY runtime node-pty loads on this machine's arch (`useConptyDll`): null when the build does not carry it. */
export function conptyRuntime(arch: string = process.arch): string | null {
  try {
    const dir = path.join(path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json")), "prebuilds", `win32-${arch}`);
    return ["conpty.node", "conpty/OpenConsole.exe", "conpty/conpty.dll"].every((file) => fs.existsSync(path.join(dir, file))) ? dir : null;
  } catch {
    return null;
  }
}

/** The environment a pane starts with: Tomrade's own, without Electron's switches or the host's settings. */
function paneEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string" && !e[0].startsWith("ELECTRON_") && !e[0].startsWith("TOMRADE_PTY_")));
}

/**
 * Tomrade's own terminal backend on native Windows, where herdr cannot attach:
 * a pty host it starts detached on demand (Electron's binary as Node, node-pty
 * over ConPTY), which keeps the terminals through a restart of the app and
 * exits when the last one closes. It speaks herdr's shapes behind the same
 * contract, so the Terminal window and code link run on it unchanged.
 */
export class PtyHost extends Service implements TerminalProvider {
  static provide = "terminals";

  readonly kind = "builtin" as const;
  private readonly pipe: string;
  private readonly reconnectMs: number;
  private readonly startTimeoutMs: number;
  private disposed = false;
  private starting: Promise<{ started: boolean } | null> | null = null;
  private revived: number[] = [];
  private reviving: Promise<TerminalRevive> | null = null;
  private readonly listeners = new Set<(event: TerminalPaneEvent) => void>();
  private readonly watched = new Map<string, Set<symbol>>();
  private global: { stream: { close(): void } | null; timer: NodeJS.Timeout | null; delay: number } | null = null;
  private readonly terminals = new Set<TerminalStream>();

  constructor(
    ctx: Context,
    private readonly config: PtyHostConfig = {}
  ) {
    super(ctx, "terminals");
    this.pipe = config.pipe ?? pipePath(config.scope ?? "");
    this.reconnectMs = config.reconnectMs ?? RECONNECT_MS;
    this.startTimeoutMs = config.startTimeoutMs ?? START_TIMEOUT_MS;
  }

  [Service.init]() {
    this.ctx.inject(["doctor"], (ctx) => contract(ctx, "doctor")?.check(this.check(ctx)));
    this.ctx.effect(() => () => {
      this.disposed = true;
      this.stopGlobal();
      // Only this app's views of the terminals: the host and its terminals go on without it.
      for (const terminal of [...this.terminals]) terminal.close();
    });
  }

  pipePath(): string {
    return this.pipe;
  }

  private call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return hostCall<T>(this.pipe, method, params, timeoutMs);
  }

  /** The host answering on the pipe, or null when none does. */
  async server(): Promise<{ version: string; protocol: number; pid: number } | null> {
    try {
      return await this.call<{ version: string; protocol: number; pid: number }>("ping", {}, 2000);
    } catch {
      return null;
    }
  }

  async installed(): Promise<string | null> {
    return process.platform === "win32" && conptyRuntime() ? (this.config.version ?? "0") : null;
  }

  async bridge(): Promise<TerminalBridge> {
    const version = await this.installed();
    // Not running is ready all the same: a launch starts the host.
    return version ? { state: "ready", version } : { state: "unsupported" };
  }

  async serverGone(): Promise<boolean> {
    return !(await this.server());
  }

  /** The host on the pipe: the one running, or one started now and ready once it answers. Starts at the same time share one. */
  private async ensureHost(): Promise<{ started: boolean } | null> {
    if (await this.server()) return { started: false };
    this.starting ??= this.startHost().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startHost(): Promise<{ started: boolean } | null> {
    if (this.disposed || !(await this.installed())) return null;
    if (await this.server()) return { started: false };
    const entry = fileURLToPath(new URL("./main.js", import.meta.url));
    let failed = false;
    try {
      // Detached and unreferenced: the terminals outlive the app by design, so quitting never stops the host.
      const child = spawn(this.config.nodeBinary ?? process.execPath, [entry], {
        cwd: os.homedir(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...paneEnv(),
          ELECTRON_RUN_AS_NODE: "1",
          TOMRADE_PTY_PIPE: this.pipe,
          TOMRADE_PTY_VERSION: this.config.version ?? "0",
          ...(this.config.logFile ? { TOMRADE_PTY_LOG: this.config.logFile } : {}),
          ...(this.config.idleMs ? { TOMRADE_PTY_IDLE_MS: String(this.config.idleMs) } : {})
        }
      });
      child.once("error", () => (failed = true));
      child.once("exit", (code) => (failed ||= code !== 0));
      child.unref();
    } catch {
      return null;
    }
    const deadline = Date.now() + this.startTimeoutMs;
    while (!failed && Date.now() < deadline) {
      if (await this.server()) {
        // Whoever follows the panes hears from this host now, not after their backoff.
        this.resubscribe();
        return { started: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.ctx.logger.warn(`the terminal host ${failed ? "did not start" : `did not answer within ${this.startTimeoutMs / 1000} s`}`);
    return null;
  }

  /** The host answering again after it went away. Its terminals died with it; the cells attach again and hear so. */
  revive(force = false): Promise<TerminalRevive> {
    this.reviving ??= this.reviveOnce(force).finally(() => {
      this.reviving = null;
    });
    return this.reviving;
  }

  private async reviveOnce(force: boolean): Promise<TerminalRevive> {
    if (await this.server()) return "running";
    if (!(await this.installed())) return "notInstalled";
    const now = Date.now();
    this.revived = this.revived.filter((at) => now - at < REVIVE_WINDOW_MS);
    if (!force && this.revived.length >= REVIVE_LIMIT) return "held";
    this.revived.push(now);
    const up = await this.ensureHost();
    return up ? (up.started ? "started" : "running") : "failed";
  }

  async launch(input: TerminalLaunch): Promise<{ paneId: string } | null> {
    const up = await this.ensureHost();
    if (!up) return null;
    const program = input.program ?? defaultShell(process.env);
    try {
      const { pane_id } = await this.call<{ pane_id: string }>("pane.launch", {
        cwd: input.cwd,
        file: program.file,
        args: program.args,
        // A program of its own runs instead of the shell the command would be typed into.
        ...(input.command && !input.program ? { command: input.command } : {}),
        ...(input.label ? { label: input.label } : {}),
        env: paneEnv(),
        cols: START_COLS,
        rows: START_ROWS
      });
      return { paneId: pane_id };
    } catch (err) {
      if (!(err instanceof PtyHostError)) throw err;
      this.ctx.logger.warn(`the terminal host did not open a terminal: ${err.message}`);
      return null;
    }
  }

  /** A live terminal of a pane. Refused with a PtyHostError: `notRunning` when the host is gone, `pane_not_found` when the pane is. */
  async terminal(paneId: string, opts: { mode?: TerminalMode; cols: number; rows: number }): Promise<TerminalStream> {
    if (this.disposed) throw new PtyHostError("closed", "the terminal host is gone");
    const stream = openTerminal(this.pipe, { paneId, mode: opts.mode ?? "control", cols: opts.cols, rows: opts.rows });
    try {
      await stream.attached;
    } catch (err) {
      stream.close();
      if (err instanceof PtyHostError && err.code === "unreachable") throw new PtyHostError("notRunning", "the terminal host is not running");
      throw err;
    }
    this.terminals.add(stream);
    stream.onClose(() => this.terminals.delete(stream));
    return stream;
  }

  /** A request whose answer is whether the host took it. */
  private async ok(method: string, params: Record<string, unknown>): Promise<boolean> {
    try {
      await this.call(method, params);
      return true;
    } catch (err) {
      if (!(err instanceof PtyHostError)) throw err;
      return false;
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    try {
      await this.call("pane.close", { pane_id: paneId }, 10_000);
      return true;
    } catch (err) {
      if (!(err instanceof PtyHostError)) throw err;
      // No host, no pane: its terminals ended with it.
      return err.code === "unreachable";
    }
  }

  async paneAlive(paneId: string): Promise<boolean | null> {
    try {
      await this.call("pane.get", { pane_id: paneId });
      return true;
    } catch (err) {
      if (!(err instanceof PtyHostError)) throw err;
      return err.code === "pane_not_found" ? false : null;
    }
  }

  /** The host reads no agents: a pane goes by the title its program set. */
  async panes(): Promise<TerminalPaneInfo[] | null> {
    try {
      const { panes } = await this.call<{ panes: PaneInfo[] }>("pane.list");
      return panes.map((p) => ({ paneId: p.pane_id, agent: null, agentSession: null, status: "unknown", title: p.title }));
    } catch {
      return null;
    }
  }

  async processes(): Promise<TerminalProcess[]> {
    return [];
  }

  /** Typed into the pane, then Enter a moment later, as a person would. */
  prompt(paneId: string, text: string): Promise<boolean> {
    return this.ok("pane.send_input", { pane_id: paneId, text, enter: true });
  }

  async readTail(paneId: string, lines = 20): Promise<string | null> {
    try {
      const { text } = await this.call<{ text: string }>("pane.read", { pane_id: paneId, lines });
      return text;
    } catch (err) {
      if (!(err instanceof PtyHostError)) throw err;
      return null;
    }
  }

  onScroll(paneId: string, listener: (scroll: TerminalScrollPosition) => void): () => void {
    let last = "";
    let stopped = false;
    const tell = (raw: unknown) => {
      const s = raw as PaneInfo["scroll"] | undefined;
      if (stopped || typeof s?.offset_from_bottom !== "number") return;
      const scroll = { offset: s.offset_from_bottom, max: s.max_offset_from_bottom, rows: s.viewport_rows };
      const key = `${scroll.offset}:${scroll.max}:${scroll.rows}`;
      if (key === last) return;
      last = key;
      listener(scroll);
    };
    const stream = hostStream(this.pipe, [{ type: "pane.scroll_changed", pane_id: paneId }], (event) => event.event === "pane.scroll_changed" && tell(event.data.scroll), () => undefined, () => {
      void this.call<{ pane: PaneInfo }>("pane.get", { pane_id: paneId }).then(({ pane }) => tell(pane.scroll), () => undefined);
    });
    return () => {
      stopped = true;
      stream.close();
    };
  }

  scrollTo(paneId: string, offset: number): Promise<boolean> {
    return this.ok("pane.scroll", { pane_id: paneId, offset_from_bottom: Math.max(0, Math.round(offset)) });
  }

  onPane(listener: (event: TerminalPaneEvent) => void): () => void {
    return this.ctx.effect(() => {
      this.listeners.add(listener);
      this.startGlobal();
      return () => {
        this.listeners.delete(listener);
        if (!this.listeners.size) this.stopGlobal();
      };
    }, "terminals.onPane");
  }

  /** The host tells every pane's end on one stream, so following a pane is only remembering it. */
  watch(paneId: string): () => void {
    const hold = Symbol(paneId);
    const holds = this.watched.get(paneId) ?? new Set<symbol>();
    holds.add(hold);
    this.watched.set(paneId, holds);
    return () => {
      const current = this.watched.get(paneId);
      if (!current?.delete(hold)) return;
      if (!current.size) this.watched.delete(paneId);
    };
  }

  watching(): string[] {
    return [...this.watched.keys()];
  }

  private exited(paneId: string): void {
    if (!this.watched.delete(paneId)) return;
    for (const listener of this.listeners) {
      try {
        listener({ kind: "exited", paneId });
      } catch (err) {
        this.ctx.logger.warn(`a terminals listener failed: ${errorMessage(err)}`);
      }
    }
  }

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

  /** A host just started: the stream waiting out its backoff subscribes now. */
  private resubscribe(): void {
    const global = this.global;
    if (!global || global.stream) return;
    if (global.timer) clearTimeout(global.timer);
    global.delay = this.reconnectMs;
    this.subscribeGlobal();
  }

  private subscribeGlobal(): void {
    const global = this.global;
    if (!global || this.disposed) return;
    global.timer = null;
    const stream = hostStream(this.pipe, [{ type: "pane.exited" }], (event) => {
      if (typeof event.data.pane_id === "string") this.exited(event.data.pane_id);
    }, (error) => {
      if (this.global !== global || global.stream !== stream) return;
      global.stream = null;
      global.delay = error ? Math.min(global.delay * 2, RECONNECT_MAX_MS) : this.reconnectMs;
      global.timer = setTimeout(() => this.subscribeGlobal(), global.delay);
      global.timer.unref?.();
    }, () => {
      global.delay = this.reconnectMs;
      // Back after a gap: a watched pane that went meanwhile is told now.
      for (const paneId of this.watched.keys()) void this.paneAlive(paneId).then((alive) => alive === false && this.exited(paneId));
    });
    global.stream = stream;
  }

  private check(ctx: Context): Check {
    return {
      id: "pty-host",
      title: () => "Terminal host",
      run: async (): Promise<CheckResult> => {
        const w = PTY_HOST_WORDS(contract(ctx, "doctor")?.locale());
        if (!(await this.installed())) return { state: "warn", line: w("missing", { arch: process.arch }) };
        const server = await this.server();
        if (!server) return { state: "ok", line: w("idle") };
        const panes = (await this.panes())?.length ?? 0;
        return { state: "ok", line: w("running", { pid: String(server.pid), panes: String(panes) }), facts: { ptyHost: `${server.version} · protocol ${server.protocol}` } };
      }
    };
  }
}

export default PtyHost;
