/** A follow-up runs after the turn but inside the run: it shows what it is doing, and a stop ends it at once. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, type AgentEvent } from "@tomradex/agent";
import { fakeChat, type ChatModel } from "@tomradex/llm";
import loop from "@tomradex/engine-loop";

it("shows a follow-up's activity, and a stop during it ends the run as stopped within a second", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-follow-up-"));
  const model: ChatModel = { capabilities: { tools: true, streaming: true, json: true }, async *chat() { yield { type: "text", delta: "Done." }; yield { type: "stop", reason: "end" }; } };
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop] });
  const events: AgentEvent[] = [];
  ctx.on("agent/event", (_thread: string, event: AgentEvent) => void events.push(event));
  let reviewing = false;
  ctx.agent.workflow({
    id: "slow_review",
    title: "Slow review",
    description: "A review whose model never answers on its own.",
    input: z.object({}),
    state: z.object({}),
    entry: "review",
    start: () => ({}),
    steps: {
      async review(_state, io) {
        io.activity("Checking dependencies…");
        reviewing = true;
        // Answers only when the run is stopped, as a model call given the run's signal does.
        await new Promise((resolve) => io.signal.addEventListener("abort", resolve, { once: true }));
        io.activity(null);
        return { done: {} };
      }
    }
  });
  ctx.agent.followUp({ id: "slow-review", after: ({ canAsk }) => (canAsk ? { workflow: "slow_review" } : null) });
  try {
    const thread = ctx.agent.newThread(project.id, "loop");
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    await expect.poll(() => reviewing).toBe(true);
    expect(ctx.agent.store.run(project.id, run.runId)?.status).toBe("running");
    expect(events.some((e) => e.type === "progress" && e.activity === "Checking dependencies…")).toBe(true);
    const stopped = Date.now();
    ctx.agent.cancel(run.runId);
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status, { timeout: 1000 }).toBe("cancelled");
    expect(Date.now() - stopped).toBeLessThan(1000);
  } finally { await ctx.fiber.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
