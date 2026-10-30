import { it, expect } from "vitest";
import { Context } from "cordis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createCodexEngine } from "../src/index.js";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import type { Block, SteerInput, TurnIO, TurnInput } from "@tomradex/agent";

it("uses one process for two turns, attributes counters per turn, and interrupts without killing the session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-protocol-"));
  const log = path.join(dir, "requests.jsonl");
  const bin = path.join(dir, "codex");
  const fake = path.resolve("packages/engine-codex/tests/fake-app-server.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}'\n`, { mode: 0o700 });
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  const engine = createCodexEngine(ctx);
  const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "hello" }, messages: [], cards: [], brief: null, pending: null,
    options: { command: bin }, env: { TOMRADE_TEST_LOG: log } };
  const deltas: string[] = [];
  const blocks: Block[] = [];
  const io: TurnIO = { emit: block => { blocks.push(block); }, delta: (text) => deltas.push(text), progress() {}, signal: new AbortController().signal,
    tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
    run: { id: "run", threadId: "thread", projectId: "project", author: "ai:codex", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } };
  try {
    const published: string[] = [];
    const ref = { id: "image", name: "input.png", mime: "image/png", size: 3 };
    io.media = { read: () => ({ ...ref, base64: "YWJj" }), path: () => "unused", publish: data => { published.push(data.base64); return ref; } };
    input.input = { kind: "text", text: "hello", attachments: [ref] };
    const one = await engine.turn(input, io);
    expect(one.stop).toBe("end");
    expect(published).toEqual(["YWJj"]);
    input.input = { kind: "text", text: "hello" };
    io.resume = one.resume;
    const two = await engine.turn(input, io);
    expect(two.metrics?.runtime).toBe("warm");
    expect(two.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(two.metrics?.cacheReadTokens).toBe(7);
    expect(two.metrics?.cacheWriteTokens).toBe(1);
    expect(deltas).toEqual(["hello", "hello"]);
    input.input = { kind: "text", text: "COMMAND_RESULTS" };
    expect((await engine.turn(input, io)).stop).toBe("end");
    const results = () => blocks.flatMap(block => block.type === "trace" && block.commandResult ? [block.commandResult] : []);
    expect(results()).toEqual([
      { status: "no-match", exitCode: 1, output: "" },
      { status: "failed", exitCode: 1, output: "FAIL: assertion" },
      { status: "failed", exitCode: 2, output: "" },
      { status: "declined", exitCode: null, output: "" },
      { status: "timed-out", exitCode: 124, output: "Command timed out" }
    ]);
    const abort = new AbortController(); io.signal = abort.signal;
    input.input = { kind: "text", text: "WAIT_FOREVER" };
    const waiting = engine.turn(input, io);
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    expect((await waiting).stop).toBe("cancelled");
    expect(results().at(-1)).toEqual({ status: "interrupted", exitCode: null, output: "partial\noutput" });
    io.signal = new AbortController().signal; input.input = { kind: "text", text: "again" };
    expect((await engine.turn(input, io)).stop).toBe("end");
    const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    expect(requests.find(r => r.method === "turn/start").params.input).toContainEqual({ type: "image", url: "data:image/png;base64,YWJj" });
    expect(requests.filter((r) => r.spawn)).toHaveLength(1);
    expect(requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "turn/start")).toHaveLength(5);
    expect(requests.some((r) => r.method === "turn/interrupt")).toBe(true);
    input.purpose = "code";
    input.input = { kind: "text", text: "REQUEST_PERMISSION" };
    for (const choice of ["Allow once", "Deny", null]) {
      io.requestPermission = async (text) => { expect(text).toContain("npm test"); return choice; };
      const result = await engine.turn(input, io);
      expect(result.stop, result.error).toBe("end");
      io.resume = result.resume;
    }
    // Full access picked while the person has not answered: Tomrade approves it; a stricter mode waits for the next turn
    let apply: ((mode: string) => Promise<boolean>) | undefined;
    const took: boolean[] = [];
    io.modeTo = (fn) => { apply = fn; };
    io.requestPermission = (_text, _options, signal) => {
      void apply!("read-only").then((ok) => took.push(ok)).then(() => apply!("full-access")).then((ok) => took.push(ok));
      return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(null), { once: true }));
    };
    const raised = await engine.turn(input, io);
    expect(raised.stop, raised.error).toBe("end");
    expect(took).toEqual([false, true]);
    io.resume = raised.resume; delete io.modeTo;
    const all = fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    expect(all.filter((r) => r.id === "permission-request").map((r) => r.result.decision)).toEqual(["accept", "decline", "decline", "accept"]);
    const resumed = all.find((r) => r.method === "thread/resume");
    expect(resumed.params.approvalPolicy).toBe("on-request");
    expect(resumed.params.sandbox).toBe("workspace-write");
    expect(resumed.params.approvalsReviewer).toBe("user");
    input.permissionMode = "full-access";
    input.input = { kind: "text", text: "again" };
    expect((await engine.turn(input, io)).stop).toBe("end");
    const changed = fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    expect(changed.filter((r) => r.method === "thread/resume").at(-1).params).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("steers a running turn with turn/steer and records the message where Codex adds it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-codex-steer-"));
  const log = path.join(dir, "requests.jsonl");
  const bin = path.join(dir, "codex");
  const fake = path.resolve("packages/engine-codex/tests/fake-app-server.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}'\n`, { mode: 0o700 });
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  const engine = createCodexEngine(ctx);
  expect(engine.steering).toBe("forward");
  const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "STEER_TAKE" }, messages: [], cards: [], brief: null, pending: null,
    options: { command: bin }, env: { TOMRADE_TEST_LOG: log } };
  const order: string[] = [];
  let forward: ((steer: SteerInput) => Promise<boolean>) | undefined;
  let steersMedia = false;
  const io: TurnIO = { emit: (block) => order.push(block.type === "text" ? `agent:${block.text}` : block.type), delta() {}, progress() {}, signal: new AbortController().signal,
    tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
    run: { id: "run", threadId: "thread", projectId: "project", author: "ai:codex", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() },
    steersMedia: () => { steersMedia = true; }, steerTo: (fn) => { forward = fn; }, steered: (id) => order.push(`steered:${id}`) };
  const requests = () => fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
  try {
    const turn = engine.turn(input, io);
    while (!fs.existsSync(log) || !requests().some((r) => r.method === "turn/start")) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(steersMedia).toBe(true);
    expect(await forward!({ id: "s1", text: "make it blue", media: [{ id: "m1", name: "shot.png", mime: "image/png", size: 3, base64: "cG5n" }] })).toBe(true);
    expect((await turn).stop).toBe("end");
    // the prompt's own userMessage item is not mistaken for the steer
    expect(order).toEqual(["steered:s1", "agent:took: make it blue"]);
    expect(requests().find((r) => r.method === "turn/steer").params).toMatchObject({ threadId: "fake-session", expectedTurnId: "1", clientUserMessageId: "s1", input: [{ type: "text", text: "make it blue" }, { type: "image", url: "data:image/png;base64,cG5n" }] });
    expect(await forward!({ id: "late", text: "too late" })).toBe(false);
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

