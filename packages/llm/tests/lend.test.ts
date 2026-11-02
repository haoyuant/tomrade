/**
 * A signed-in local agent lends its model for worker calls, so planning works
 * with a subscription and no API key, and goes on working when a profile fails.
 */
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { Db } from "@tomradex/db";
import { Settings } from "@tomradex/settings";
import { LENDER_WAIT_MS, LENT_CONCURRENCY, Llm, WORKER_COOLDOWN_MS, transcriptOf, userMessage, type ChatModel, type ChatRequest } from "@tomradex/llm";

function lent(answer: string, requests: ChatRequest[]): ChatModel {
  return {
    capabilities: { tools: false, streaming: false, json: false },
    async *chat(request) {
      requests.push(request);
      yield { type: "text", delta: answer };
      yield { type: "stop", reason: "end" };
    }
  };
}

it("answers worker calls with a ready lent model while no profile is configured", async () => {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-lend-${Date.now()}.json`) });
  await ctx.plugin(Llm);
  const schema = z.object({ n: z.number() });
  const asked = { a: [] as ChatRequest[], b: [] as ChatRequest[] };
  let aReady = false;
  ctx.llm.lend({ id: "a", title: "Agent A", ready: async () => aReady, model: lent('{"n":1}', asked.a) });
  const withdraw = ctx.llm.lend({ id: "b", title: "Agent B", ready: async () => true, model: lent('```json\n{"n":2}\n```', asked.b) });

  expect(await ctx.llm.worker()).toEqual({ ok: true, via: "lent", title: "Agent B" });
  expect(await ctx.llm.completeJson(schema, { system: "count", user: "go" })).toEqual({ n: 2 });
  expect(asked.b[0]).toMatchObject({ system: "count" });
  aReady = true;
  expect(await ctx.llm.completeJson(schema, { system: "count", user: "go" })).toEqual({ n: 1 });

  withdraw();
  aReady = false;
  expect(await ctx.llm.worker()).toMatchObject({ ok: false });
  await expect(ctx.llm.completeJson(schema, { system: "count", user: "go" })).rejects.toThrow(/No model profile/);
  // the loop engine still needs a real profile: a lent model has no tools
  expect(ctx.llm.ready().ok).toBe(false);

  aReady = true;
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [{ id: "p", title: "", provider: "openai-compatible", apiKey: "k", model: "m" }], roles: { worker: "" } } });
  expect(await ctx.llm.worker()).toEqual({ ok: true, via: "profile", title: "m" });
});

it("asks the lowest-ranked ready lent model in Automatic, whatever order the plugins lent in", async () => {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-lend-rank-${Date.now()}.json`) });
  await ctx.plugin(Llm);
  const schema = z.object({ n: z.number() });
  const ready = new Set(["unranked", "gemini", "codex", "workbuddy"]);
  const lend = (id: string, rank: number | undefined, n: number) =>
    ctx.llm.lend({ id, title: id, ...(rank === undefined ? {} : { rank }), ready: async () => ready.has(id), model: lent(`{"n":${n}}`, []) });
  lend("unranked", undefined, 0);
  lend("gemini", 40, 4);
  lend("codex", 30, 3);
  lend("claude-code", 10, 1);
  lend("workbuddy", 20, 2);

  expect((await ctx.llm.lenders()).map((l) => l.id)).toEqual(["claude-code", "workbuddy", "codex", "gemini", "unranked"]);
  expect(await ctx.llm.worker()).toEqual({ ok: true, via: "lent", title: "workbuddy" });
  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u" })).toEqual({ n: 2 });
  ready.add("claude-code");
  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u" })).toEqual({ n: 1 });
  ready.clear();
  ready.add("unranked");
  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u" })).toEqual({ n: 0 });
});

