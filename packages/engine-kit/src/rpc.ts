import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { lineSplitter } from "./cli.js";
import { KIT_WORDS } from "./words.js";

type Json = Record<string, any>;
type Id = string | number;

/** What a process last wrote to stderr is kept up to this, for a failure's details. */
export const STDERR_CAP = 2000;

/** An error the other side answered a request with; also what a request handler throws to refuse one. */
export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

/** One line from the other side, as its protocol means it. */
export type RpcMessage =
  | { kind: "response"; id: Id; result?: unknown; error?: { message?: string; code?: number; data?: unknown } }
  | { kind: "request"; id: Id; method: string; params: Json }
  | { kind: "notification"; method: string; params: Json };

/** How one protocol frames its lines. */
export interface RpcDialect {
  id(seq: number): Id;
  request(id: Id, method: string, params: Json): Json;
  notify(method: string, params: Json): Json;
  /** Null for a line the protocol does not know. */
  read(msg: Json): RpcMessage | null;
  reply(id: Id, result: unknown): Json;
  /** Absent when the protocol cannot refuse a request: a handler that fails then ends the connection. */
  refuse?(id: Id, code: number, message: string): Json;
}

/**
 * JSON-RPC over lines: 2.0 with its version tag (ACP), or the lite form
 * without it (Codex app-server). `empty` is what a request answered with no
 * result resolves to.
 */
export function jsonRpc(opts: { version?: boolean; empty?: () => unknown } = {}): RpcDialect {
  const tag = opts.version ? { jsonrpc: "2.0" } : {};
  const empty = opts.empty ?? (() => null);
  return {
    id: (seq) => seq,
    request: (id, method, params) => ({ ...tag, id, method, params }),
    notify: (method, params) => ({ ...tag, method, params }),
    read: (msg) => {
      if (!msg.method) {
        if (msg.id === undefined || msg.id === null) return null;
        return msg.error ? { kind: "response", id: msg.id, error: msg.error } : { kind: "response", id: msg.id, result: msg.result ?? empty() };
      }
      if (msg.id !== undefined && msg.id !== null) return { kind: "request", id: msg.id, method: msg.method, params: msg.params ?? {} };
      return { kind: "notification", method: msg.method, params: msg.params ?? {} };
    },
    reply: (id, result) => ({ ...tag, id, result: result ?? null }),
    refuse: (id, code, message) => ({ ...tag, id, error: { code, message } })
  };
}

export interface PeerOptions {
  /** Who is on the other side, as errors name it. */
  name: string;
  dialect: RpcDialect;
  /** How long a request waits for its answer unless it says otherwise; 0 waits as long as the other side works. */
  timeoutMs?: number;
  /** A request handler that fails with anything but an RpcError: refused (the default) or the connection ended. */
  handlerFailure?: "refuse" | "close";
  locale?: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/**
 * Requests and notifications both ways over one process's newline-delimited
 * stdio. Every open request is rejected once the connection closes; the
 * process itself belongs to whoever spawned it.
 */
export class JsonLinePeer {
  private seq = 0;
  private pending = new Map<Id, { method: string; resolve(value: any): void; reject(error: Error): void; timer?: NodeJS.Timeout }>();
  private open = true;
  private stderr = "";
  private words;
  private requestHandler?: (method: string, params: Json) => unknown;
  private notificationHandler?: (method: string, params: Json) => void;
  private closeHandler?: (error: Error) => void;

  constructor(private child: ChildProcessWithoutNullStreams, private opts: PeerOptions) {
    this.words = KIT_WORDS(opts.locale);
    child.stdout.on("data", lineSplitter((line) => {
      try { this.receive(line); } catch (error) { this.close(asError(error)); }
    }));
    child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_CAP); });
    child.on("error", (error) => this.close(error));
    child.stdin.on("error", (error) => this.close(error));
    child.on("close", (code) => {
      const said = this.stderr.trim();
      this.close(new Error(`${this.words("exited", { name: opts.name, code: String(code) })}${said ? `: ${said.slice(-400)}` : ""}`));
    });
  }

  get alive(): boolean { return this.open; }

  /** What the other side last wrote to stderr, for a failure's details. */
  get stderrTail(): string { return this.stderr; }

  /** What answers the other side's requests: its result is the answer, a thrown RpcError the refusal. */
  onRequest(handler: (method: string, params: Json) => unknown): this { this.requestHandler = handler; return this; }
  onNotification(handler: (method: string, params: Json) => void): this { this.notificationHandler = handler; return this; }
  /** Once, with why the connection ended. */
  onClose(handler: (error: Error) => void): this { this.closeHandler = handler; return this; }

  request(method: string, params: Json = {}, timeoutMs = this.opts.timeoutMs ?? 60_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const name = this.opts.name;
      if (!this.open) { reject(new Error(this.words("notRunning", { name }))); return; }
      const id = this.opts.dialect.id(++this.seq);
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.words("noAnswer", { name, method, seconds: timeoutMs / 1000 })));
      }, timeoutMs).unref() : undefined;
      this.pending.set(id, { method, resolve, reject, timer });
      this.write(this.opts.dialect.request(id, method, params));
    });
  }

  notify(method: string, params: Json = {}): void {
    if (this.open) this.write(this.opts.dialect.notify(method, params));
  }

  close(error = new Error(this.words("closed", { name: this.opts.name }))): void {
    if (!this.open) return;
    this.open = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.closeHandler?.(error);
  }

  private write(message: Json): void {
    if (!this.child.stdin.writable) { this.close(new Error(this.words("stoppedReading", { name: this.opts.name }))); return; }
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(line: string): void {
    let msg: Json;
    // Agents log to stderr, but a stray line on stdout is not worth the connection.
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const read = this.opts.dialect.read(msg);
    if (!read) return;
    if (read.kind === "response") {
      const pending = this.pending.get(read.id);
      if (!pending) return;
      this.pending.delete(read.id); clearTimeout(pending.timer);
      if (read.error) pending.reject(new RpcError(read.error.message ?? this.words("refused", { name: this.opts.name, method: pending.method }), read.error.code, read.error.data));
      else pending.resolve(read.result);
    } else if (read.kind === "request") this.answer(read.id, read.method, read.params);
    else this.notificationHandler?.(read.method, read.params);
  }

  private answer(id: Id, method: string, params: Json): void {
    const { dialect } = this.opts;
    const handler = this.requestHandler;
    Promise.resolve()
      .then(() => (handler ? handler(method, params) : Promise.reject(new RpcError(`Method not found: ${method}`, -32601))))
      .then(
        (result) => { if (this.open) this.write(dialect.reply(id, result)); },
        (error) => {
          if (!this.open) return;
          if (dialect.refuse && (error instanceof RpcError || this.opts.handlerFailure !== "close")) this.write(dialect.refuse(id, error instanceof RpcError ? error.code ?? -32603 : -32603, messageOf(error)));
          else this.close(asError(error));
        }
      );
  }
}
