import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "cordis";
import { z } from "zod";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import { localCli } from "@tomradex/engine-claude-code";
import type { Block, Engine, TurnIO, TurnInput } from "@tomradex/agent";
import { createAcpEngine, isTomradeTool, PERMISSION_CHOICES, policyOf, type AcpAgent } from "../src/index.js";
import { resolveChoice } from "../src/runtime.js";

const Options = z.object({ command: z.string().default("tomrade-fake-acp"), model: z.string().optional(), effort: z.string().optional() });

const spec = (over: Partial<AcpAgent<z.infer<typeof Options>>> = {}): AcpAgent<z.infer<typeof Options>> => ({
  id: "fake",
  title: "Fake",
  cli: localCli("tomrade-fake-acp"),
  install: "install it",
  options: Options,
  permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask, PERMISSION_CHOICES["read-only"]] },
  args: () => ["--acp"],
  mode: (policy) => (policy === "full-access" ? "bypass" : "default"),
  usage: (update) => {
    const usage = update._meta?.usage;
    return usage ? { input: usage.prompt_tokens, output: usage.completion_tokens, cacheRead: usage.prompt_cache_hit_tokens } : null;
  },
  signIn: "run fake login",
  ...over
});

it("reads which choice a typed value means", () => {
  const option = { options: [{ group: "fake", options: [{ value: '["fake","small"]', name: "small" }, { value: '["fake","large"]', name: "Large" }] }] };
  expect(resolveChoice(option, '["fake","large"]')).toBe('["fake","large"]');
  expect(resolveChoice(option, "large")).toBe('["fake","large"]');
  expect(resolveChoice(option, "fake/small")).toBe('["fake","small"]');
  expect(resolveChoice({ options: [{ value: "hy3", name: "Hy3" }] }, "hy3")).toBe("hy3");
  expect(resolveChoice(option, "huge")).toBeUndefined();
});

it("settles a turn's policy, and knows Tomrade's own tools under any agent's naming", () => {
  const agent = spec();
  expect(policyOf({ purpose: "backlog", permissionMode: "full-access" }, agent)).toBe("read-only");
  expect(policyOf({ purpose: "code" }, agent)).toBe("full-access");
  expect(policyOf({ purpose: "code", permissionMode: "ask" }, agent)).toBe("ask");
  expect(policyOf({ purpose: "code", permissionMode: "local" }, agent)).toBe("ask");
  expect(policyOf({ purpose: "general", permissionMode: "read-only" }, agent)).toBe("read-only");
  for (const name of ["mcp__tomrade__create_item", "mcp_tomrade_list_items"]) expect(isTomradeTool({ name })).toBe(true);
  expect(isTomradeTool({ title: "mcp__tomrade__list_items", kind: "other" })).toBe(true);
  expect(isTomradeTool({ title: "DeferExecuteTool", args: { toolName: "mcp__tomrade__list_items", params: {} } })).toBe(true);
  expect(isTomradeTool({ name: "Bash", title: "Run npm test" })).toBe(false);
  // A title or a path that merely says tomrade is not Tomrade's tool.
  expect(isTomradeTool({ title: "write_file: /Users/a/Projects/tomrade-next/notes.md", kind: "edit" })).toBe(false);
  expect(isTomradeTool({ title: "rm -rf ~/tomrade", kind: "execute" })).toBe(false);
  expect(isTomradeTool({ title: "mcp__tomrade__x; rm -rf /", kind: "execute" })).toBe(false);
  expect(isTomradeTool({ title: "mcp__tomrade__list_items", kind: "execute" })).toBe(false);
  expect(isTomradeTool({ name: "tomrade/search_files" })).toBe(false);
});

