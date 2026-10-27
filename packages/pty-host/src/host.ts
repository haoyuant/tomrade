import net from "node:net";
import { agentIn, descendants, shortCommand, titleStatus, type ProcessRow } from "./agents.js";
import { clampSize, frameLine, line, lineReader, PROTOCOL, type AttachParams, type LaunchParams, type PaneInfo, type ProcessInfo, type Request, type TerminalCommand } from "./protocol.js";
import { keyBytes } from "./keys.js";
import { Pane, type Attachment, type Pty, type ScrollState } from "./pane.js";

/** Starts a program on a pseudo-terminal. */
export type SpawnPty = (file: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => Pty;

export interface HostOptions {
  spawn: SpawnPty;
  /** The shell a pane runs when it is given no program. */
  shell: () => { file: string; args: string[] };
  /** Ends a pane's process and everything it started. */
  killTree: (pane: Pane) => Promise<void>;
  version: string;
  /** How long the host stays with no pane before it exits; it exits when its last terminal closes. */
  idleMs: number;
  onIdle: () => void;
  log?: (line: string) => void;
  scrollback?: number;
  /** How long typed text waits before its Enter, so a program that reads a fast burst as a paste still takes the Enter as one. */
  enterDelayMs?: number;
  /** Reads the machine's process table, for what runs in each pane; without it the host names no agent. */
  scan?: () => Promise<ProcessRow[]>;
  scanTiming?: Partial<ScanTiming>;
}

export interface ScanTiming {
  /** Scans are at least this far apart. */
  minMs: number;
  /** A read finding the table older than this has it read again, answering from the old one meanwhile. */
  staleMs: number;
  /** How soon after a pane opens or its title changes the table is read again. */
  soonMs: number;
}

export const SCAN_TIMING: ScanTiming = { minMs: 3_000, staleMs: 5_000, soonMs: 1_000 };

type Subscription = { type: string; pane_id?: string };

class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * The pty host: a process of its own, detached from Tomrade, holding every
 * terminal the person opened so they outlive a restart of the app. It answers
 * one pipe in herdr's shapes, and exits once it has had no pane for `idleMs`.
 */
export class Host {
  readonly panes = new Map<string, Pane>();
  private readonly subscribers = new Set<{ subs: Subscription[]; socket: net.Socket }>();
  private next = 0;
  private readonly prefix = `p${Date.now().toString(36)}`;
  private idle: NodeJS.Timeout | null = null;
  private table: { rows: ProcessRow[]; at: number } | null = null;
  private scanning: Promise<void> | null = null;
  private lastScan = 0;
  private soon: NodeJS.Timeout | null = null;
  private readonly timing: ScanTiming;

  constructor(private readonly opts: HostOptions) {
    this.timing = { ...SCAN_TIMING, ...opts.scanTiming };
    this.armIdle();
  }

  /** One scan at a time, never one while no pane is open; a scan that fails keeps the table there was. */
  private rescan(): Promise<void> {
    if (!this.opts.scan || !this.panes.size) return Promise.resolve();
    this.scanning ??= (async () => {
      this.lastScan = Date.now();
      try {
        this.table = { rows: await this.opts.scan!(), at: Date.now() };
      } catch (err) {
        this.opts.log?.(`reading the process table failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  /** A read of what runs in the panes: a table gone stale is read again behind it. */
  private touchTable(): void {
    if (!this.table || Date.now() - this.table.at > this.timing.staleMs) this.scanSoon(0);
  }

  /** A scan a moment from now (once the last one is far enough behind); calls meanwhile share it. */
  private scanSoon(delay = this.timing.soonMs): void {
    if (!this.opts.scan || this.soon) return;
    const wait = Math.max(delay, this.lastScan + this.timing.minMs - Date.now());
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.rescan();
    }, wait);
    this.soon.unref?.();
  }

  /** Waits for the scan running now or about to; for tests. */
  async settled(): Promise<void> {
    while (this.soon || this.scanning) {
      if (this.scanning) await this.scanning;
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private processesOf(pane: Pane): { root: ProcessRow | undefined; below: ProcessRow[] } {
    const rows = this.table?.rows ?? [];
    return { root: rows.find((r) => r.pid === pane.pid), below: descendants(rows, pane.pid) };
  }

  /** A pane as `pane.get` and `pane.list` give it, with the agent the process table shows in it. */
  private info(pane: Pane): PaneInfo {
    const { root, below } = this.processesOf(pane);
    const agent = agentIn(root, below);
    return { ...pane.info(), agent, agent_status: titleStatus(agent, pane.title) };
  }

  private processInfo(pane: Pane): ProcessInfo {
    return { foreground_processes: this.processesOf(pane).below.map((r) => ({ pid: r.pid, name: r.name, cmdline: shortCommand(r) })) };
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = this.panes.size ? null : setTimeout(() => this.opts.onIdle(), this.opts.idleMs);
  }

  /** One client connection: requests until it closes, or a subscription or a terminal for as long as it lives. */
  connection(socket: net.Socket): void {
    socket.setEncoding("utf8");
    let stream: ((line: string) => void) | null = null;
    const reply = (id: string, result: unknown) => socket.writable && socket.write(line({ id, result }));
    const fail = (id: string, err: unknown) => {
      const e = err instanceof RequestError ? err : new RequestError("error", err instanceof Error ? err.message : String(err));
      if (socket.writable) socket.write(line({ id, error: { code: e.code, message: e.message } }));
    };
    socket.on("data", lineReader((text) => {
      if (stream) return stream(text);
      let request: Request;
      try {
        request = JSON.parse(text) as Request;
      } catch {
        return fail("", new RequestError("invalid_request", "not JSON"));
      }
      const id = String(request.id ?? "");
      const params = request.params ?? {};
      if (request.method === "events.subscribe") {
        const subs = Array.isArray(params.subscriptions) ? (params.subscriptions as Subscription[]) : [];
        const entry = { subs, socket };
        this.subscribers.add(entry);
        socket.once("close", () => this.subscribers.delete(entry));
        stream = () => undefined;
        return reply(id, { type: "subscribed" });
      }
      if (request.method === "terminal.attach") {
        try {
          // Answered once the pane has it, so nothing the window sends after the answer finds it not there yet.
          stream = this.attach(socket, params as unknown as AttachParams, () => reply(id, { type: "attached" }), (err) => fail(id, err));
        } catch (err) {
          fail(id, err);
        }
        return;
      }
      void this.handle(request.method, params).then((result) => reply(id, result), (err: unknown) => fail(id, err));
    }));
    socket.on("error", () => undefined);
  }

  private pane(params: Record<string, unknown>): Pane {
    const pane = this.panes.get(String(params.pane_id ?? ""));
    if (!pane) throw new RequestError("pane_not_found", `no pane ${String(params.pane_id)}`);
    return pane;
  }

  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "ping":
        return { version: this.opts.version, protocol: PROTOCOL, pid: process.pid };
      case "pane.launch":
        return { pane_id: this.launch(params as unknown as LaunchParams).id };
      case "pane.get":
        this.touchTable();
        return { pane: this.info(this.pane(params)) };
      case "pane.list":
        this.touchTable();
        return { panes: [...this.panes.values()].map((p) => this.info(p)) };
      case "pane.process_info":
        this.touchTable();
        return { process_info: this.processInfo(this.pane(params)) };
      case "pane.close": {
        const pane = this.panes.get(String(params.pane_id ?? ""));
        if (pane) await this.close(pane);
        return {};
      }
      case "pane.send_input": {
        const pane = this.pane(params);
        // Every key is checked before anything is typed, as herdr does: a name this host does not know types nothing.
        const keys = (Array.isArray(params.keys) ? params.keys : []).map((name) => [String(name), keyBytes(String(name))] as const);
        const unknown = keys.find(([, bytes]) => bytes === null);
        if (unknown) throw new RequestError("invalid_request", `unknown key ${unknown[0]}`);
        const text = String(params.text ?? "");
        pane.input(text);
        // Typed text waits before its keys, so a program reading a fast burst as a paste still takes them as keys.
        const press = () => {
          for (const [, bytes] of keys) pane.input(bytes!);
          if (params.enter === true) pane.input("\r");
        };
        if (!keys.length && params.enter !== true) return {};
        if (text || params.enter === true) setTimeout(press, this.opts.enterDelayMs ?? 150);
        else press();
        return {};
      }
      case "pane.read":
        return { text: this.pane(params).tail(Number(params.lines) || 20) };
      case "pane.scroll":
        this.pane(params).scrollTo(Number(params.offset_from_bottom) || 0);
        return {};
      default:
        throw new RequestError("unknown_method", `no method ${method}`);
    }
  }

  launch(params: LaunchParams): Pane {
    if (typeof params.cwd !== "string" || !params.cwd) throw new RequestError("invalid_request", "a pane needs a cwd");
    const id = `${this.prefix}-${++this.next}`;
    const shell = this.opts.shell();
    const file = params.file ?? shell.file;
    const args = params.file ? (params.args ?? []) : shell.args;
    const cols = clampSize(params.cols ?? 120);
    const rows = clampSize(params.rows ?? 32);
    // The hooks of an agent started in the pane send this, so its session folds into the pane (herdr's variable, which they already read).
    const env = { ...(params.env ?? {}), HERDR_PANE_ID: id };
    const pty = this.opts.spawn(file, args, { cwd: params.cwd, env, cols, rows });
    const pane = new Pane(id, pty, params.cwd, params.label ?? null, cols, rows, { onScroll: (p, s) => this.scrolled(p, s), onExit: (p) => this.exited(p), onTitle: () => this.scanSoon() }, this.opts.scrollback);
    this.panes.set(id, pane);
    this.armIdle();
    this.scanSoon();
    if (params.command) pane.input(`${params.command}\r`);
    this.opts.log?.(`pane ${id}: ${file} ${args.join(" ")} (pid ${pty.pid})`);
    return pane;
  }

  /** Ends the pane's whole process tree; resolves once the pane is gone. */
  async close(pane: Pane): Promise<void> {
    if (!this.panes.has(pane.id)) return;
    const gone = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.panes.has(pane.id)) return;
        clearInterval(check);
        resolve();
      }, 25);
    });
    await this.opts.killTree(pane).catch((err: unknown) => this.opts.log?.(`closing ${pane.id}: ${err instanceof Error ? err.message : String(err)}`));
    // A process that would not end is let go all the same: the pane is closed for everyone.
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (this.panes.has(pane.id)) this.exited(pane);
  }

  private exited(pane: Pane): void {
    if (this.panes.get(pane.id) !== pane) return;
    this.panes.delete(pane.id);
    pane.end();
    this.emit("pane.exited", { pane_id: pane.id });
    pane.dispose();
    this.opts.log?.(`pane ${pane.id} ended`);
    this.armIdle();
  }

  private scrolled(pane: Pane, s: ScrollState): void {
    this.emit("pane.scroll_changed", { pane_id: pane.id, scroll: { offset_from_bottom: s.offset, max_offset_from_bottom: s.max, viewport_rows: s.rows } });
  }

  private emit(event: string, data: { pane_id: string } & Record<string, unknown>): void {
    for (const { subs, socket } of this.subscribers) {
      if (!subs.some((s) => s.type === event && (!s.pane_id || s.pane_id === data.pane_id))) continue;
      if (socket.writable) socket.write(line({ event, data }));
    }
  }

  /** A terminal on this connection: frames out, commands in, until either side closes. */
  private attach(socket: net.Socket, params: AttachParams, ready: () => void, refuse: (err: RequestError) => void): (text: string) => void {
    const pane = this.pane(params as unknown as Record<string, unknown>);
    const mode = params.mode === "observe" ? "observe" : "control";
    let open = true;
    let answered = false;
    const attachment: Attachment = {
      mode,
      send: (frame) => {
        if (open && socket.writable) socket.write(line(frameLine(frame)));
      },
      close: (reason) => {
        if (!open) return;
        open = false;
        // Ended before it was answered: the pane is gone, said as the answer.
        if (!answered) return refuse(new RequestError("pane_not_found", `pane ${pane.id} ended`));
        if (socket.writable) socket.end(line({ type: "terminal.closed", reason }));
      }
    };
    socket.once("close", () => {
      open = false;
      pane.detach(attachment);
    });
    pane.attach(attachment, params.cols, params.rows, () => {
      answered = true;
      ready();
    });
    return (text) => {
      let command: TerminalCommand;
      try {
        command = JSON.parse(text) as TerminalCommand;
      } catch {
        return;
      }
      if (command.type === "terminal.release") {
        pane.detach(attachment);
        open = false;
        socket.end();
        return;
      }
      // Only the one in control types, sizes, scrolls and clicks; an observer's are dropped.
      if (!pane.controls(attachment)) return;
      if (command.type === "terminal.input") pane.input(command.bytes ? Buffer.from(command.bytes, "base64").toString("utf8") : (command.text ?? ""));
      else if (command.type === "terminal.resize") pane.resize(command.cols, command.rows);
      else if (command.type === "terminal.scroll") pane.wheel(command);
      else if (command.type === "terminal.mouse") pane.mouse(command);
    };
  }

  /** Every pane ended, for a host that is going away. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.panes.values()].map((p) => this.close(p)));
    if (this.idle) clearTimeout(this.idle);
    if (this.soon) clearTimeout(this.soon);
    this.soon = null;
  }
}

/** Serves a host on a pipe; resolves once it listens, rejects when the pipe is taken. */
export function serve(host: Host, pipe: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => host.connection(socket));
    server.once("error", reject);
    server.listen(pipe, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
