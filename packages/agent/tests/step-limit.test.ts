import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent, type EngineStepLimit } from "@tomradex/agent";

const LIMIT: EngineStepLimit = { key: "maxSteps", min: 1, max: 64, default: 24 };

async function boot(stepLimit?: EngineStepLimit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-steps-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }]] });
  await settle();
  const ran: number[] = [];
  ctx.agent.engine({
    id: "stepped", title: "Stepped", author: "ai:test", available: async () => ({ ok: true }),
    options: z.object({ maxSteps: z.number().int().min(LIMIT.min).max(LIMIT.max).default(LIMIT.default) }),
    ...(stepLimit ? { stepLimit } : {}),
    async turn(input) {
      ran.push((input.options as { maxSteps: number }).maxSteps);
      return { stop: "budget" };
    }
  });
  const thread = ctx.agent.newThread(project.id, "stepped");
  const turn = async () => {
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).toBe("done");
    return ctx.agent.store.messages(project.id, thread.id).filter((m) => m.runId === runId && m.block.type === "note").map((m) => m.block);
  };
  const done = async () => {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { ctx, ran, turn, done };
}

it("runs a turn with the step limit saved in settings, and links its budget note to that engine's settings", async () => {
  const { ctx, ran, turn, done } = await boot(LIMIT);
  try {
    expect((await ctx.agent.engineViews()).find((v) => v.id === "stepped")?.stepLimit).toEqual(LIMIT);
    expect(await turn()).toEqual([expect.objectContaining({ type: "note", settingsFor: "stepped" })]);
    ctx.settings.set({ ...ctx.settings.get(), agent: { ...ctx.agent.settingsOf(), engines: { stepped: { maxSteps: 50 } } } });
    await turn();
    expect(ran).toEqual([24, 50]);
  } finally { await done(); }
});

it("links nothing from the budget note of an engine without a step limit", async () => {
  const { ctx, turn, done } = await boot();
  try {
    expect((await ctx.agent.engineViews()).find((v) => v.id === "stepped")?.stepLimit).toBeUndefined();
    const [note] = await turn();
    expect(note).toMatchObject({ type: "note", text: expect.stringContaining("continue") });
    expect(note).not.toHaveProperty("settingsFor");
  } finally { await done(); }
});
