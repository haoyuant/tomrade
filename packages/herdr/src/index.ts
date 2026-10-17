import { execFile } from "node:child_process";
import { Context, Service } from "cordis";
import type {} from "@tomradex/doctor";
import type { Check } from "@tomradex/doctor";
import { HerdrError, herdrCall, herdrSocketPath, herdrStream, type HerdrEvent } from "./client.js";
import { HERDR_WORDS } from "./words.js";

export { HerdrError, herdrCall, herdrSocketPath, herdrStream, type HerdrEvent } from "./client.js";

/** The herdr server answering on this machine's socket. */
export interface HerdrServer {
  version: string;
  protocol: number;
  socket: string;
}

/** How herdr reads the agent in a pane. */
export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** What herdr says about a pane Tomrade follows. */
export type HerdrPaneEvent =
  | { kind: "status"; paneId: string; status: HerdrStatus; agent: string | null }
  /** The pane's process ended, or the pane was closed: nothing runs there any more. */
  | { kind: "exited"; paneId: string };

declare module "cordis" {
  interface Context {
    herdr: Herdr;
  }
}

/** Where to get herdr; shown wherever it is missing. */
export const HERDR_INSTALL = "brew install herdr";

/** How long to wait before subscribing again after the stream ends; doubled each time it fails, up to the maximum. */
export const RECONNECT_MS = 2_000;
export const RECONNECT_MAX_MS = 60_000;

export interface HerdrConfig {
  /** The first wait before subscribing again; tests make it short. */
  reconnectMs?: number;
  /** The socket to use instead of the one herdr's variables and defaults name; tests point it at a fake. */
  socket?: string;
}

const STATUSES = new Set<string>(["idle", "working", "blocked", "done", "unknown"]);

/**
 * herdr on this machine — the terminal workspace manager coding agents run
 * in. Tomrade neither bundles nor starts it: when it is there, a ticket can
 * run in one of its panes and be followed there; when it is not, nothing
 * here is called.
 */
export class Herdr extends Service {
  static provide = "herdr";

  private readonly listeners = new Set<(event: HerdrPaneEvent) => void>();
  /** The panes being followed, each with its own status stream (herdr subscribes to status per pane). */
  private readonly watched = new Map<string, { stream: { close(): void } | null; timer: NodeJS.Timeout | null; delay: number; last: string | null }>();
  private global: { stream: { close(): void } | null; timer: NodeJS.Timeout | null; delay: number } | null = null;
  private disposed = false;
  private readonly reconnectMs: number;
  private readonly socket: string | null;

  constructor(ctx: Context, config: HerdrConfig = {}) {
    super(ctx, "herdr");
    this.reconnectMs = config.reconnectMs ?? RECONNECT_MS;
    this.socket = config.socket ?? null;
  }

  [Service.init]() {
    this.ctx.inject(["doctor"], (ctx) => ctx.doctor.check(this.check(ctx)));
    this.ctx.effect(() => () => {
      this.disposed = true;
      this.stopGlobal();
      for (const paneId of [...this.watched.keys()]) this.unwatch(paneId);
    });
  }

  socketPath(): string {
    return this.socket ?? herdrSocketPath();
  }

  /** The herdr CLI's version, or null when `herdr` is not on PATH. */
  installed(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile("herdr", ["--version"], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout).trim().replace(/^herdr\s+/, "") || null);
      });
    });
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

  /** One request to the server; a refusal is a `HerdrError` with herdr's own code. */
  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return herdrCall<T>(this.socketPath(), method, params);
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
   * A workspace of herdr's own for a command: made in the folder, labelled, with the
   * command typed into its shell. The workspace is not focused — the person is somewhere
   * else — and the pane is theirs to find. Null when herdr does not answer.
   */
  async launch(input: { cwd: string; label?: string; command: string }): Promise<{ paneId: string; workspaceId: string } | null> {
    try {
      const created = await this.call<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { cwd: input.cwd, ...(input.label ? { label: input.label } : {}), focus: false });
      const paneId = created.root_pane.pane_id;
      // Typed, with Enter: a newline in the text is not a keypress to herdr.
      await this.call("pane.send_input", { pane_id: paneId, text: input.command, keys: ["enter"] });
      return { paneId, workspaceId: created.workspace.workspace_id };
    } catch (err) {
      if (!(err instanceof HerdrError)) throw err;
      return null;
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
   * How herdr brings the pane's agent back after a restart of its own: the agent's session id,
   * and the command that resumes it — connected to Tomrade again, which herdr's own integrations
   * would not do. The first word must be a command on PATH.
   */
  async reportSession(paneId: string, agent: string, sessionId: string, resumeArgv: string[]): Promise<boolean> {
    return this.ok("pane.report_agent_session", { pane_id: paneId, source: "tomrade", agent, agent_session_id: sessionId, resume_argv: resumeArgv });
  }

  /** What herdr's sidebar shows on a workspace, as `name: value` tokens; null clears one. */
  async reportMetadata(workspaceId: string, tokens: Record<string, string | null>): Promise<boolean> {
    return this.ok("workspace.report_metadata", { workspace_id: workspaceId, source: "tomrade", tokens });
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

  /** Follow a pane's status: herdr tells it per pane, so each gets a subscription of its own. The returned function stops following it. */
  watch(paneId: string): () => void {
    if (this.watched.has(paneId)) return () => this.unwatch(paneId);
    this.watched.set(paneId, { stream: null, timer: null, delay: this.reconnectMs, last: null });
    this.subscribePane(paneId);
    return () => this.unwatch(paneId);
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
        this.ctx.logger.warn(`a herdr listener failed: ${err instanceof Error ? err.message : String(err)}`);
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
    const status = typeof event.data.agent_status === "string" && STATUSES.has(event.data.agent_status) ? (event.data.agent_status as HerdrStatus) : "unknown";
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

  /** The troubleshooter's line about herdr: there or not, never a problem in itself. */
  private check(ctx: Context): Check {
    return {
      id: "herdr",
      title: () => "herdr",
      run: async () => {
        const w = HERDR_WORDS(ctx.doctor.locale());
        const version = await this.installed();
        if (!version) return { state: "skip", line: w("notInstalled", { install: HERDR_INSTALL }) };
        const server = await this.server();
        if (!server) return { state: "ok", line: w("installedNotRunning", { version }), facts: { herdr: version } };
        return { state: "ok", line: w("running", { version: server.version, socket: server.socket }), facts: { herdr: server.version } };
      }
    };
  }
}

export default Herdr;
