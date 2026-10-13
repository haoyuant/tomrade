/** Failed model requests: live on the working line while they last, one stored row once they end, never counted as silence. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, type AgentEvent, type Block } from "@tomradex/agent";
import { fakeChat, type ChatEvent, type ChatModel } from "@tomradex/llm";
import loop from "@tomradex/engine-loop";

async function runWith(steps: (ChatEvent | Error)[][]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-retry-"));
  let step = 0;
  const model: ChatModel = {
    capabilities: { tools: true, streaming: true, json: true },
    async *chat() {
      for (const ev of steps[step++] ?? [{ type: "stop", reason: "end" }]) {
        if (ev instanceof Error) throw ev;
        yield ev;
      }
    }
  };
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop] });
  const events: AgentEvent[] = [];
  ctx.on("agent/event", (_thread: string, event: AgentEvent) => void events.push(event));
  const thread = ctx.agent.newThread(project.id, "loop");
  const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
  await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).not.toBe("running");
  const blocks = ctx.agent.thread(project.id, thread.id)!.messages.filter((m) => m.role === "agent").map((m) => m.block);
  const progress = events.filter((e): e is Extract<AgentEvent, { type: "progress" }> => e.type === "progress");
  await ctx.fiber.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  return { blocks, progress };
}

it("shows each retry live and keeps one row once a request goes through", async () => {
  const { blocks, progress } = await runWith([[
    { type: "retry", attempt: 1, max: 2, reason: "ECONNRESET", delayMs: 1000 },
    { type: "retry", attempt: 2, max: 2, reason: "HTTP 529", delayMs: 3000 },
    { type: "text", delta: "done" },
    { type: "stop", reason: "end" }
  ]]);
  const live = progress.map((e) => e.retry).filter(Boolean);
  expect(live).toEqual([
    expect.objectContaining({ attempt: 1, max: 2, reason: "ECONNRESET", delayMs: 1000 }),
    expect.objectContaining({ attempt: 2, max: 2, reason: "HTTP 529", delayMs: 3000 })
  ]);
  // the line goes quiet again once the reply streams
  expect(progress.at(-1)!.retry).toBeNull();
  const retry = blocks.find((b): b is Block & { type: "retry" } => b.type === "retry")!;
  expect(retry).toMatchObject({ attempts: 2, max: 2, reason: "HTTP 529", recovered: true });
  // stored before the reply it waited for
  expect(blocks.findIndex((b) => b.type === "retry")).toBeLessThan(blocks.findIndex((b) => b.type === "text"));
});

it("says the retries ran out when the run fails during them", async () => {
  const { blocks } = await runWith([[
    { type: "retry", attempt: 1, max: 2, reason: "ECONNRESET", delayMs: 1 },
    { type: "retry", attempt: 2, max: 2, reason: "ECONNRESET", delayMs: 1 },
    new Error("fetch failed")
  ]]);
  expect(blocks.find((b) => b.type === "retry")).toMatchObject({ attempts: 2, recovered: false });
  expect(blocks.some((b) => b.type === "error")).toBe(true);
});

it("clears the running tool from the line when it ends", async () => {
  const { progress } = await runWith([
    [{ type: "tool_call", id: "a", name: "list_items", args: {} }, { type: "stop", reason: "tool_use" }],
    [{ type: "text", delta: "ok" }, { type: "stop", reason: "end" }]
  ]);
  const at = progress.findIndex((e) => e.activity === "list_items");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(progress.slice(at + 1).some((e) => e.activity === null)).toBe(true);
});
