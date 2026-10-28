/** The live line: every progress event carries the latest counters, and streamed text tops them up (a few times a second) until the engine reports again. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, type AgentEvent } from "@tomradex/agent";
import { fakeChat, type ChatEvent, type ChatModel } from "@tomradex/llm";
import loop from "@tomradex/engine-loop";

it("keeps the last reported usage on activity events and adds streamed text to the reply count", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-progress-"));
  // a pause stands for the model thinking between what it streams and its next report
  const steps: (ChatEvent | { pause: number })[][] = [
    [{ type: "usage", inputTokens: 100, outputTokens: 5 }, { type: "tool_call", id: "a", name: "list_items", args: { search: "dark" } }, { type: "stop", reason: "tool_use" }],
    [...Array.from({ length: 40 }, (): ChatEvent => ({ type: "text", delta: "x" })), { pause: 400 }, { type: "usage", inputTokens: 250, outputTokens: 12 }, { type: "stop", reason: "end" }]
  ];
  let step = 0;
  const model: ChatModel = { capabilities: { tools: true, streaming: true, json: true }, async *chat() {
    for (const ev of steps[step++] ?? [{ type: "stop", reason: "end" }]) {
      if ("pause" in ev) await new Promise((resolve) => setTimeout(resolve, ev.pause));
      else yield ev;
    }
  } };
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop] });
  const events: AgentEvent[] = [];
  ctx.on("agent/event", (_thread: string, event: AgentEvent) => void events.push(event));
  try {
    const thread = ctx.agent.newThread(project.id, "loop");
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    const progress = events.filter((e): e is Extract<AgentEvent, { type: "progress" }> => e.type === "progress");
    const activity = progress.find((e) => e.activity === "list_items")!;
    expect(activity.usage).toEqual({ inputTokens: 100, outputTokens: 5 });
    const streamed = progress.filter((e) => e.usage?.inputTokens === 100 && (e.usage?.outputTokens ?? 0) > 5);
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.at(-1)!.usage!.outputTokens).toBe(5 + Math.ceil(40 / 4));
    // forty words streamed at once refresh the line a couple of times, not forty
    expect(streamed.length).toBeLessThanOrEqual(2);
    // The loop reports the turn's running total after each step.
    expect(progress.at(-1)!.usage).toEqual({ inputTokens: 350, outputTokens: 17 });
  } finally { await ctx.fiber.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