describe("an ACP agent as an engine", () => {
  let dir: string;
  let log: string;
  let bin: string;
  let ctx: Context;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-acp-"));
    log = path.join(dir, "requests.jsonl");
    bin = path.join(dir, "fake-acp");
    fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-acp/tests/fake-acp.mjs")}' "$@"\n`, { mode: 0o700 });
    ctx = new Context();
    await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  });
  afterEach(async () => { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

  const requests = (): any[] => fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
  const sent = (method: string) => requests().filter((r) => r.method === method);
  const turnInput = (over: Partial<TurnInput> = {}): TurnInput => ({
    threadId: "thread", projectId: "project", purpose: "code", cwd: dir, input: { kind: "text", text: "hello" }, messages: [], cards: [], brief: null, pending: null,
    options: { command: bin }, env: { TOMRADE_TEST_LOG: log }, ...over
  });
  const turnIO = () => {
    const blocks: Block[] = [];
    const deltas: string[] = [];
    const progress: unknown[] = [];
    const io: TurnIO = {
      emit: (block) => blocks.push(block), delta: (text) => deltas.push(text), progress: (usage) => progress.push(usage), signal: new AbortController().signal,
      tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
      run: { id: "run", threadId: "thread", projectId: "project", author: "ai:fake", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() }
    };
    return { io, blocks, deltas, progress };
  };

  it("keeps one process across turns: streams text, counts tokens, opens the session with Tomrade's tools and instructions", async () => {
    const engine: Engine = createAcpEngine(ctx, spec());
    const { io, blocks, deltas, progress } = turnIO();
    const ref = { id: "image", name: "input.png", mime: "image/png", size: 3 };
    io.media = { read: () => ({ ...ref, base64: "YWJj" }), path: () => "unused", publish: () => ref };
    const input = turnInput({ input: { kind: "text", text: "hello", attachments: [ref] }, options: { command: bin, model: "Large", effort: "low" } });

    const one = await engine.turn(input, io);
    expect(one.stop, one.error).toBe("end");
    expect(one.resume).toMatch(/^[0-9a-f-]{36}$/);
    expect(deltas).toEqual(["hel", " lo", "bye"]);
    expect(blocks.filter((b) => b.type === "text")).toEqual([{ type: "text", text: "hel lo" }, { type: "text", text: "bye" }]);
    expect(one.usage).toEqual({ inputTokens: 220, outputTokens: 5 });
    expect(one.costUsd).toBeCloseTo(0.25);
    expect(one.metrics).toMatchObject({ transport: "acp", runtime: "cold", cacheReadTokens: 160, uncachedInputTokens: 60, providerModel: '["fake","large"]' });
    expect(progress.at(-1)).toEqual({ inputTokens: 220, outputTokens: 5 });

    const [init] = sent("initialize");
    expect(init.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const [opened] = sent("session/new");
    expect(opened.params.cwd).toBe(dir);
    expect(opened.params.mcpServers).toEqual([{ type: "http", name: "tomrade", url: ctx.mcp.url, headers: [{ name: "X-Tomrade-Run", value: expect.any(String) }] }]);
    expect(sent("session/set_config_option").map((r) => [r.params.configId, r.params.value])).toEqual([["mode", "bypass"], ["model", '["fake","large"]'], ["reasoning_effort", "low"]]);
    const [first] = sent("session/prompt");
    expect(first.params.prompt[0].text).toContain("You are conducting a thread inside Tomrade");
    expect(first.params.prompt[0].text).toContain("USER MESSAGE:\n\nhello");
    expect(first.params.prompt[1]).toEqual({ type: "image", data: "YWJj", mimeType: "image/png" });

    // The model list the session offered is what the picks show next.
    expect(engine.picks!()).toEqual([
      { key: "model", title: "Model", freeText: true, choices: [{ value: '["fake","small"]', label: "small" }, { value: '["fake","large"]', label: "Large · x2 credits" }] },
      { key: "effort", title: "Effort", choices: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] }
    ]);

    io.resume = one.resume;
    const two = await engine.turn({ ...input, input: { kind: "text", text: "again" } }, io);
    expect(two.metrics?.runtime).toBe("warm");
    expect(two.resume).toBe(one.resume);
    expect(two.costUsd).toBeCloseTo(0.25);
    expect(sent("session/prompt")[1].params.prompt[0].text).not.toContain("You are conducting a thread inside Tomrade");
    expect(requests().filter((r) => r.spawn)).toHaveLength(1);
    expect(requests().find((r) => r.spawn).argv).toEqual(["--acp"]);
  });

  it("cancels a running prompt, and starts over cold after an agent error", async () => {
    const engine = createAcpEngine(ctx, spec());
    const { io } = turnIO();
    const abort = new AbortController(); io.signal = abort.signal;
    const waiting = engine.turn(turnInput({ input: { kind: "text", text: "WAIT_FOREVER" } }), io);
    await vi.waitFor(() => expect(fs.existsSync(log) && sent("session/prompt").length).toBe(1), { timeout: 10_000 });
    abort.abort();
    const cancelled = await waiting;
    expect(cancelled.stop).toBe("cancelled");
    expect(sent("session/cancel")).toHaveLength(1);

    io.signal = new AbortController().signal; io.resume = cancelled.resume;
    const failed = await engine.turn(turnInput({ input: { kind: "text", text: "FAIL" } }), io);
    expect(failed).toMatchObject({ stop: "error", error: "Authentication required — run fake login, then try again", resume: cancelled.resume });
    expect(failed.details).toMatch(/AcpError: Authentication required\ncode: -32000/);
    const refused = await engine.turn(turnInput({ input: { kind: "text", text: "REFUSE" } }), io);
    expect(refused).toMatchObject({ stop: "error", error: "Fake refused to go on" });
    expect(refused.details).toContain('"stopReason": "refusal"');
    expect(refused.metrics?.runtime).toBe("cold");
    // Reopened, not restarted: no second copy of the instructions.
    expect(sent("session/resume").map((r) => r.params.sessionId)).toEqual([cancelled.resume]);
    expect(sent("session/prompt").at(-1).params.prompt[0].text).not.toContain("You are conducting a thread inside Tomrade");

    const crashed = await engine.turn(turnInput({ input: { kind: "text", text: "CRASH" } }), io);
    expect(crashed.stop).toBe("error");
    expect(crashed.error).toMatch(/Fake exited with 3/);
  });

  it("says the agent's own words for a refusal, with its whole answer under details", async () => {
    const engine = createAcpEngine(ctx, spec({ failure: (response) => response._meta?.reason }));
    const { io } = turnIO();
    const refused = await engine.turn(turnInput({ input: { kind: "text", text: "REFUSE_SAYING" } }), io);
    expect(refused).toMatchObject({ stop: "error", error: "Fake stopped: upstream said no" });
    expect(refused.details).toMatch(/── response ──[\s\S]*"reason": "upstream said no"/);
  });

  it("answers permission requests for the turn's policy: always Tomrade's tools, the person when asked, refusals when read-only", async () => {
    const engine = createAcpEngine(ctx, spec());
    const outcomes = () => requests().filter((r) => r.result?.outcome).map((r) => r.result.outcome.optionId ?? r.result.outcome.outcome);

    const run = async (over: Partial<TurnInput>, answer?: string | null) => {
      const { io, blocks } = turnIO();
      const asked: string[] = [];
      if (answer !== undefined) io.requestPermission = async (text, options) => { asked.push(text); expect(options).toEqual(["Allow once", "Always allow", "Reject"]); return answer; };
      const result = await engine.turn(turnInput({ input: { kind: "text", text: "TOOL" }, ...over }), io);
      expect(result.stop, result.error).toBe("end");
      return { blocks, asked, traces: blocks.filter((b) => b.type === "trace") };
    };

    const full = await run({});
    expect(full.traces).toEqual([{ type: "trace", tool: "Bash", args: { command: "npm test" }, ok: true, summary: "run by Fake itself", ms: expect.any(Number) }]);
    expect(full.blocks).toContainEqual({ type: "text", text: "ran it" });
    expect(outcomes()).toEqual(["yes", "yes"]);

    fs.writeFileSync(log, "");
    const allowed = await run({ permissionMode: "ask" }, "Allow once");
    expect(allowed.asked).toEqual(['Fake: Run npm test\n{\n  "command": "npm test"\n}']);
    const denied = await run({ permissionMode: "ask" }, "Reject");
    const dismissed = await run({ permissionMode: "ask" }, null);
    expect(denied.blocks).toContainEqual({ type: "text", text: "skipped it" });
    expect(dismissed.traces).toEqual([expect.objectContaining({ tool: "Bash", ok: false })]);
    // Tomrade's own tool was never put to the person.
    expect(outcomes()).toEqual(["yes", "yes", "no", "yes", "no", "yes"]);
    expect(sent("session/set_config_option").filter((r) => r.params.configId === "mode").map((r) => r.params.value)).toEqual([]);

    // A path that mentions tomrade is still asked about, and a call whose end is never reported is traced when the turn ends.
    const silent = async (answer: string | null) => {
      const { io, blocks } = turnIO();
      const asked: string[] = [];
      io.requestPermission = async (text) => { asked.push(text); return answer; };
      const result = await engine.turn(turnInput({ input: { kind: "text", text: "SILENT" }, permissionMode: "ask" }), io);
      expect(result.stop, result.error).toBe("end");
      return { asked, traces: blocks.filter((b) => b.type === "trace") };
    };
    const allowedEdit = await silent("Allow edit");
    expect(allowedEdit.asked).toEqual(["Fake: write: /work/tomrade-next/notes.md\n{\n  \"path\": \"notes.md\"\n}"]);
    expect(allowedEdit.traces).toEqual([expect.objectContaining({ tool: "write: /work/tomrade-next/notes.md", ok: true })]);
    expect((await silent("Deny")).traces).toEqual([expect.objectContaining({ ok: false })]);

    fs.writeFileSync(log, "");
    const backlog = await run({ purpose: "backlog" });
    expect(backlog.blocks).toContainEqual({ type: "text", text: "skipped it" });
    expect(outcomes()).toEqual(["no", "yes"]);
  });

  it("drives an agent that offers modes and models instead of settings, and reports usage per prompt", async () => {
    const engine = createAcpEngine(ctx, spec({ httpMcp: "always", reopen: "load", usage: "turn" }));
    const { io, blocks } = turnIO();
    const env = { TOMRADE_TEST_LOG: log, FAKE_STYLE: "hermes", FAKE_CAPS: JSON.stringify({ loadSession: true, sessionCapabilities: { resume: {} } }) };
    const input = turnInput({ env, options: { command: bin, model: "openrouter:b" }, permissionMode: "ask" });
    const one = await engine.turn(input, io);
    expect(one.stop, one.error).toBe("end");
    expect(one.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
    expect(one.metrics).toMatchObject({ cacheReadTokens: 10, uncachedInputTokens: 40, providerModel: "openrouter:b" });
    expect(sent("session/set_mode").map((r) => r.params.modeId)).toEqual([]);
    expect(sent("session/set_model").map((r) => r.params.modelId)).toEqual(["openrouter:b"]);
    expect(blocks.filter((b) => b.type === "note")).toEqual([]);
    expect(engine.picks!()[0]!.choices).toEqual([{ value: "openrouter:a", label: "a" }, { value: "openrouter:b", label: "b" }]);

    const second = createAcpEngine(ctx, spec({ httpMcp: "always", reopen: "load", usage: "turn" }));
    const resumed = turnIO();
    resumed.io.resume = one.resume;
    const again = await second.turn({ ...input, input: { kind: "text", text: "again" } }, resumed.io);
    expect(again.stop, again.error).toBe("end");
    expect(sent("session/load").map((r) => r.params.sessionId)).toEqual([one.resume]);
    // The replayed history reached no one.
    expect(resumed.blocks.some((b) => b.type === "text" && b.text.includes("OLD HISTORY"))).toBe(false);
    expect(sent("session/set_mode").map((r) => r.params.modeId)).toEqual([]);

    const gone = turnIO();
    gone.io.resume = "gone";
    const fresh = await createAcpEngine(ctx, spec({ httpMcp: "always", reopen: "load", usage: "turn" })).turn({ ...input, input: { kind: "text", text: "anew" } }, gone.io);
    expect(fresh.resume).not.toBe("gone");
    expect(sent("session/prompt").at(-1).params.prompt[0].text).toContain("You are conducting a thread inside Tomrade");
  });

  it("switches an agent with modes to the one a full-access turn wants, and adds up a running session total", async () => {
    const engine = createAcpEngine(ctx, spec({ httpMcp: "always", usage: "session", mode: (policy) => (policy === "full-access" ? "dont_ask" : "default") }));
    const { io } = turnIO();
    const input = turnInput({ env: { TOMRADE_TEST_LOG: log, FAKE_STYLE: "hermes", FAKE_CAPS: "{}" } });
    const one = await engine.turn(input, io);
    expect(sent("session/set_mode").map((r) => r.params.modeId)).toEqual(["dont_ask"]);
    io.resume = one.resume;
    const two = await engine.turn({ ...input, input: { kind: "text", text: "again" } }, io);
    expect(one.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
    expect(two.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
  });

  it("stops a turn that wants the agent to ask when the agent cannot be switched to asking", async () => {
    const engine = createAcpEngine(ctx, spec({ mode: (policy) => (policy === "full-access" ? "yolo" : "careful") }));
    const asking = turnIO();
    const refused = await engine.turn(turnInput({ permissionMode: "ask" }), asking.io);
    expect(refused).toMatchObject({ stop: "error", error: 'Fake did not switch to its "careful" mode: it does not offer that mode' });
    const full = turnIO();
    const result = await engine.turn(turnInput(), full.io);
    expect(result.stop, result.error).toBe("end");
    expect(full.blocks).toContainEqual({ type: "note", text: 'Fake did not switch to its "yolo" mode (it does not offer that mode)' });
  });

  it("refuses an agent that cannot take Tomrade's tools over HTTP", async () => {
    const engine = createAcpEngine(ctx, spec());
    const { io } = turnIO();
    const result = await engine.turn(turnInput({ env: { TOMRADE_TEST_LOG: log, FAKE_CAPS: "{}" } }), io);
    expect(result).toMatchObject({ stop: "error", error: "Fake takes no MCP server over HTTP, so it cannot reach Tomrade's tools" });
  });
});
