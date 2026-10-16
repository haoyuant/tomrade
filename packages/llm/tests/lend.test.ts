/**
 * A signed-in local agent lends its model for worker calls, so planning works
 * with a subscription and no API key — but only until a profile exists.
 */
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { expect, it } from "vitest";
import { z } from "zod";
import { Settings } from "@tomradex/settings";
import { LENT_CONCURRENCY, Llm, transcriptOf, userMessage, type ChatModel, type ChatRequest } from "@tomradex/llm";

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

it("answers with the lent model the person chose, even with a profile, and never swaps it silently", async () => {
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
