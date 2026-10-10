import { describe, it, expect, vi } from "vitest";
import { RuntimePool, MessageQueue, type Runtime } from "../src/runtime.js";
import type { TurnInput, TurnIO } from "@tomradex/agent";

export const input = (id = "thread"): TurnInput => ({ threadId: id, projectId: "project", purpose: "backlog", input: { kind: "text", text: "hello" }, messages: [], cards: [], brief: null, pending: null, options: {} });
export const io = (resume?: string): TurnIO => ({ resume, emit() {}, delta() {}, progress() {}, signal: new AbortController().signal,
  tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
  run: { id: "run", threadId: "thread", projectId: "project", author: "ai:codex", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } });

describe("bounded thread runtimes", () => {
  it("reuses a live thread, invalidates changed credentials/config, and evicts the least-recent idle runtime", async () => {
    let created = 0;
    const closed: number[] = [];
    const create = (): Runtime => {
      const n = ++created;
      return { token: String(n), cwd: "/tmp", alive: true, busy: false,
        close() { closed.push(n); this.alive = false; },
        async turn(_input, _io, warm) { this.session = "session"; return { stop: "end", resume: this.session, metrics: { transport: "sdk", runtime: warm ? "warm" : "cold" } }; } };
    };
    const pool = new RuntimePool(1, 1000);
    try {
      await pool.run("one", "env-a", create, input(), io());
      expect((await pool.run("one", "env-a", create, input(), io("session"))).metrics?.runtime).toBe("warm");
      expect(created).toBe(1);
      await pool.run("one", "env-b", create, input(), io("session"));
      expect(closed).toEqual([1]);
      await pool.run("two", "env-b", create, input(), io());
      expect(closed).toEqual([1, 2]);
    } finally { pool.close(); }
    expect(closed).toEqual([1, 2, 3]);
  });

  it("does not evict a busy runtime; TTL closes an idle one", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    let release!: () => void;
    const runtime: Runtime = { token: "x", cwd: "/tmp", alive: true, busy: false, close,
      async turn() { await new Promise<void>((resolve) => { release = resolve; }); return { stop: "end" }; } };
    const pool = new RuntimePool(1, 50);
    try {
      const active = pool.run("one", "a", () => runtime, input(), io());
      await expect(pool.run("two", "a", () => runtime, input(), io())).rejects.toThrow("busy");
      expect(close).not.toHaveBeenCalled();
      release(); await active;
      await vi.advanceTimersByTimeAsync(51);
      expect(close).toHaveBeenCalledOnce();
    } finally { pool.close(); vi.useRealTimers(); }
  });

  it("keeps input open across turns and releases waiting consumers on close", async () => {
    const q = new MessageQueue<string>();
    const reader = q[Symbol.asyncIterator]();
    q.push("one"); expect(await reader.next()).toEqual({ value: "one", done: false });
    const next = reader.next(); q.push("two"); expect(await next).toEqual({ value: "two", done: false });
    const end = reader.next(); q.close(); expect((await end).done).toBe(true);
    expect(() => q.push("three")).toThrow("closed");
  });
});