it("shows a lent model whose sign-in check is slow as still checking, and its answer on the next look", async () => {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-lend-checking-${Date.now()}.json`) });
  await ctx.plugin(Llm);
  let checked: Promise<boolean> | null = null;
  const slowCheck = () => (checked ??= new Promise((resolve) => setTimeout(() => resolve(true), LENDER_WAIT_MS + 300)));
  ctx.llm.lend({ id: "slow", title: "Slow", ready: slowCheck, model: lent("{}", []) });
  ctx.llm.lend({ id: "quick", title: "Quick", ready: async () => false, model: lent("{}", []) });
  const t0 = Date.now();
  expect((await ctx.llm.lenders()).map((l) => l.ready)).toEqual([null, false]);
  expect(Date.now() - t0).toBeLessThan(LENDER_WAIT_MS + 250);
  await checked;
  expect((await ctx.llm.lenders()).map((l) => l.ready)).toEqual([true, false]);
});

it("answers with the lent model the person chose, even with a profile, and never swaps it for that profile", async () => {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-lend-chosen-${Date.now()}.json`) });
  await ctx.plugin(Llm);
  const schema = z.object({ n: z.number() });
  const asked: ChatRequest[] = [];
  let ready = true;
  ctx.llm.lend({ id: "claude-code", title: "Claude Code", ready: async () => ready, model: lent('{"n":7}', asked) });
  const profile = { id: "p", title: "", provider: "openai-compatible" as const, apiKey: "k", model: "m" };
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [profile], roles: { worker: "lent:claude-code" } } });

  expect(await ctx.llm.worker()).toEqual({ ok: true, via: "lent", title: "Claude Code" });
  expect(await ctx.llm.completeJson(schema, { system: "count", user: "go" })).toEqual({ n: 7 });

  ready = false;
  expect(await ctx.llm.worker()).toMatchObject({ ok: false, reason: expect.stringMatching(/Claude Code/) });
  await expect(ctx.llm.completeJson(schema, { system: "count", user: "go" })).rejects.toThrow(/set to Claude Code/);
  expect(asked).toHaveLength(1);
});

it("runs at most LENT_CONCURRENCY lent calls at once and lets a withdrawn caller leave the queue", async () => {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-lend-slots-${Date.now()}.json`) });
  await ctx.plugin(Llm);
  let running = 0;
  let peak = 0;
  const gates: (() => void)[] = [];
  const slow: ChatModel = {
    capabilities: { tools: false, streaming: false, json: false },
    async *chat() {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running -= 1;
      yield { type: "text", delta: '{"n":1}' };
      yield { type: "stop", reason: "end" };
    }
  };
  ctx.llm.lend({ id: "a", title: "A", ready: async () => true, model: slow });
  const schema = z.object({ n: z.number() });
  const withdrawn = new AbortController();
  const calls = [0, 1, 2].map(() => ctx.llm.completeJson(schema, { system: "s", user: "u" }));
  const leaving = ctx.llm.completeJson(schema, { system: "s", user: "u", signal: withdrawn.signal });
  await new Promise((r) => setTimeout(r, 10));
  expect(running).toBe(LENT_CONCURRENCY);
  withdrawn.abort(new Error("gone"));
  await expect(leaving).rejects.toThrow(/gone/);
  while (gates.length || running) {
    gates.shift()?.();
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(await Promise.all(calls)).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }]);
  expect(peak).toBe(LENT_CONCURRENCY);
});

it("flattens a repair round into one prompt", () => {
  expect(transcriptOf([userMessage("plan it")])).toBe("plan it");
  const prompt = transcriptOf([userMessage("plan it"), { role: "assistant", content: [{ type: "text", text: "{bad" }] }, userMessage("fix the JSON")]);
  expect(prompt).toBe("USER:\nplan it\n\nYOU (earlier):\n{bad\n\nUSER:\nfix the JSON");
});

async function withProfile(name: string, worker = "") {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-lend-${name}-${Date.now()}.json`) });
  await ctx.plugin(Llm);
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [{ id: "p", title: "", provider: "openai-compatible", apiKey: "k", model: "m" }], roles: { worker } } });
  const fromProfile: ChatRequest[] = [];
  vi.spyOn(ctx.llm, "for").mockReturnValue(lent('{"n":9}', fromProfile));
  return { ctx, fromProfile };
}

const refusing: ChatModel = {
  capabilities: { tools: false, streaming: false, json: false },
  async *chat() {
    throw new Error("out of credit");
  }
};

