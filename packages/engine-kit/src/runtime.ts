import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { isSuspended, type TurnInput, type TurnIO, type TurnResult } from "@tomradex/agent";
import type {} from "@tomradex/mcp";

export interface Runtime {
  readonly token: string;
  readonly cwd: string;
  alive: boolean;
  busy: boolean;
  session?: string;
  close(): void;
  turn(input: TurnInput, io: TurnIO, warm: boolean): Promise<TurnResult>;
}

/**
 * Warm runtimes per thread. `limit` bounds the idle ones: a turn is never refused for a slot,
 * and once turns finish the least recently used idle runtimes past it are closed.
 * Session history belongs to the provider on disk.
 */
export class RuntimePool<T extends Runtime> {
  private entries = new Map<string, { runtime: T; fingerprint: string; timer?: NodeJS.Timeout }>();
  constructor(private readonly limit = 3, private readonly idleMs = 5 * 60_000) {}

  async run(key: string, fingerprint: string, create: () => T, input: TurnInput, io: TurnIO): Promise<TurnResult> {
    let entry = this.entries.get(key);
    if (entry?.runtime.busy) throw new Error("A turn is already active on this runtime");
    if (entry && (!entry.runtime.alive || entry.fingerprint !== fingerprint || entry.runtime.session !== io.resume)) {
      this.evict(key); entry = undefined;
    }
    const warm = !!entry;
    entry ??= { runtime: create(), fingerprint };
    clearTimeout(entry.timer);
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.runtime.busy = true;
    try { return await entry.runtime.turn(input, io, warm); }
    finally {
      entry.runtime.busy = false;
      if (!entry.runtime.alive) this.evict(key);
      else entry.timer = setTimeout(() => this.evict(key), this.idleMs).unref();
      this.trim();
    }
  }

  /** Close the least recently used idle runtimes past `limit`. */
  private trim(): void {
    const idle = [...this.entries].filter(([, e]) => !e.runtime.busy);
    for (const [key] of idle.slice(0, Math.max(0, idle.length - this.limit))) this.evict(key);
  }

  evict(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(key);
    entry.runtime.close();
  }
  close(): void { for (const key of this.entries.keys()) this.evict(key); }
}

/** Hash secrets; never persist or log the fingerprint inputs. */
export function runtimeFingerprint(input: TurnInput, io: TurnIO, url: string | null): string {
  return createHash("sha256").update(JSON.stringify({
    cwd: input.cwd, purpose: input.purpose, permissionMode: input.permissionMode, options: input.options,
    env: input.env, url, tools: io.tools.describe()
  })).digest("hex");
}

/**
 * The folder a thread's agent runs in when the thread has no worktree: stable for the logical thread, including a
 * cold resume after idle eviction. A CLI resuming the thread's session from a terminal starts in the same folder,
 * since Claude Code keeps its sessions by folder.
 */
export function agentWorkspace(projectId: string, threadId: string): string {
  return path.join(os.tmpdir(), "tomrade-agent-workspaces", createHash("sha256").update(`${projectId}:${threadId}`).digest("hex"));
}

export function runtimeDirectory(input: TurnInput): { token: string; cwd: string; dispose(): void } {
  const dir = agentWorkspace(input.projectId, input.threadId);
  if (!input.cwd) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { token: randomUUID(), cwd: input.cwd ?? dir, dispose() {} };
}

export function bindTurn(ctx: Context, token: string, io: TurnIO, input: TurnInput) {
  let asked = false;
  let active = true;
  const inflight = new Set<Promise<unknown>>();
  const unbind = ctx.mcp.bindRun(token, {
    author: io.run.author, projectId: input.projectId,
    async execute(name, args) {
      if (!active || io.signal.aborted) throw new Error("This turn is no longer active");
      const task = io.tools.execute(name, args);
      inflight.add(task);
      try {
        const result = await task;
        if (isSuspended(result)) {
          asked = true;
          return { question_posted: result.question.text, next: result.note };
        }
        return result;
      } finally { inflight.delete(task); }
    }
  });
  return {
    asked: () => asked,
    async release() {
      active = false; unbind();
      // Complete already admitted writes before the run is marked done.
      await Promise.allSettled(inflight);
    }
  };
}

/** Producer remains open between user turns; closing releases a waiting reader. */
export class MessageQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiter?: (value: IteratorResult<T>) => void;
  private closed = false;
  push(value: T): void {
    if (this.closed) throw new Error("Agent input stream is closed");
    if (this.waiter) { const done = this.waiter; this.waiter = undefined; done({ value, done: false }); }
    else this.values.push(value);
  }
  close(): void { this.closed = true; this.values = []; this.waiter?.({ value: undefined, done: true }); this.waiter = undefined; }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => {
      if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false });
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => { this.waiter = resolve; });
    } };
  }
}
