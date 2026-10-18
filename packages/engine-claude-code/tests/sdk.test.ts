import { it, expect } from "vitest";
import { Context } from "cordis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createClaudeCodeEngine } from "../src/index.js";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import type { TurnInput, TurnIO } from "@tomradex/agent";

// The fake CLI appends a line per message while it runs, so a read can land after the file is created but before
// its first write, or mid-line: only newline-terminated lines are finished.
const logged = (file: string): any[] => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line));
};

it("drives the actual SDK across multiple messages, diffs cumulative cost, and retains its process after interrupt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-sdk-"));
  const log = path.join(dir, "requests.jsonl");
  const bin = path.join(dir, "claude");
  const fake = path.resolve("packages/engine-claude-code/tests/fake-claude.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  const engine = createClaudeCodeEngine(ctx);
  const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "hello" }, messages: [], cards: [], brief: "brief v1", pending: null,
    options: { command: bin, model: "fixed-model", effort: "low" }, env: { TOMRADE_TEST_LOG: log } };
  const deltas: string[] = [];
  const progressed: { inputTokens: number; outputTokens: number }[] = [];
  const io: TurnIO = { emit() {}, delta: (text) => deltas.push(text), progress: (u) => progressed.push({ inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 }), signal: new AbortController().signal,
    tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
    run: { id: "run", threadId: "thread", projectId: "project", author: "ai:claude-code", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } };
  try {
    const ref = { id: "image", name: "input.png", mime: "image/png", size: 3 };
    io.media = { read: () => ({ ...ref, base64: "YWJj" }), path: () => "unused", publish: () => ref };
    input.input = { kind: "text", text: "hello", attachments: [ref] };
    const one = await engine.turn(input, io);
    expect(one.stop, one.error).toBe("end"); io.resume = one.resume;
    // Live: the prompt (cache included) lands with message_start, the reply grows with message_delta.
    expect(progressed[0]).toEqual({ inputTokens: 34, outputTokens: 0 });
    expect(progressed).toContainEqual({ inputTokens: 34, outputTokens: 3 });
    input.input = { kind: "text", text: "hello" };
    input.brief = "brief v2";
    const two = await engine.turn(input, io);
    expect(two.metrics?.runtime).toBe("warm");
    expect(one.costUsd).toBeCloseTo(0.02); expect(two.costUsd).toBeCloseTo(0.02);
    // Final: this turn's slice of the cumulative modelUsage, input counting cached tokens as read.
    expect(two.usage).toEqual({ inputTokens: 34, outputTokens: 3 });
    expect(two.metrics?.cacheReadTokens).toBe(20); expect(two.metrics?.cacheWriteTokens).toBe(4); expect(two.metrics?.uncachedInputTokens).toBe(10);
    const abort = new AbortController(); io.signal = abort.signal;
    input.input = { kind: "text", text: "WAIT_FOREVER" };
    const waiting = engine.turn(input, io);
    await new Promise((resolve) => setTimeout(resolve, 100)); abort.abort();
    expect((await waiting).stop).toBe("cancelled");
    input.input = { kind: "text", text: "again" }; io.signal = new AbortController().signal;
    expect((await engine.turn(input, io)).stop).toBe("end");
    expect(deltas).toEqual(["hello", "hello", "hello"]);
    const requests = logged(log);
    expect(requests.filter((r) => r.spawn)).toHaveLength(1);
    const users = requests.filter((r) => r.type === "user");
    expect(users[0].message.content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } });
    expect(users).toHaveLength(4);
    expect(users[1].message.content).toContain("brief v2");
    expect(requests.some((r) => r.request?.subtype === "interrupt")).toBe(true);
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 15_000);

