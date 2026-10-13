import { it, expect } from "vitest";
import { Context } from "cordis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createClaudeCodeEngine } from "../src/index.js";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import type { TurnInput, TurnIO } from "@tomradex/agent";

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
    const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    expect(requests.filter((r) => r.spawn)).toHaveLength(1);
    const users = requests.filter((r) => r.type === "user");
    expect(users[0].message.content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } });
    expect(users).toHaveLength(4);
    expect(users[1].message.content).toContain("brief v2");
    expect(requests.some((r) => r.request?.subtype === "interrupt")).toBe(true);
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 15_000);

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
