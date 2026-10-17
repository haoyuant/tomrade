import { it, expect } from "vitest";
import { Context } from "cordis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { bridgeSource, createPiEngine, listedModels, piSignedIn, toolSelection } from "../src/index.js";
import { PERMISSION_MODES } from "../src/options.js";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import type { Block, TurnIO, TurnInput } from "@tomradex/agent";

it("reads pi's model table and its no-credential answer", () => {
  const table = "provider  model        context  max-out  thinking  images\nopenai    gpt-4.1      1.0M     32.8K    no        yes\nanthropic claude-x     200K     64K      yes       yes\n";
  expect(listedModels(table)).toEqual(["openai/gpt-4.1", "anthropic/claude-x"]);
  expect(piSignedIn(table)).toBe(true);
  expect(piSignedIn("No models available. Use /login to log into a provider")).toBe(false);
  expect(piSignedIn("something else")).toBeNull();
  expect(listedModels("No models available.")).toEqual([]);
});

it("narrows tools for read-only turns only, the main chat included", () => {
  expect(toolSelection({ permissionMode: "read-only" })).toBe("read,grep,find,ls,tool_search,mcp__tomrade__*");
  expect(toolSelection({ permissionMode: "full-access" })).toBeNull();
  expect(toolSelection({ permissionMode: "ask" })).toBeNull();
  expect(PERMISSION_MODES).toMatchObject({ default: "full-access" });
});

