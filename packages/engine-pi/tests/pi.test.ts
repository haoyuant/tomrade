import { it, expect } from "vitest";
import { Context } from "cordis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { bridgeSource, createPiEngine, listedModels, piSignedIn, toolSelection } from "../src/index.js";
import { lineSplitter } from "../src/rpc.js";
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

it("narrows tools for backlog and read-only turns only", () => {
  expect(toolSelection({ purpose: "backlog" })).toBe("mcp__tomrade__*");
  expect(toolSelection({ purpose: "code", permissionMode: "read-only" })).toBe("read,grep,find,ls,mcp__tomrade__*");
  expect(toolSelection({ purpose: "code", permissionMode: "full-access" })).toBeNull();
  expect(toolSelection({ purpose: "general", permissionMode: "ask" })).toBeNull();
});

it("splits records on LF only, across chunk boundaries", () => {
  const lines: string[] = [];
  const push = lineSplitter((line) => lines.push(line));
  const text = JSON.stringify({ a: "x\u2028y" }) + "\r\n" + JSON.stringify({ b: "é" }) + "\n";
  const bytes = Buffer.from(text);
  push(bytes.subarray(0, 5)); push(bytes.subarray(5, bytes.length - 3)); push(bytes.subarray(bytes.length - 3));
  expect(lines.map((line) => JSON.parse(line))).toEqual([{ a: "x\u2028y" }, { b: "é" }]);
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
  for (const toolName of ["read", "mcp__tomrade__create_item", "mcp__docs__search"]) expect(await gate!({ toolName, input: {} }, ctx(false))).toBeUndefined();
  expect(asked).toEqual([]);
  expect(await gate!({ toolName: "bash", input: { command: "rm -rf x" } }, ctx(true))).toBeUndefined();
  expect(await gate!({ toolName: "write", input: {} }, ctx(false))).toMatchObject({ block: true });
  expect(asked).toEqual(["Pi wants to use bash", "Pi wants to use write"]);
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

    input.input = { kind: "text", text: "again" };
    io.resume = one.resume;
    const two = await engine.turn(input, io);
    expect(two.metrics?.runtime).toBe("warm");
    expect(two.resume).toBe(one.resume);

    const abort = new AbortController(); io.signal = abort.signal;
    input.input = { kind: "text", text: "WAIT_FOREVER" };
    const waiting = engine.turn(input, io);
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    expect((await waiting).stop).toBe("cancelled");
    io.signal = new AbortController().signal;

    const spawns = requests().filter((r) => r.spawn);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].argv).toEqual(expect.arrayContaining(["--mode", "rpc", "--session-id", one.resume, "--model", "fake/fixed-model", "--thinking", "high", "--tools", "mcp__tomrade__*"]));
    expect(spawns[0].bridge).toContain(`"X-Tomrade-Run"`);
    expect(spawns[0].bridge).toContain("const approval = false;");
    const prompts = requests().filter((r) => r.type === "prompt");
    expect(prompts[0].images).toEqual([{ type: "image", data: "YWJj", mimeType: "image/png" }]);
    expect(prompts[0].message).toContain("USER MESSAGE:\n\nhello");
    expect(requests().some((r) => r.type === "abort")).toBe(true);

    input.purpose = "code"; input.permissionMode = "ask";
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
    const code = requests().filter((r) => r.spawn).at(-1);
    expect(code.argv).toEqual(expect.arrayContaining(["--session-id", one.resume]));
    expect(code.argv).not.toContain("--tools");
    expect(code.bridge).toContain("const approval = true;");

    input.input = { kind: "text", text: "FAIL" };
    const failed = await engine.turn(input, io);
    expect(failed).toMatchObject({ stop: "error", error: "401 invalid api key", resume: one.resume });
    input.input = { kind: "text", text: "after" };
    expect((await engine.turn(input, io)).metrics?.runtime).toBe("cold");
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