it("a call that prefers an engine asks that agent before a profile, and the first ready one when it cannot", async () => {
  const { ctx, fromProfile } = await withProfile("prefer");
  const schema = z.object({ n: z.number() });
  let namedReady = true;
  ctx.llm.lend({ id: "first", title: "First", rank: 10, ready: async () => true, model: lent('{"n":1}', []) });
  ctx.llm.lend({ id: "named", title: "Named", rank: 20, ready: async () => namedReady, model: lent('{"n":2}', []) });

  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u", preferEngine: "named" })).toEqual({ n: 2 });
  namedReady = false;
  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u", preferEngine: "named" })).toEqual({ n: 1 });
  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u", preferEngine: "tomrade" })).toEqual({ n: 1 });
  expect(fromProfile).toEqual([]);
  // without the wish, a profile still answers worker calls
  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u" })).toEqual({ n: 9 });
});

it("falls back to the worker when the preferred agent fails", async () => {
  const { ctx } = await withProfile("fallback");
  ctx.llm.lend({ id: "named", title: "Named", ready: async () => true, model: refusing });
  expect(await ctx.llm.completeJson(z.object({ n: z.number() }), { system: "s", user: "u", preferEngine: "named" })).toEqual({ n: 9 });
});

it("asks a failing agent only once when it is the worker too", async () => {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-lend-once-${Date.now()}.json`) });
  await ctx.plugin(Llm);
  const chat = vi.spyOn(refusing, "chat");
  ctx.llm.lend({ id: "named", title: "Named", ready: async () => true, model: refusing });
  await expect(ctx.llm.completeJson(z.object({ n: z.number() }), { system: "s", user: "u", preferEngine: "named" })).rejects.toThrow(/out of credit/);
  expect(chat).toHaveBeenCalledTimes(1);
});

it("a worker the person picked is not passed over", async () => {
  const { ctx } = await withProfile("chosen", "p");
  ctx.llm.lend({ id: "named", title: "Named", ready: async () => true, model: lent('{"n":2}', []) });
  expect(await ctx.llm.completeJson(z.object({ n: z.number() }), { system: "s", user: "u", preferEngine: "named" })).toEqual({ n: 9 });
});

const schema = z.object({ n: z.number() });
const CREDIT = "Your credit balance is too low";

function failing(message: string, after = 0): ChatModel {
  return {
    capabilities: { tools: false, streaming: false, json: false },
    async *chat() {
      if (after) await new Promise((r) => setTimeout(r, after));
      throw new Error(message);
    }
  };
}

function counted(model: ChatModel) {
  return { model, chat: vi.spyOn(model, "chat") };
}

/** A profile that fails like an account out of credit, and the agent that can answer instead. */
async function outOfCredit(name: string, worker = "") {
  const { ctx } = await withProfile(name, worker);
  const profile = counted(failing(CREDIT));
  vi.spyOn(ctx.llm, "for").mockReturnValue(profile.model);
  const fromAgent: ChatRequest[] = [];
  let agentReady = true;
  ctx.llm.lend({ id: "agent", title: "Agent", ready: async () => agentReady, model: lent('{"n":2}', fromAgent) });
  return { ctx, profile, fromAgent, setAgentReady: (ready: boolean) => (agentReady = ready) };
}

afterEach(() => vi.restoreAllMocks());

it.each([["Automatic", ""], ["a profile the person picked", "p"]])("%s out of credit: the first ready agent answers", async (_, worker) => {
  const { ctx, profile, fromAgent } = await outOfCredit(`credit-${worker}`, worker);
  ctx.llm.lend({ id: "asleep", title: "Asleep", rank: 1, ready: async () => false, model: lent('{"n":3}', []) });
  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u" })).toEqual({ n: 2 });
  expect(profile.chat).toHaveBeenCalledTimes(1);
  expect(fromAgent).toHaveLength(1);
});

it("a lent worker that fails gives way to the next ready agent, once", async () => {
  const { ctx } = await withProfile("lent-fails", "lent:picked");
  const picked = counted(failing("logged out"));
  const next = counted(failing("also out"));
  ctx.llm.lend({ id: "picked", title: "Picked", rank: 1, ready: async () => true, model: picked.model });
  ctx.llm.lend({ id: "other", title: "Other", rank: 2, ready: async () => true, model: lent('{"n":2}', []) });
  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u" })).toEqual({ n: 2 });
  ctx.llm.lend({ id: "first", title: "First", rank: 1.5, ready: async () => true, model: next.model });
  await expect(ctx.llm.completeJson(schema, { system: "s", user: "u" })).rejects.toThrow("logged out");
  expect(picked.chat).toHaveBeenCalledTimes(2);
  expect(next.chat).toHaveBeenCalledTimes(1);
});

it("a picked agent that is not ready gives way to one that is, and the status names who answers", async () => {
  const { ctx } = await withProfile("lent-away", "lent:picked");
  let other = lent('{"n":2}', []);
  ctx.llm.lend({ id: "picked", title: "Picked", ready: async () => false, model: lent('{"n":1}', []) });
  ctx.llm.lend({ id: "other", title: "Other", ready: async () => true, model: { capabilities: other.capabilities, chat: (request, signal) => other.chat(request, signal) } });
  expect(await ctx.llm.worker()).toEqual({ ok: true, via: "lent", title: "Other" });
  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u" })).toEqual({ n: 2 });
  other = failing("nope");
  await expect(ctx.llm.completeJson(schema, { system: "s", user: "u" })).rejects.toThrow(/set to Picked/);
});

it("skips the agent a call preferred, which has already failed, when the worker fails too", async () => {
  const { ctx, profile, fromAgent } = await outOfCredit("prefer-then-profile");
  const preferred = counted(failing("preferred is out"));
  ctx.llm.lend({ id: "preferred", title: "Preferred", rank: 1, ready: async () => true, model: preferred.model });
  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u", preferEngine: "preferred" })).toEqual({ n: 2 });
  expect(preferred.chat).toHaveBeenCalledTimes(1);
  expect(profile.chat).toHaveBeenCalledTimes(1);
  expect(fromAgent).toHaveLength(1);
});

it("tells the worker's own failure when no agent is ready, or the agent fails too", async () => {
  const { ctx, setAgentReady } = await outOfCredit("nobody");
  setAgentReady(false);
  await expect(ctx.llm.completeJson(schema, { system: "s", user: "u" })).rejects.toThrow(CREDIT);

  const lastResort = await outOfCredit("last-resort");
  lastResort.setAgentReady(false);
  lastResort.ctx.llm.lend({ id: "broken", title: "Broken", ready: async () => true, model: failing("agent broke") });
  const failure = lastResort.ctx.llm.completeJson(schema, { system: "s", user: "u" });
  await expect(failure).rejects.toThrow(CREDIT);
  // and still, once the profile is cooling and only the agent is asked
  await expect(lastResort.ctx.llm.completeJson(schema, { system: "s", user: "u" })).rejects.toThrow(CREDIT);
  expect(lastResort.profile.chat).toHaveBeenCalledTimes(1);
});

it("leaves a failed profile alone while it cools, and says who answers", async () => {
  const { ctx, profile, fromAgent } = await outOfCredit("cooling");
  expect(await ctx.llm.worker()).toEqual({ ok: true, via: "profile", title: "m" });
  await ctx.llm.completeJson(schema, { system: "s", user: "u" });
  expect(await ctx.llm.worker()).toEqual({ ok: true, via: "lent", title: "Agent" });
  await ctx.llm.completeJson(schema, { system: "s", user: "u" });
  await ctx.llm.completeJson(schema, { system: "s", user: "u" });
  expect(profile.chat).toHaveBeenCalledTimes(1);
  expect(fromAgent).toHaveLength(3);

  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + WORKER_COOLDOWN_MS + 1);
  expect(await ctx.llm.worker()).toEqual({ ok: true, via: "profile", title: "m" });
  await ctx.llm.completeJson(schema, { system: "s", user: "u" });
  expect(profile.chat).toHaveBeenCalledTimes(2);
});

it("a settings change ends the cooling", async () => {
  const { ctx, profile } = await outOfCredit("cooling-settings");
  await ctx.llm.completeJson(schema, { system: "s", user: "u" });
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [{ id: "p", title: "", provider: "openai-compatible", apiKey: "topped-up", model: "m" }], roles: { worker: "" } } });
  await ctx.llm.completeJson(schema, { system: "s", user: "u" });
  expect(profile.chat).toHaveBeenCalledTimes(2);
});

it("still asks a cooling profile when nobody else can answer", async () => {
  const { ctx, profile, setAgentReady } = await outOfCredit("cooling-alone");
  await ctx.llm.completeJson(schema, { system: "s", user: "u" });
  setAgentReady(false);
  expect(await ctx.llm.worker()).toEqual({ ok: true, via: "profile", title: "m" });
  await expect(ctx.llm.completeJson(schema, { system: "s", user: "u" })).rejects.toThrow(CREDIT);
  expect(profile.chat).toHaveBeenCalledTimes(2);
});

it("does not move on from a call the caller withdrew", async () => {
  const { ctx, fromAgent } = await outOfCredit("cancelled");
  const hung: ChatModel = {
    capabilities: { tools: false, streaming: true, json: false },
    async *chat(_request, signal) {
      await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
  };
  vi.spyOn(ctx.llm, "for").mockReturnValue(hung);
  const withdrawn = new AbortController();
  const call = ctx.llm.completeJson(schema, { system: "s", user: "u", signal: withdrawn.signal });
  await new Promise((r) => setTimeout(r, 5));
  withdrawn.abort(new Error("gone"));
  await expect(call).rejects.toThrow("gone");
  expect(fromAgent).toEqual([]);
  expect(await ctx.llm.worker()).toMatchObject({ via: "profile" });
});

it("does not move on when the caller's time is up", async () => {
  const { ctx, fromAgent } = await outOfCredit("out-of-time");
  vi.spyOn(ctx.llm, "for").mockReturnValue({
    capabilities: { tools: false, streaming: true, json: false },
    async *chat() {
      await new Promise(() => {});
    }
  });
  await expect(ctx.llm.completeJson(schema, { system: "s", user: "u", timeoutMs: 20 })).rejects.toThrow(/did not answer within/);
  expect(fromAgent).toEqual([]);
  expect(await ctx.llm.worker()).toMatchObject({ via: "profile" });
});

it("gives a stand-in only the time the worker left", async () => {
  const { ctx } = await outOfCredit("time-left");
  vi.spyOn(ctx.llm, "for").mockReturnValue(failing(CREDIT, 30));
  const timeout = vi.spyOn(AbortSignal, "timeout");
  await ctx.llm.completeJson(schema, { system: "s", user: "u", timeoutMs: 10_000 });
  expect(timeout.mock.calls.map(([ms]) => ms)[0]).toBe(10_000);
  expect(timeout.mock.calls.map(([ms]) => ms)[1]).toBeLessThan(10_000);
});

it("does not move on from an answer that does not fit", async () => {
  const { ctx, fromAgent } = await outOfCredit("misfit");
  vi.spyOn(ctx.llm, "for").mockReturnValue(lent('{"n":"many"}', []));
  await expect(ctx.llm.completeJson(schema, { system: "s", user: "u" })).rejects.toThrow(/failed schema validation/);
  expect(fromAgent).toEqual([]);
  expect(await ctx.llm.worker()).toMatchObject({ via: "profile" });
});

it("Anthropic's 400 for an empty balance reaches the agent through the real adapter, and is not asked again", async () => {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-lend-anthropic-${Date.now()}.json`) });
  await ctx.plugin(Llm);
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [{ id: "p", title: "", provider: "anthropic", apiKey: "k", model: "claude-test" }], roles: { worker: "" } } });
  const fetched = vi.fn(async () => new Response('{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', { status: 400 }));
  vi.stubGlobal("fetch", fetched);
  try {
    ctx.llm.lend({ id: "agent", title: "Agent", ready: async () => true, model: lent('{"n":2}', []) });
    expect(await ctx.llm.completeJson(schema, { system: "s", user: "u" })).toEqual({ n: 2 });
    expect(await ctx.llm.completeJson(schema, { system: "s", user: "u" })).toEqual({ n: 2 });
    expect(fetched).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("counts the usage for the model that answered", async () => {
  const ctx = new Context();
  await ctx.plugin(Db, { dir: ":memory:" });
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-lend-usage-${Date.now()}.json`) });
  await ctx.plugin(Llm);
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [{ id: "p", title: "", provider: "openai-compatible", apiKey: "k", model: "m" }], roles: { worker: "" } } });
  vi.spyOn(ctx.llm, "for").mockReturnValue(failing(CREDIT));
  ctx.llm.lend({ id: "agent", title: "Agent", ready: async () => true, model: lent('{"n":2}', []) });
  await ctx.llm.completeJson(schema, { system: "s", user: "u" });
  const { today } = (ctx.llm as unknown as Llm).workerUsage();
  expect(today).toEqual(expect.arrayContaining([expect.objectContaining({ source: "profile:p", calls: 1, failed: 1 }), expect.objectContaining({ source: "lent:agent", calls: 1, failed: 0 })]));
});
