import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { lineSplitter } from "@tomradex/engine-claude-code";

type Json = Record<string, any>;

/** ACP's error code for "sign in first". */
export const AUTH_REQUIRED = -32000;

/** An error the agent answered a request with. */
export class AcpError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = "AcpError";
  }
}

export interface AcpPeer {
  /** `session/update` and anything else the agent tells without asking. */
  notification(method: string, params: Json): void;
  /** A request from the agent; what it resolves to is the answer, an AcpError the refusal. */
  request(method: string, params: Json): Promise<unknown>;
  closed(error: Error): void;
}

/** JSON-RPC 2.0 over newline-delimited stdio with one ACP agent process. */
export class AcpConnection {
  private seq = 0;
  private pending = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void; timer?: NodeJS.Timeout }>();
  private open = true;
  private stderr = "";

  constructor(private child: ChildProcessWithoutNullStreams, private peer: AcpPeer, private name: string) {
    child.stdout.on("data", lineSplitter((line) => this.receive(line)));
    child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    child.on("error", (error) => this.close(error));
    child.stdin.on("error", (error) => this.close(error));
    child.on("close", (code) => this.close(new Error(`${name} exited with ${code}${this.stderr.trim() ? `: ${this.stderr.trim().slice(-400)}` : ""}`)));
  }

  get alive(): boolean { return this.open; }

  /** What the agent last wrote to stderr, for a failure's details. */
  get stderrTail(): string { return this.stderr; }

  /** `timeoutMs` 0 waits as long as the agent works — a prompt runs until its turn ends. A null result stays null. */
  request(method: string, params: Json, timeoutMs = 60_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.open) { reject(new Error(`${this.name} is not running`)); return; }
      const id = ++this.seq;
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name} did not answer ${method} within ${timeoutMs / 1000}s`)); }, timeoutMs).unref() : undefined;
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    if (this.open) this.write({ jsonrpc: "2.0", method, params });
  }

  close(error = new Error(`${this.name} closed`)): void {
    if (!this.open) return;
    this.open = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.peer.closed(error);
  }

  private write(message: Json): void {
    if (!this.child.stdin.writable) { this.close(new Error(`${this.name} stopped reading`)); return; }
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(line: string): void {
    let msg: Json;
    // Agents log to stderr, but a stray line on stdout is not worth the connection.
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === undefined) {
      const pending = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      if (msg.error) pending.reject(new AcpError(msg.error.message ?? `${this.name} refused ${pending.method}`, msg.error.code, msg.error.data));
      else pending.resolve(msg.result ?? null);
    } else if (msg.id !== undefined && msg.id !== null) {
      const id = msg.id;
      this.peer.request(msg.method, msg.params ?? {}).then(
        (result) => { if (this.open) this.write({ jsonrpc: "2.0", id, result: result ?? null }); },
        (error) => { if (this.open) this.write({ jsonrpc: "2.0", id, error: { code: error instanceof AcpError ? error.code ?? -32603 : -32603, message: error instanceof Error ? error.message : String(error) } }); }
      );
    } else this.peer.notification(msg.method, msg.params ?? {});
  }
}
