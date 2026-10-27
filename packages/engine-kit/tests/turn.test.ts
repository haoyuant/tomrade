import type { Context } from "cordis";
import { describe, expect, it } from "vitest";
import type { TurnInput, TurnIO, TurnResult } from "@tomradex/agent";
import { pooledEngine, runTurn, type TurnSpec } from "../src/turn.js";
import type { Runtime } from "../src/runtime.js";

const input = (id = "thread"): TurnInput => ({ threadId: id, projectId: "project", purpose: "backlog", input: { kind: "text", text: "hello" }, messages: [], cards: [], brief: null, pending: null, options: {} });
const io = (): TurnIO => ({ emit() {}, delta() {}, progress() {}, signal: new AbortController().signal,
  tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
  run: { id: "run", threadId: "thread", projectId: "project", author: "ai:test", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } });

const ctx = (url: string | null = "http://127.0.0.1:1/mcp") => {
  const disposers: (() => void)[] = [];
  const fake = { mcp: { url, bindRun: () => () => {} }, effect: (fn: () => () => void) => { disposers.push(fn()); }, get: () => undefined };
  return { ctx: fake as unknown as Context, dispose: () => disposers.forEach((d) => d()) };
};

const spec = (over: Partial<TurnSpec> = {}): TurnSpec => ({
  ctx: ctx().ctx, token: "token", input: input(), metrics: { transport: "rpc", runtime: "cold" },
  resume: () => "session",
  result: (stop, error, details) => ({ stop, ...(error ? { error } : {}), ...(details ? { details } : {}), resume: "session" }),
  stderr: () => "the agent's last words",
  ...over
});

describe("the turn frame", () => {
  it("stops a cancelled turn through the runtime's own abort, and does not start one cancelled before it began", async () => {
    const controller = new AbortController();
    let aborted = 0;
    const running = runTurn({ ...io(), signal: controller.signal }, spec(), async (turn) => {
      turn.onAbort(() => { aborted++; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return turn.cancelled ? { stop: "cancelled" } : { stop: "end" };
    });
    controller.abort();
    expect(await running).toEqual({ stop: "cancelled" });
    expect(aborted).toBe(1);

    let ran = false;
    const early = await runTurn({ ...io(), signal: AbortSignal.abort() }, spec(), async () => { ran = true; return { stop: "end" }; });
    expect(ran).toBe(false);
    expect(early).toEqual({ stop: "cancelled", resume: "session", metrics: { transport: "rpc", runtime: "cold" } });
  });

  it("turns a thrown failure into an error with its details, after the runtime cleans up", async () => {
    const order: string[] = [];
    const result = await runTurn(io(), spec({ thrown: () => order.push("thrown"), cleanup: () => order.push("cleanup") }), async () => {
      throw new Error("the agent fell over");
    });
    expect(order).toEqual(["thrown", "cleanup"]);
    expect(result.stop).toBe("error");
    expect(result.error).toBe("the agent fell over");
    expect(result.details).toMatch(/── error ──\nError: the agent fell over[\s\S]*── stderr ──\nthe agent's last words/);
    expect(result.limit).toBeUndefined();
  });

  it("reports an error that reads as a usage limit as one, with when it lifts, and keeps a limit the runtime knew", async () => {
    const now = Date.now();
    const limited = await runTurn(io(), spec(), async () => ({ stop: "error", error: "You've hit your usage limit. Try again in 2 hours." }));
    expect(limited.limit?.until).toBeGreaterThanOrEqual(now + 2 * 3_600_000 - 1000);
    expect((await runTurn(io(), spec(), async () => ({ stop: "error", error: "429 Too Many Requests" }))).limit).toEqual({ until: null });
    const known: TurnResult = { stop: "error", error: "rate limited", limit: { until: 42 } };
    expect((await runTurn(io(), spec(), async () => known)).limit).toEqual({ until: 42 });
    expect((await runTurn(io(), spec(), async () => ({ stop: "error", error: "insufficient balance: 402" }))).limit).toBeUndefined();
    expect((await runTurn(io(), spec(), async () => ({ stop: "end" }))).limit).toBeUndefined();
  });
});

describe("a pooled engine", () => {
  it("refuses without the MCP server, keeps one runtime per thread, and starts another when the fingerprint changes", async () => {
    expect(await pooledEngine(ctx(null).ctx, { create: () => { throw new Error("never"); } }).turn(input(), io())).toEqual({ stop: "error", error: "The MCP server is not running" });
    const { ctx: live, dispose } = ctx();
    const made: string[] = [];
    let profile = "a";
    const closed: string[] = [];
    const { turn } = pooledEngine(live, {
      create: (thread) => {
        const name = `${thread.threadId}-${made.length}`;
        made.push(name);
        return { token: name, cwd: "/tmp", alive: true, busy: false, close() { closed.push(name); this.alive = false; },
          async turn() { return { stop: "end" }; } } satisfies Runtime;
      },
      fingerprint: () => profile
    });
    await turn(input("one"), io());
    await turn(input("one"), io());
    await turn(input("two"), io());
    expect(made).toEqual(["one-0", "two-1"]);
    profile = "b";
    await turn(input("one"), io());
    expect(made).toEqual(["one-0", "two-1", "one-2"]);
    expect(closed).toEqual(["one-0"]);
    dispose();
    expect(closed.sort()).toEqual(["one-0", "one-2", "two-1"]);
  });
});

describe("releasing a thread's runtime", () => {
  it("closes the warm runtime of that thread alone, so a cold one takes the next turn", async () => {
    const closed: string[] = [];
    const warmth: string[] = [];
    const create = (input: TurnInput): Runtime => ({ token: input.threadId, cwd: "/tmp", alive: true, busy: false,
      close() { closed.push(this.token); this.alive = false; },
      async turn(_input, _io, warm) { warmth.push(`${this.token}:${warm ? "warm" : "cold"}`); return { stop: "end" }; } });
    const { ctx: fake, dispose } = ctx();
    const engine = pooledEngine(fake, { create });
    try {
      await engine.turn(input("one"), io());
      await engine.turn(input("two"), io());
      engine.release({ projectId: "project", threadId: "one" });
      expect(closed).toEqual(["one"]);
      await engine.turn(input("one"), io());
      await engine.turn(input("two"), io());
      expect(warmth).toEqual(["one:cold", "two:cold", "one:cold", "two:warm"]);
      // nothing to close is nothing to do
      engine.release({ projectId: "project", threadId: "none" });
      expect(closed).toEqual(["one"]);
    } finally { dispose(); }
    expect(closed).toEqual(["one", "one", "two"]);
  });
});
