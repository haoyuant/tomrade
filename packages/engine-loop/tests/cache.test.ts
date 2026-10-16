/**
 * A loop turn reports the cache reads and writes its model's provider gave, so
 * its run shows them in the token breakdown like an agent engine's run does.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { fakeChat, type ChatEvent, type ChatModel } from "@tomradex/llm";
import loop from "@tomradex/engine-loop";

async function tokensOf(steps: ChatEvent[][]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loop-cache-"));
  let step = 0;
  const model: ChatModel = {
    capabilities: { tools: true, streaming: true, json: true },
    async *chat() {
      for (const ev of steps[step++] ?? [{ type: "stop", reason: "end" }]) yield ev;
    }
  };
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop] });
  const thread = ctx.agent.newThread(project.id, "loop");
  const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "how many?" });
  await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
  const tokens = ctx.agent.store.run(project.id, run.runId)?.tokens;
  await ctx.fiber.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  return tokens;
}

it("adds up every step's cache reads and writes into the run's tokens", async () => {
  const tokens = await tokensOf([
    [{ type: "usage", inputTokens: 5000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 4000 }, { type: "tool_call", id: "a", name: "count_items", args: {} }, { type: "stop", reason: "tool_use" }],
    [{ type: "usage", inputTokens: 5200, outputTokens: 30, cacheReadTokens: 4000, cacheWriteTokens: 150 }, { type: "text", delta: "None yet." }, { type: "stop", reason: "end" }]
  ]);
  expect(tokens).toEqual({ inputTokens: 10_200, uncachedInputTokens: 2050, cacheReadTokens: 4000, cacheWriteTokens: 4150, outputTokens: 50 });
});

it("counts all input as new when the provider says nothing about its cache", async () => {
  const tokens = await tokensOf([[{ type: "usage", inputTokens: 900, outputTokens: 5 }, { type: "text", delta: "Hi." }, { type: "stop", reason: "end" }]]);
  expect(tokens).toEqual({ inputTokens: 900, uncachedInputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 });
});
