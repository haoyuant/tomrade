import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Agent } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";

it("commits input and run with the receipt, rejects changed requests and replays after reopening Agent", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-input-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }]] });
  let agent = ctx.plugin(Agent);
  await settle();
  try {
    const turn = vi.fn(async () => ({ stop: "end" as const }));
    ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn });
    const thread = ctx.agent.newThread(project.id, "test");
    const input = { kind: "text" as const, text: "once" };
    const delivery = { requestId: "external-request", source: { actor: "user" } };
    const first = ctx.agent.send(project.id, thread.id, input, delivery);
    expect(ctx.agent.send(project.id, thread.id, input, delivery)).toEqual(first);
    expect(() => ctx.agent.send(project.id, thread.id, { kind: "text", text: "changed" }, delivery)).toThrow("different input");
    await expect.poll(() => ctx.agent.store.run(project.id, first.runId)?.status).toBe("done");
    expect(turn).toHaveBeenCalledTimes(1);
    await agent.dispose();
    agent = ctx.plugin(Agent);
    await settle();
    expect(ctx.agent.send(project.id, thread.id, input, delivery)).toEqual(first);
    expect(ctx.agent.store.runs(project.id, thread.id)).toHaveLength(1);
  } finally { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

it("rolls back the input and run if persisting the receipt fails, before calling the engine", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-input-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent] });
  try {
    const turn = vi.fn(async () => ({ stop: "end" as const }));
    ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn });
    const thread = ctx.agent.newThread(project.id, "test");
    vi.spyOn(ctx.agent.store, "recordInput").mockImplementationOnce(() => { throw new Error("disk failed"); });
    expect(() => ctx.agent.send(project.id, thread.id, { kind: "text", text: "once" }, { requestId: "external" })).toThrow("disk failed");
    expect(ctx.agent.thread(project.id, thread.id).messages).toHaveLength(0);
    expect(ctx.agent.thread(project.id, thread.id).runs).toHaveLength(0);
    expect(turn).not.toHaveBeenCalled();
  } finally { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
