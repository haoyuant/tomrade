import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "cordis";
import { z } from "zod";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import { localCli } from "@tomradex/engine-kit";
import type { Block, Engine, TurnIO, TurnInput } from "@tomradex/agent";
import { createAcpEngine, isTomradeTool, PERMISSION_CHOICES, policyOf, type AcpAgent } from "../src/index.js";
import { innermost, resolveChoice } from "../src/runtime.js";

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
  expect(policyOf({ purpose: "backlog", permissionMode: "full-access" }, agent)).toBe("full-access");
  expect(policyOf({ purpose: "backlog", permissionMode: "read-only" }, agent)).toBe("read-only");
  expect(policyOf({ purpose: "code" }, agent)).toBe("full-access");
  expect(policyOf({ purpose: "code", permissionMode: "ask" }, agent)).toBe("ask");
  expect(policyOf({ purpose: "code", permissionMode: "local" }, agent)).toBe("ask");
  expect(policyOf({ purpose: "general", permissionMode: "read-only" }, agent)).toBe("read-only");
  for (const name of ["mcp__tomrade__create_item", "mcp_tomrade_list_items"]) expect(isTomradeTool({ name })).toBe(true);
  expect(isTomradeTool({ title: "mcp__tomrade__list_items", kind: "other" })).toBe(true);
  expect(isTomradeTool({ title: "DeferExecuteTool", args: { toolName: "mcp__tomrade__list_items", params: {} } })).toBe(true);
  expect(isTomradeTool({ name: "Bash", title: "Run npm test" })).toBe(false);
  // A title or a path that merely says tomrade is not Tomrade's tool.
  expect(isTomradeTool({ title: "write_file: /Users/a/Projects/tomrade/notes.md", kind: "edit" })).toBe(false);
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

  describe("the model list before the first turn", () => {
    const until = async (cond: () => boolean) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > 10_000) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };
    const LISTED = [{ value: '["fake","small"]', label: "small" }, { value: '["fake","large"]', label: "Large · x2 credits" }];
    beforeEach(() => {
      ctx.provide("agent", { settingsOf: () => ({ engines: { fake: { command: bin } } }) } as never);
      ctx.provide("db", { config: { dir } } as never);
      process.env.TOMRADE_TEST_LOG = log;
    });
    afterEach(() => { delete process.env.TOMRADE_TEST_LOG; });

    it("asks a short session of its own in the background, keeps what it offered, and stops it", async () => {
      const engine = createAcpEngine(ctx, spec());
      expect(engine.local!.picks!()[0]!.choices).toEqual([]);
      expect((await engine.available()).ok).toBe(true);
      expect(engine.local!.picks!()[0]).toMatchObject({ key: "model", pending: true });
      await until(() => engine.local!.picks!()[0]!.choices.length > 0);
      expect(engine.local!.picks!()[0]).toEqual({ key: "model", title: "Model", freeText: true, choices: LISTED });
      // In Tomrade's own folder, without its tools, and never prompted.
      const [opened] = sent("session/new");
      expect(opened.params).toEqual({ cwd: path.join(dir, "acp-models"), mcpServers: [] });
      expect(sent("session/prompt")).toHaveLength(0);
      const pid = requests().find((r) => r.spawn)!.spawn;
      await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
      // Once known, nothing asks again.
      await engine.available({ fresh: true });
      expect(requests().filter((r) => r.spawn)).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "acp-models.json"), "utf8")).fake.models).toEqual(LISTED);
    });

    it("puts its own machine-wide picks before the model and effort, without duplicating the session's", () => {
      const region = { key: "region", title: "Version", global: true, choices: [{ value: "china" }, { value: "international" }] };
      const declared = { key: "model", title: "Model", choices: [], freeText: true };
      const engine = createAcpEngine(ctx, spec({ picks: [region, declared] }));
      expect(engine.local!.picks!()[0]).toEqual(region);
      // The declared model pick is a terminal/lent knob; the session's own is the one shown.
      expect(engine.local!.picks!().filter((pick) => pick.key === "model")).toHaveLength(1);
      expect(engine.local!.picks!()[1]).toMatchObject({ key: "model", freeText: true, choices: [] });
    });

    it("shows what was kept at once after a restart, without asking", async () => {
      fs.writeFileSync(path.join(dir, "acp-models.json"), JSON.stringify({ fake: { models: [{ value: "kept/one" }], efforts: [{ value: "high" }] } }));
      const engine = createAcpEngine(ctx, spec());
      expect(engine.local!.picks!()).toEqual([
        { key: "model", title: "Model", freeText: true, choices: [{ value: "kept/one" }] },
        { key: "effort", title: "Effort", choices: [{ value: "high" }] }
      ]);
      await engine.available();
      expect(fs.existsSync(log)).toBe(false);
    });

    it("keeps what a turn's session offered", async () => {
      fs.writeFileSync(path.join(dir, "acp-models.json"), JSON.stringify({ fake: { models: [{ value: "old/one" }] } }));
      const engine = createAcpEngine(ctx, spec());
      expect((await engine.turn(turnInput(), turnIO().io)).stop).toBe("end");
      expect(JSON.parse(fs.readFileSync(path.join(dir, "acp-models.json"), "utf8")).fake.models).toEqual(LISTED);
    });

    it("leaves the list empty, says why, and does not ask again at once, when the agent cannot answer", async () => {
      const runs = path.join(dir, "runs");
      fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = --version ] && { echo 1.0.0; exit 0; }\necho run >> '${runs}'\nexit 3\n`, { mode: 0o700 });
      const engine = createAcpEngine(ctx, spec());
      expect((await engine.available()).ok).toBe(true);
      await until(() => fs.existsSync(runs) && !engine.local!.picks!()[0]!.pending);
      await engine.available();
      expect(engine.local!.picks!()[0]).toMatchObject({ key: "model", title: "Model", freeText: true, choices: [], failed: expect.any(String) });
      expect(engine.local!.picks!()[0]!.failed).not.toBe("");
      expect(fs.readFileSync(runs, "utf8").trim().split("\n")).toHaveLength(1);
      expect(fs.existsSync(path.join(dir, "acp-models.json"))).toBe(false);
    });

    it("asks again once the person rechecks, say after signing in, and again on the next start when nothing was learned", async () => {
      const runs = path.join(dir, "runs");
      fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = --version ] && { echo 1.0.0; exit 0; }\necho run >> '${runs}'\nexit 3\n`, { mode: 0o700 });
      const engine = createAcpEngine(ctx, spec());
      await engine.available();
      await until(() => fs.existsSync(runs) && !engine.local!.picks!()[0]!.pending);
      // Signed in now: Recheck asks at once, and the list comes.
      fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-acp/tests/fake-acp.mjs")}' "$@"\n`, { mode: 0o700 });
      await engine.available({ fresh: true });
      await until(() => engine.local!.picks!()[0]!.choices.length > 0);
      expect(engine.local!.picks!()[0]!.choices).toEqual(LISTED);
      // An empty list kept from an earlier start does not stand in for one: the next start asks.
      fs.writeFileSync(path.join(dir, "acp-models.json"), JSON.stringify({ fake: { models: [], efforts: [{ value: "high" }] } }));
      const next = createAcpEngine(ctx, spec());
      await next.available();
      await until(() => next.local!.picks!()[0]!.choices.length > 0);
      expect(next.local!.picks!()[0]!.choices).toEqual(LISTED);
    });

    it("says nothing failed once the agent answers", async () => {
      const runs = path.join(dir, "runs");
      const real = fs.readFileSync(bin, "utf8");
      fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = --version ] && { echo 1.0.0; exit 0; }\necho run >> '${runs}'\nexit 3\n`, { mode: 0o700 });
      const engine = createAcpEngine(ctx, spec());
      await engine.available();
      await until(() => !!engine.local!.picks!()[0]!.failed);
      fs.writeFileSync(bin, real, { mode: 0o700 });
      await engine.available({ fresh: true });
      await until(() => engine.local!.picks!()[0]!.choices.length > 0);
      expect(engine.local!.picks!()[0]).toEqual({ key: "model", title: "Model", freeText: true, choices: LISTED });
    });
  });

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
    // The same token in the environment, for a user-level server that names ${TOMRADE_MCP_TOKEN}.
    expect(requests().find((r) => r.spawn)?.token).toBe(opened.params.mcpServers[0].headers[0].value);
    expect(sent("session/set_config_option").map((r) => [r.params.configId, r.params.value])).toEqual([["mode", "bypass"], ["model", '["fake","large"]'], ["reasoning_effort", "low"]]);
    const [first] = sent("session/prompt");
    expect(first.params.prompt[0].text).toContain("You are conducting a thread inside Tomrade");
    expect(first.params.prompt[0].text).toContain("USER MESSAGE:\n\nhello");
    expect(first.params.prompt[1]).toEqual({ type: "image", data: "YWJj", mimeType: "image/png" });

    // The model list the session offered is what the picks show next.
    expect(engine.local!.picks!()).toEqual([
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
    expect(failed.details).toMatch(/RpcError: Authentication required\ncode: -32000/);
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

  it("takes a mode picked mid-turn: the request waiting for the person is allowed once the mode is Full access", async () => {
    const engine = createAcpEngine(ctx, spec());
    expect(engine.liveModes).toBe(true);
    const { io, blocks } = turnIO();
    let apply: ((mode: string) => Promise<boolean>) | undefined;
    io.modeTo = (fn) => { apply = fn; };
    const took: boolean[] = [];
    // the person never answers: only the mode settles it
    io.requestPermission = (_text, _options, signal) => {
      void apply!("full-access").then((ok) => took.push(ok));
      return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(null), { once: true }));
    };
    const result = await engine.turn(turnInput({ input: { kind: "text", text: "TOOL" }, permissionMode: "ask" }), io);
    expect(result.stop, result.error).toBe("end");
    expect(took).toEqual([true]);
    expect(blocks.filter((b) => b.type === "trace")).toEqual([expect.objectContaining({ tool: "Bash", ok: true })]);
    expect(blocks).toContainEqual({ type: "note", text: expect.stringContaining("Allowed without asking") });
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
    expect(allowedEdit.asked).toEqual(["Fake: write: /work/tomrade/notes.md\n{\n  \"path\": \"notes.md\"\n}"]);
    expect(allowedEdit.traces).toEqual([expect.objectContaining({ tool: "write: /work/tomrade/notes.md", ok: true })]);
    expect((await silent("Deny")).traces).toEqual([expect.objectContaining({ ok: false })]);

    fs.writeFileSync(log, "");
    // The main chat has the agent's own tools too.
    const backlog = await run({ purpose: "backlog" });
    expect(backlog.blocks).toContainEqual({ type: "text", text: "ran it" });
    expect(outcomes()).toEqual(["yes", "yes"]);
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
    expect(engine.local!.picks!()[0]!.choices).toEqual([{ value: "openrouter:a", label: "a" }, { value: "openrouter:b", label: "b" }]);
    // An agent whose inputTokens leaves out the cache (OpenCode) has it added back.
    const apart = await createAcpEngine(ctx, spec({ httpMcp: "always", reopen: "load", usage: "turn", cacheApart: true })).turn(input, turnIO().io);
    expect(apart.usage).toEqual({ inputTokens: 60, outputTokens: 5 });
    expect(apart.metrics).toMatchObject({ cacheReadTokens: 10, uncachedInputTokens: 50 });

    const second = createAcpEngine(ctx, spec({ httpMcp: "always", reopen: "load", usage: "turn" }));
    const resumed = turnIO();
    resumed.io.resume = one.resume;
    const again = await second.turn({ ...input, input: { kind: "text", text: "again" } }, resumed.io);
    expect(again.stop, again.error).toBe("end");
    expect(sent("session/load").map((r) => r.params.sessionId)).toEqual([one.resume]);
    // The replayed history reached no one.
    expect(resumed.blocks.some((b) => b.type === "text" && b.text.includes("OLD HISTORY"))).toBe(false);
    expect(sent("session/set_mode").map((r) => r.params.modeId)).toEqual([]);

    // A session it no longer has is reported, not silently replaced: Tomrade runs the turn again without it, with the conversation carried in.
    const gone = turnIO();
    gone.io.resume = "gone";
    gone.io.recap = () => "RECAP OF EARLIER";
    const engineAgain = createAcpEngine(ctx, spec({ httpMcp: "always", reopen: "load", usage: "turn" }));
    const lost = await engineAgain.turn({ ...input, input: { kind: "text", text: "anew" } }, gone.io);
    expect(lost).toMatchObject({ stop: "error", lostSession: true });
    gone.io.resume = undefined;
    const fresh = await engineAgain.turn({ ...input, input: { kind: "text", text: "anew" } }, gone.io);
    expect(fresh.resume).not.toBe("gone");
    const text = sent("session/prompt").at(-1).params.prompt[0].text as string;
    expect(text).toContain("You are conducting a thread inside Tomrade");
    expect(text).toContain("RECAP OF EARLIER");
  });

  it("knows a call named only in its id, so Tomrade's tool runs in a read-only turn and is traced once", async () => {
    const engine = createAcpEngine(ctx, spec({ callName: (id) => (id.includes("__") ? id.slice(0, id.indexOf("__")) : undefined) }));
    const { io, blocks } = turnIO();
    io.requestPermission = async () => { throw new Error("nothing is put to the person in a read-only turn"); };
    const result = await engine.turn(turnInput({ purpose: "backlog", permissionMode: "read-only", input: { kind: "text", text: "NAMED_BY_ID" } }), io);
    expect(result.stop, result.error).toBe("end");
    expect(blocks).toContainEqual({ type: "text", text: "ran, refused" });
    expect(requests().filter((r) => r.result?.outcome).map((r) => r.result.outcome.optionId)).toEqual(["proceed_once", "cancel"]);
    // Tomrade's own call is traced by its gateway; the agent's is traced under its own name.
    expect(blocks.filter((b) => b.type === "trace")).toEqual([expect.objectContaining({ tool: "run_shell_command", ok: false })]);
  });

  it("opens a new session with the conversation recapped for an agent that never reopens one", async () => {
    const first = createAcpEngine(ctx, spec({ reopen: "never" }));
    const one = await first.turn(turnInput(), turnIO().io);
    expect(one.stop, one.error).toBe("end");

    const cold = createAcpEngine(ctx, spec({ reopen: "never" }));
    const { io } = turnIO();
    io.resume = one.resume;
    io.recap = () => "RECAP OF EARLIER";
    const two = await cold.turn(turnInput({ input: { kind: "text", text: "again" } }), io);
    expect(two.stop, two.error).toBe("end");
    expect(two.resume).not.toBe(one.resume);
    expect([...sent("session/load"), ...sent("session/resume")]).toEqual([]);
    expect(sent("session/new")).toHaveLength(2);
    const text = sent("session/prompt").at(-1).params.prompt[0].text as string;
    expect(text).toContain("You are conducting a thread inside Tomrade");
    expect(text).toContain("RECAP OF EARLIER");
  });

  it("says the innermost message of a model API error passed on as JSON, and how to sign in", async () => {
    const engine = createAcpEngine(ctx, spec());
    const failed = await engine.turn(turnInput({ input: { kind: "text", text: "BAD_KEY" } }), turnIO().io);
    expect(failed).toMatchObject({ stop: "error", error: "API key not valid. Please pass a valid API key. — run fake login, then try again" });
    expect(failed.details).toContain("INVALID_ARGUMENT");
    expect(innermost("plain words")).toBe("plain words");
    expect(innermost('{"error":{"code":500}}')).toBe('{"error":{"code":500}}');
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

  describe("steering", () => {
    const steering = (style?: string) => {
      const { io, blocks, deltas } = turnIO();
      const order: string[] = [];
      io.emit = (block) => { blocks.push(block); order.push(block.type === "text" ? `agent:${block.text}` : block.type); };
      let forward: ((steer: { id: string; text: string }) => Promise<boolean>) | undefined;
      io.steerTo = (fn) => { forward = fn; };
      io.steered = (id) => order.push(`steered:${id}`);
      const env = { TOMRADE_TEST_LOG: log, ...(style ? { FAKE_STYLE: style } : {}) };
      return { io, order, deltas, env, forward: (id: string, text: string) => forward!({ id, text }) };
    };
    const hermesMode = (policy: string) => (policy === "full-access" ? "dont_ask" : "default");
    const when = async (cond: () => boolean) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > 5000) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };

    it("hands a message to CodeBuddy's session/steer and records it at the agent's receipt", async () => {
      const engine = createAcpEngine(ctx, spec({ steer: "method" }));
      expect(engine.steering).toBe("forward");
      const { io, order, env, forward } = steering();
      const turn = engine.turn(turnInput({ input: { kind: "text", text: "STEER_TOOL" }, env }), io);
      await when(() => fs.existsSync(log) && sent("session/prompt").length > 0);
      await new Promise((r) => setTimeout(r, 100));
      expect(await forward("s1", "make it blue")).toBe(true);
      expect(await forward("s2", "and shiny")).toBe(true);
      expect((await turn).stop).toBe("end");
      expect(order).toEqual(["trace", "steered:s1", "steered:s2", expect.stringMatching(/^agent:took: make it blue\n\n\(Sent while you were working.*\+ and shiny/s)]);
      const [first, second] = sent("session/steer").map((r) => r.params);
      expect(first).toMatchObject({ contentBlocks: [{ type: "text", text: expect.stringMatching(/^make it blue\n\n\(Sent while you were working/) }], clientUserMessageId: "s1" });
      expect(first.expectedRequestId).toBeUndefined();
      // the next joins only the run the first one joined
      expect(second.expectedRequestId).toMatch(/^run-/);
      // idle once the turn is over
      expect(await forward("s3", "late")).toBe(false);
    });

    it("leaves a CodeBuddy steer the turn never read to go back to the queue, and refuses an idle one", async () => {
      const engine = createAcpEngine(ctx, spec({ steer: "method" }));
      const { io, order, env, forward } = steering();
      let turn = engine.turn(turnInput({ input: { kind: "text", text: "STEER_LATE" }, env }), io);
      await when(() => order.length > 0 || (fs.existsSync(log) && sent("session/prompt").length > 0));
      await new Promise((r) => setTimeout(r, 100));
      expect(await forward("s1", "end with an emoji")).toBe(true);
      expect((await turn).stop).toBe("end");
      expect(order).toEqual(["agent:part one, part two"]);

      order.length = 0;
      turn = engine.turn(turnInput({ input: { kind: "text", text: "STEER_IDLE" }, env }), io);
      const answered = await turn;
      expect(answered.stop).toBe("end");
      expect(await forward("s2", "too late")).toBe(false);
    });

    it("sends Hermes a /steer alongside, keeps its acknowledgement out of the reply, and records it where Hermes reads it", async () => {
      const engine = createAcpEngine(ctx, spec({ steer: "slash", mode: hermesMode }));
      const { io, order, deltas, env, forward } = steering("hermes");
      const turn = engine.turn(turnInput({ input: { kind: "text", text: "STEER_TOOL" }, env }), io);
      await when(() => order.includes("trace") || (fs.existsSync(log) && sent("session/prompt").length > 0));
      await new Promise((r) => setTimeout(r, 100));
      expect(await forward("s1", "make it blue")).toBe(true);
      const result = await turn;
      expect(result.stop).toBe("end");
      expect(order).toEqual(["steered:s1", expect.stringMatching(/^agent:took: make it blue\n\n\(Sent while/), "trace"]);
      expect(deltas.join("")).not.toContain("Steer queued");
      expect(sent("session/prompt").map((r) => r.params.prompt[0].text).filter((t: string) => t.startsWith("/steer"))).toEqual([expect.stringMatching(/^\/steer make it blue\n\n\(Sent while/)]);
    });

    it("leaves a Hermes steer acknowledged mid-reply unread when no tool follows, and waits out one that arrived as the turn ended", async () => {
      const engine = createAcpEngine(ctx, spec({ steer: "slash", usage: "turn", mode: hermesMode }));
      const { io, order, deltas, env, forward } = steering("hermes");
      let turn = engine.turn(turnInput({ input: { kind: "text", text: "STEER_LATE" }, env }), io);
      await when(() => deltas.length > 0);
      expect(await forward("s1", "end with an emoji")).toBe(true);
      expect((await turn).stop).toBe("end");
      expect(order).toEqual(["agent:part one, part two"]);
      expect(deltas.join("")).not.toContain("Steer queued");

      // the turn is answered before the /steer: Hermes runs it as a prompt of its own, and this turn takes it in
      order.length = 0;
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const original = io.delta;
      io.delta = (text) => { original(text); if (text === "quick") void forward("s2", "one more thing").then(() => release()); };
      turn = engine.turn(turnInput({ input: { kind: "text", text: "STEER_IDLE" }, env }), io);
      await hold;
      const result = await turn;
      expect(result.stop).toBe("end");
      expect(order).toEqual(["agent:quick", "steered:s2", expect.stringMatching(/^agent:fresh: one more thing\n\n\(Sent while/)]);
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 2 });
    });

    it("ends the agent on a stop while a steer is unread, rather than leave it queued to run", async () => {
      const engine = createAcpEngine(ctx, spec({ steer: "method" }));
      const { io, env, forward } = steering();
      const abort = new AbortController(); io.signal = abort.signal;
      const turn = engine.turn(turnInput({ input: { kind: "text", text: "WAIT_FOREVER" }, env }), io);
      await when(() => fs.existsSync(log) && sent("session/prompt").length > 0);
      await new Promise((r) => setTimeout(r, 100));
      expect(await forward("s1", "never read")).toBe(true);
      abort.abort();
      expect((await turn).stop).toBe("cancelled");
      expect(sent("session/cancel")).toHaveLength(0);
      io.signal = new AbortController().signal;
      expect((await engine.turn(turnInput({ env }), io)).stop).toBe("end");
      expect(requests().filter((r) => r.spawn)).toHaveLength(2);
    });

    it("leaves an agent that declares no steering to the queue", () => {
      expect(createAcpEngine(ctx, spec()).steering).toBeUndefined();
    });
  });
});

