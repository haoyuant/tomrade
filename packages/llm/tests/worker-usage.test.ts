/**
 * Worker calls spend tokens — on a profile, or on the person's own Claude Code
 * or Codex limits — that no run shows. Each one is kept as numbers only, by
 * source and purpose, for the Usage pane.
 */
import { Context } from "cordis";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { Db } from "@tomradex/db";
import { Settings } from "@tomradex/settings";
import { Llm, type ChatEvent, type ChatModel } from "@tomradex/llm";
import os from "node:os";
import path from "node:path";

const schema = z.object({ n: z.number() });

/** Answers each call with the next reply, reporting `usage` every time. */
function scripted(replies: string[], usage: Extract<ChatEvent, { type: "usage" }>): ChatModel {
  return {
    capabilities: { tools: false, streaming: false, json: false },
    async *chat() {
      yield usage;
      yield { type: "text", delta: replies.shift() ?? "" };
      yield { type: "stop", reason: "end" };
    }
  };
}

async function setup() {
  const ctx = new Context();
  await ctx.plugin(Db, { dir: ":memory:" });
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-worker-usage-${Date.now()}-${Math.random()}.json`) });
  await ctx.plugin(Llm);
  return { ctx, llm: ctx.llm as unknown as Llm };
}

afterEach(() => vi.unstubAllGlobals());

it("keeps each call's tokens by source and purpose, a repair round included, and failures counted", async () => {
  const { ctx, llm } = await setup();
  const usage = { type: "usage", inputTokens: 15_000, cacheReadTokens: 14_000, outputTokens: 20 } as const;
  ctx.llm.lend({ id: "codex", title: "Codex", ready: async () => true, model: scripted(['{"n":1}', "nope", '{"n":2}', "no", "still no"], usage) });

  await ctx.llm.completeJson(schema, { system: "s", user: "a secret prompt", purpose: "similar" });
  await ctx.llm.completeJson(schema, { system: "s", user: "u", purpose: "similar" });
  await expect(ctx.llm.completeJson(schema, { system: "s", user: "u", purpose: "plan" })).rejects.toThrow(/schema validation/);

  const { today, week } = llm.workerUsage();
  expect(today).toEqual([
    { source: "lent:codex", title: "Codex", purpose: "similar", calls: 2, failed: 0, inputTokens: 45_000, cacheReadTokens: 42_000, outputTokens: 60 },
    { source: "lent:codex", title: "Codex", purpose: "plan", calls: 1, failed: 1, inputTokens: 30_000, cacheReadTokens: 28_000, outputTokens: 40 }
  ]);
  expect(week).toEqual(today);
  // numbers only: nothing of what was asked or answered
  expect(JSON.stringify(ctx.db.hub.prepare("SELECT * FROM plugin_llm_worker_calls").all())).not.toMatch(/secret|"n"/);
});

it("names a profile by its title, and counts yesterday's calls in the week only", async () => {
  const { ctx, llm } = await setup();
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [{ id: "ds", title: "DeepSeek", provider: "openai-compatible", baseURL: "http://localhost/v1", apiKey: "k", model: "deepseek-chat" }], roles: { worker: "" } } });
  vi.stubGlobal("fetch", async () => new Response('data: {"choices":[{"delta":{"content":"{\\"n\\":3}"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":900,"completion_tokens":7,"prompt_cache_hit_tokens":512}}\n\ndata: [DONE]\n\n', { status: 200 }));
  await ctx.llm.completeJson(schema, { system: "s", user: "u", purpose: "dependencies" });
  const tomorrow = Date.now() + 86_400_000;
  expect(llm.workerUsage(tomorrow).today).toEqual([]);
  expect(llm.workerUsage(tomorrow).week).toEqual([{ source: "profile:ds", title: "DeepSeek", purpose: "dependencies", calls: 1, failed: 0, inputTokens: 900, cacheReadTokens: 512, outputTokens: 7 }]);
});

it("answers the call when its numbers cannot be kept", async () => {
  const { ctx, llm } = await setup();
  ctx.llm.lend({ id: "claude-code", title: "Claude Code", ready: async () => true, model: scripted(['{"n":4}'], { type: "usage", inputTokens: 10, outputTokens: 2 }) });
  ctx.db.hub.exec("DROP TABLE plugin_llm_worker_calls");
  expect(await ctx.llm.completeJson(schema, { system: "s", user: "u", purpose: "inbox" })).toEqual({ n: 4 });
  expect(() => llm.workerUsage()).toThrow();
});