it("registers Tomrade's MCP server and gates only what may change something", async () => {
  const load = async (approval: boolean) => {
    const source = bridgeSource({ url: "http://127.0.0.1:9/mcp", token: "secret", approval });
    const servers: Record<string, any> = {};
    const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
    const pi = {
      registerMcpServer: (name: string, config: unknown) => { servers[name] = config; },
      on: (event: string, handler: any) => { handlers[event] = handler; },
      getAllTools: () => [{ name: "mcp__docs__search", annotations: { readOnlyHint: true } }]
    };
    (await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`)).default(pi);
    return { servers, gate: handlers.tool_call };
  };
  const open = await load(false);
  expect(open.servers.tomrade).toMatchObject({ url: "http://127.0.0.1:9/mcp", headers: { "X-Tomrade-Run": "secret" }, exposure: "direct" });
  expect(open.gate).toBeUndefined();
  const { gate } = await load(true);
  const asked: string[] = [];
  const ctx = (answer: boolean) => ({ ui: { confirm: async (title: string) => { asked.push(title); return answer; } } });
  for (const toolName of ["read", "tool_search", "mcp__tomrade__create_item", "mcp__docs__search"]) expect(await gate!({ toolName, input: {} }, ctx(false))).toBeUndefined();
  expect(asked).toEqual([]);
  expect(await gate!({ toolName: "bash", input: { command: "rm -rf x" } }, ctx(true))).toBeUndefined();
  expect(await gate!({ toolName: "write", input: {} }, ctx(false))).toMatchObject({ block: true });
  expect(asked).toEqual(["Pi wants to use bash", "Pi wants to use write"]);
});

it("declares a kit the conversation does not carry only once tool_search loads it, and hides another surface's tools", async () => {
  const source = bridgeSource({ url: "http://127.0.0.1:9/mcp", token: "t", approval: false, deferred: ["create_template", "schedule_template"], hidden: ["doctor_conclude"], kits: ["routines — recurring tickets", "plugins — build a Tomrade plugin"] });
  const servers: Record<string, any> = {};
  (await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`)).default({ registerMcpServer: (name: string, config: unknown) => { servers[name] = config; }, on: () => {} });
  expect(servers.tomrade).toMatchObject({ exposure: "direct", toolExposure: { create_template: "deferred", schedule_template: "deferred", doctor_conclude: "hidden" } });
  expect(servers.tomrade.description).toBe("Tomrade: your mcp__tomrade__ tools are the project's backlog. More via tool_search when asked: routines — recurring tickets; plugins — build a Tomrade plugin");
  const plain: Record<string, any> = {};
  (await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(bridgeSource({ url: "u", token: "t", approval: false }))}`)).default({ registerMcpServer: (name: string, config: unknown) => { plain[name] = config; }, on: () => {} });
  expect(plain.tomrade).not.toHaveProperty("toolExposure");
});

it("keeps one process across turns, resumes its session id, and answers permission dialogs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pi-"));
  const log = path.join(dir, "requests.jsonl");
  const bin = path.join(dir, "pi");
  const fake = path.resolve("packages/engine-pi/tests/fake-pi.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  const engine = createPiEngine(ctx);
  const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "hello" }, messages: [], cards: [], brief: null, pending: null,
    options: { command: bin, model: "fake/fixed-model", effort: "high" }, env: { TOMRADE_TEST_LOG: log } };
  const deltas: string[] = [];
  const blocks: Block[] = [];
  const io: TurnIO = { emit: (block) => blocks.push(block), delta: (text) => deltas.push(text), progress() {}, signal: new AbortController().signal,
    tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
    run: { id: "run", threadId: "thread", projectId: "project", author: "ai:pi", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } };
  const requests = () => fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
  try {
    const ref = { id: "image", name: "input.png", mime: "image/png", size: 3 };
    io.media = { read: () => ({ ...ref, base64: "YWJj" }), path: () => "unused", publish: () => ref };
    input.input = { kind: "text", text: "hello", attachments: [ref] };
    const one = await engine.turn(input, io);
    expect(one.stop, one.error).toBe("end");
    expect(one.resume).toMatch(/^[0-9a-f-]{36}$/);
    expect(one.usage).toEqual({ inputTokens: 18, outputTokens: 3 });
    expect(one.costUsd).toBeCloseTo(0.01);
    expect(one.metrics).toMatchObject({ transport: "rpc", runtime: "cold", uncachedInputTokens: 10, cacheReadTokens: 7, cacheWriteTokens: 1, providerModel: "fake/fixed-model" });
    expect(deltas).toEqual(["hel\u2028lo"]);
    expect(blocks).toContainEqual({ type: "text", text: "hel\u2028lo" });
    // The person's own Tomrade extension steps aside for a session carrying its token.
    const spawned = requests().find((r) => r.spawn) as { token: string | null; bridge: string };
    expect(spawned.token).toMatch(/\S/);
    expect(spawned.bridge).toContain(`"X-Tomrade-Run":"${spawned.token}"`);

    input.input = { kind: "text", text: "again" };
    io.resume = one.resume;
    const two = await engine.turn(input, io);
    expect(two.metrics?.runtime).toBe("warm");
    expect(two.resume).toBe(one.resume);

    const retries: unknown[] = [];
    io.retry = (state) => retries.push(state);
    input.input = { kind: "text", text: "FLAKY" };
    expect((await engine.turn(input, io)).stop).toBe("end");
    expect(retries).toEqual([{ attempt: 1, max: 3, reason: "529 overloaded", delayMs: 2000 }, null]);

    const abort = new AbortController(); io.signal = abort.signal;
    input.input = { kind: "text", text: "WAIT_FOREVER" };
    const waiting = engine.turn(input, io);
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    expect((await waiting).stop).toBe("cancelled");
    io.signal = new AbortController().signal;

    const spawns = requests().filter((r) => r.spawn);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].argv).toEqual(expect.arrayContaining(["--mode", "rpc", "--session-id", one.resume, "--model", "fake/fixed-model", "--thinking", "high"]));
    expect(spawns[0].argv).not.toContain("--tools");
    expect(spawns[0].bridge).toContain(`"X-Tomrade-Run"`);
    expect(spawns[0].bridge).toContain("const approval = false;");
    const prompts = requests().filter((r) => r.type === "prompt");
    expect(prompts[0].images).toEqual([{ type: "image", data: "YWJj", mimeType: "image/png" }]);
    expect(prompts[0].message).toContain("USER MESSAGE:\n\nhello");
    expect(requests().some((r) => r.type === "abort")).toBe(true);

    // The main chat asks too: Pi has no permissions of its own, so Tomrade's gate is what stands.
    input.permissionMode = "ask";
    input.input = { kind: "text", text: "REQUEST_PERMISSION" };
    for (const [choice, said] of [["Allow once", "ran it"], ["Deny", "skipped it"], [null, "skipped it"]] as const) {
      blocks.length = 0;
      io.requestPermission = async (text, options) => { expect(text).toContain("npm test"); expect(options).toEqual(["Allow once", "Deny"]); return choice; };
      const result = await engine.turn(input, io);
      expect(result.stop, result.error).toBe("end");
      expect(blocks).toContainEqual({ type: "text", text: said });
      expect(blocks).toContainEqual(expect.objectContaining({ type: "trace", tool: "bash", ok: choice === "Allow once" }));
    }
    const answers = requests().filter((r) => r.type === "extension_ui_response");
    expect(answers.map((r) => r.confirmed ?? (r.cancelled ? "cancelled" : undefined))).toEqual([true, false, "cancelled"]);
    const asking = requests().filter((r) => r.spawn).at(-1);
    expect(asking.argv).toEqual(expect.arrayContaining(["--session-id", one.resume]));
    expect(asking.argv).not.toContain("--tools");
    expect(asking.bridge).toContain("const approval = true;");

    input.input = { kind: "text", text: "FAIL" };
    const failed = await engine.turn(input, io);
    expect(failed).toMatchObject({ stop: "error", error: "401 invalid api key", resume: one.resume });
    expect(failed.details).toMatch(/── reply ──[\s\S]*"provider": "fake"[\s\S]*"model": "fixed-model"/);
    expect(failed.details).not.toContain('"content"');
    input.input = { kind: "text", text: "after" };
    expect((await engine.turn(input, io)).metrics?.runtime).toBe("cold");
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("reports a session pi has no file for, and leads a new session's first prompt with the conversation so far", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pi-lost-"));
  const log = path.join(dir, "requests.jsonl");
  const bin = path.join(dir, "pi");
  const fake = path.resolve("packages/engine-pi/tests/fake-pi.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  const engine = createPiEngine(ctx);
  const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "hello" }, messages: [], cards: [], brief: null, pending: null,
    options: { command: bin, model: "fake/fixed-model" }, env: { TOMRADE_TEST_LOG: log } };
  const io: TurnIO = { emit() {}, delta() {}, progress() {}, signal: new AbortController().signal, resume: "gone", recap: () => "RECAP OF EARLIER",
    tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
    run: { id: "run", threadId: "thread", projectId: "project", author: "ai:pi", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } };
  const prompts = () => fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s)).filter((r) => r.type === "prompt").map((r) => r.message as string);
  try {
    expect(await engine.turn(input, io)).toMatchObject({ stop: "error", lostSession: true });
    expect(fs.existsSync(log) ? prompts() : []).toEqual([]);
    io.resume = undefined;
    const fresh = await engine.turn(input, io);
    expect(fresh.stop, fresh.error).toBe("end");
    expect(prompts().at(-1)).toContain("RECAP OF EARLIER");
    io.resume = fresh.resume;
    input.input = { kind: "text", text: "next" };
    expect((await engine.turn(input, io)).stop).toBe("end");
    expect(prompts().at(-1)).not.toContain("RECAP OF EARLIER");
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("starts a new session carried by the recap when the session holds another model's reasoning, and resumes it otherwise", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pi-model-"));
  const log = path.join(dir, "requests.jsonl");
  const bin = path.join(dir, "pi");
  const fake = path.resolve("packages/engine-pi/tests/fake-pi.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  const engine = createPiEngine(ctx);
  const turn = async (resume: string, threadId: string) => {
    const input: TurnInput = { threadId, projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "hello" }, messages: [], cards: [], brief: null, pending: null,
      options: { command: bin, model: "fake/fixed-model" }, env: { TOMRADE_TEST_LOG: log } };
    const io: TurnIO = { emit() {}, delta() {}, progress() {}, signal: new AbortController().signal, resume, recap: () => "RECAP OF EARLIER",
      tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
      run: { id: "run", threadId, projectId: "project", author: "ai:pi", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } };
    const result = await engine.turn(input, io);
    const prompt = fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s)).filter((r) => r.type === "prompt").at(-1).message as string;
    return { result, recapped: prompt.includes("RECAP OF EARLIER") };
  };
  try {
    const switched = await turn("reasoned-other-model", "switched");
    expect(switched.result).toMatchObject({ stop: "end", resume: "new-session" });
    expect(switched.recapped).toBe(true);
    expect(await turn("reasoned-fixed-model", "same")).toMatchObject({ result: { stop: "end", resume: "reasoned-fixed-model" }, recapped: false });
    expect(await turn("replied-other-model", "plain")).toMatchObject({ result: { stop: "end", resume: "replied-other-model" }, recapped: false });
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("hands a message sent mid-turn to pi's own queue, records it where pi reads it, and clears what is left before a stop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pi-steer-"));
  const log = path.join(dir, "requests.jsonl");
  const bin = path.join(dir, "pi");
  const fake = path.resolve("packages/engine-pi/tests/fake-pi.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  const engine = createPiEngine(ctx);
  expect(engine.steers).toBe(true);
  const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "STEER_TAKE" }, messages: [], cards: [], brief: null, pending: null,
    options: { command: bin, model: "fake/fixed-model" }, env: { TOMRADE_TEST_LOG: log } };
  const order: string[] = [];
  let forward: ((steer: { id: string; text: string }) => Promise<boolean>) | undefined;
  const io: TurnIO = { emit: (block) => order.push(block.type === "text" ? `agent:${block.text}` : block.type), delta() {}, progress() {}, signal: new AbortController().signal,
    tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
    run: { id: "run", threadId: "thread", projectId: "project", author: "ai:pi", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() },
    steerTo: (fn) => { forward = fn; }, steered: (id) => order.push(`steered:${id}`) };
  const requests = () => fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
  try {
    const turn = engine.turn(input, io);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await forward!({ id: "s1", text: "make it blue" })).toBe(true);
    expect((await turn).stop).toBe("end");
    expect(order).toEqual(["steered:s1", "agent:took: make it blue"]);
    expect(requests().find((r) => r.type === "steer")).toMatchObject({ message: "make it blue" });
    // the turn is over: pi is not asked to take another
    expect(await forward!({ id: "late", text: "too late" })).toBe(false);

    const abort = new AbortController(); io.signal = abort.signal;
    order.length = 0;
    input.input = { kind: "text", text: "STEER_HOLD" };
    const held = engine.turn(input, io);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await forward!({ id: "s2", text: "never read" })).toBe(true);
    abort.abort();
    expect((await held).stop).toBe("cancelled");
    expect(order).not.toContain("steered:s2");
    const after = requests().filter((r) => r.type === "clear_queue" || r.type === "abort").map((r) => r.type);
    expect(after).toEqual(["clear_queue", "abort"]);
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