it("reports a session Claude Code no longer has, and leads a new session's first message with the conversation so far", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-sdk-lost-"));
  const log = path.join(dir, "requests.jsonl");
  const bin = path.join(dir, "claude");
  const fake = path.resolve("packages/engine-claude-code/tests/fake-claude.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  const engine = createClaudeCodeEngine(ctx);
  const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "fix kanban" }, messages: [], cards: [], brief: "", pending: null,
    options: { command: bin, model: "fixed-model" }, env: { TOMRADE_TEST_LOG: log } };
  const io: TurnIO = { emit() {}, delta() {}, progress() {}, signal: new AbortController().signal, resume: "gone", recap: () => "RECAP OF EARLIER",
    tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
    run: { id: "run", threadId: "thread", projectId: "project", author: "ai:claude-code", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } };
  const sentTexts = () => logged(log).filter((m) => m.type === "user").map((m) => JSON.stringify(m.message.content));
  try {
    expect(await engine.turn(input, io)).toMatchObject({ stop: "error", lostSession: true });
    io.resume = undefined;
    const fresh = await engine.turn(input, io);
    expect(fresh.stop, fresh.error).toBe("end");
    expect(sentTexts().at(-1)).toContain("RECAP OF EARLIER");
    io.resume = fresh.resume;
    input.input = { kind: "text", text: "next" };
    expect((await engine.turn(input, io)).stop).toBe("end");
    expect(sentTexts().at(-1)).not.toContain("RECAP OF EARLIER");
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("reports the SDK's retries, drops the failed attempt from the live count, and traces its own tools with their results", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-sdk-retry-"));
  const bin = path.join(dir, "claude");
  const fake = path.resolve("packages/engine-claude-code/tests/fake-claude.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  const engine = createClaudeCodeEngine(ctx);
  const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "FLAKY" }, messages: [], cards: [], brief: "", pending: null,
    options: { command: bin, model: "fixed-model" } };
  const blocks: unknown[] = [];
  const retries: unknown[] = [];
  const activity: (string | null)[] = [];
  const progressed: number[] = [];
  const io: TurnIO = { emit: (b) => blocks.push(b), delta() {}, progress: (u) => progressed.push(u.inputTokens ?? 0), signal: new AbortController().signal,
    retry: (r) => retries.push(r), activity: (a) => activity.push(a),
    tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
    run: { id: "run", threadId: "thread", projectId: "project", author: "ai:claude-code", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } };
  try {
    const result = await engine.turn(input, io);
    expect(result.stop, result.error).toBe("end");
    expect(retries[0]).toEqual({ attempt: 1, max: 10, reason: "connection dropped", delayMs: 500 });
    // the dropped attempt's prompt leaves the total instead of counting twice
    expect(Math.max(...progressed)).toBe(34);
    expect(activity).toEqual(["Bash · ls -la", null]);
    expect(blocks).toContainEqual(expect.objectContaining({ type: "trace", tool: "Bash", ok: true, summary: "ls -la" }));
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 15_000);

it("steers a running turn through the SDK's input queue, waits out a steer that missed the turn, and drops unread ones on a stop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-sdk-steer-"));
  const log = path.join(dir, "requests.jsonl");
  const bin = path.join(dir, "claude");
  const fake = path.resolve("packages/engine-claude-code/tests/fake-claude-steer.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  const engine = createClaudeCodeEngine(ctx);
  expect(engine.steers).toBe(true);
  const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "TOOL_STEER" }, messages: [], cards: [], brief: null, pending: null,
    options: { command: bin }, env: { TOMRADE_TEST_LOG: log } };
  const order: string[] = [];
  let forward: ((steer: { id: string; text: string }) => Promise<boolean>) | undefined;
  const io: TurnIO = { emit: (block) => order.push(block.type === "text" ? `agent:${block.text}` : block.type), delta() {}, progress() {}, signal: new AbortController().signal,
    tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
    run: { id: "run", threadId: "thread", projectId: "project", author: "ai:claude-code", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() },
    steerTo: (fn) => { forward = fn; }, steered: (id) => order.push(`steered:${id}`) };
  const requests = () => logged(log);
  const when = async (cond: () => boolean) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > 10_000) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };
  try {
    // while a tool runs: joins the same CLI turn, placed after the tool's result
    let turn = engine.turn(input, io);
    await when(() => order.includes("trace") || requests().some((r) => r.type === "user"));
    await new Promise((r) => setTimeout(r, 100));
    expect(await forward!({ id: "s1", text: "make it blue" })).toBe(true);
    let result = await turn;
    expect(result.stop, result.error).toBe("end");
    expect(order).toEqual(["trace", "steered:s1", "agent:took: make it blue"]);
    const steer = requests().filter((r) => r.type === "user").at(-1);
    expect(steer).toMatchObject({ priority: "next" });
    expect(steer.message.content).toMatch(/^make it blue\n\n\(Sent while you were working/);
    expect(await forward!({ id: "late", text: "too late" })).toBe(false);

    // during the last reply: the CLI answers it in a turn of its own, which this turn waits for
    order.length = 0;
    input.input = { kind: "text", text: "LATE_STEER" }; io.resume = result.resume;
    turn = engine.turn(input, io);
    await when(() => order.includes("agent:first answer"));
    expect(await forward!({ id: "s2", text: "end with an emoji" })).toBe(true);
    result = await turn;
    expect(result.stop).toBe("end");
    expect(order).toEqual(["agent:first answer", "steered:s2", "agent:only the addition: end with an emoji"]);
    expect(result.costUsd).toBeCloseTo(0.04);

    // the next turn is not disturbed by what came before
    order.length = 0;
    input.input = { kind: "text", text: "hello" };
    expect((await engine.turn(input, io)).stop).toBe("end");
    expect(order).toEqual(["agent:hello"]);

    // a stop with a steer still unread ends the process rather than leave it queued to run
    const abort = new AbortController(); io.signal = abort.signal;
    order.length = 0;
    input.input = { kind: "text", text: "HOLD_STEER" };
    turn = engine.turn(input, io);
    await when(() => order.includes("trace") || requests().filter((r) => r.type === "user").some((r) => JSON.stringify(r).includes("HOLD_STEER")));
    await new Promise((r) => setTimeout(r, 100));
    expect(await forward!({ id: "s3", text: "never read" })).toBe(true);
    abort.abort();
    expect((await turn).stop).toBe("cancelled");
    expect(order).not.toContain("steered:s3");
    io.signal = new AbortController().signal;
    input.input = { kind: "text", text: "hello" };
    expect((await engine.turn(input, io)).stop).toBe("end");
    expect(requests().filter((r) => r.spawn)).toHaveLength(2);
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
