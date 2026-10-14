/**
 * Tomrade, the one in-app choice: backlog conversations go to the loop and
 * ticket work to the built-in pi, a thread staying with the part it started on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, type Engine, type EngineAvailability, type TurnInput, type TurnIO } from "@tomradex/agent";
import tomrade from "../src/tomrade.js";

async function setup(work: EngineAvailability = { ok: true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-engine-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }], tomrade] });
  await settle();
  const turns: { engine: string; input: TurnInput; resume?: string }[] = [];
  const part = (id: string, availability: EngineAvailability): Engine => ({
    id,
    title: id,
    author: "ai:test",
    capabilities: id === "loop" ? ["backlog"] : ["backlog", "code", "general"],
    available: async () => availability,
    async turn(input, io) {
      turns.push({ engine: id, input, resume: io.resume });
      return { stop: "end", resume: id === "pi-builtin" ? "pi-session" : undefined };
    }
  });
  ctx.agent.engine(part("loop", { ok: true }));
  ctx.agent.engine(part("pi-builtin", work));
  const done = async () => {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { ctx, project, turns, done };
}

it("lists one engine in place of its parts", async () => {
  const { ctx, done } = await setup();
  try {
    const views = await ctx.agent.engineViews();
    expect(views.map((v) => v.id)).toEqual(["tomrade"]);
    expect(views[0]).toMatchObject({ title: "Tomrade", ok: true, capabilities: ["backlog", "code", "general"], includes: ["loop", "pi-builtin"] });
  } finally { await done(); }
});

it("offers only backlog work while the built-in pi cannot run", async () => {
  const { ctx, done } = await setup({ ok: false, need: "install", reason: "no pi" });
  try {
    expect((await ctx.agent.engineViews())[0]).toMatchObject({ ok: true, capabilities: ["backlog"] });
  } finally { await done(); }
});

it("sends a conversation to the loop and a ticket to pi, with each part's saved settings", async () => {
  const { ctx, project, turns, done } = await setup();
  try {
    ctx.settings.set({ ...ctx.settings.get(), agent: { ...ctx.agent.settingsOf(), engines: { loop: { profile: "deepseek" }, tomrade: { effort: "high" } } } });
    const chat = ctx.agent.newThread(project.id);
    expect(chat.engine).toBe("tomrade");
    const first = ctx.agent.send(project.id, chat.id, { kind: "text", text: "what is open?" });
    await expect.poll(() => ctx.agent.store.run(project.id, first.runId)?.status).toBe("done");
    expect(turns.at(-1)).toMatchObject({ engine: "loop", input: { purpose: "backlog", options: { profile: "deepseek", effort: "high" } } });

    // A code or General turn needs a repository or a delivery; the engine is asked directly.
    const input = turns.at(-1)!.input;
    for (const purpose of ["code", "general"] as const) {
      await ctx.agent.engineOf("tomrade")!.turn({ ...input, purpose, options: {} }, {} as TurnIO);
      expect(turns.at(-1)).toMatchObject({ engine: "pi-builtin", input: { purpose } });
      expect(turns.at(-1)!.input.options).toEqual({}); // the loop's saved profile stays the loop's
    }
  } finally { await done(); }
});

it("answers threads and settings that still name a part, resuming the session it left", async () => {
  const { ctx, project, turns, done } = await setup();
  try {
    ctx.settings.set({ ...ctx.settings.get(), agent: { ...ctx.agent.settingsOf(), defaultEngine: "loop" } });
    expect(ctx.agent.newThread(project.id).engine).toBe("tomrade");

    const old = ctx.agent.store.createThread(project.id, "pi-builtin");
    ctx.agent.store.setExternal(project.id, old.id, "pi-builtin", "old-session");
    expect(ctx.agent.store.thread(project.id, old.id)?.engine).toBe("tomrade");
    const run = ctx.agent.send(project.id, old.id, { kind: "text", text: "hello again" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(turns.at(-1)).toMatchObject({ engine: "loop", resume: "old-session" });
    expect(ctx.agent.setEngine(project.id, old.id, "pi-builtin").engine).toBe("tomrade");
  } finally { await done(); }
});

it("takes the model and effort picked for a part as its own, once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-engine-"));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }]] });
  try {
    await settle();
    ctx.settings.set({ ...ctx.settings.get(), agent: { ...ctx.agent.settingsOf(), engines: { loop: { profile: "deepseek", maxSteps: 12 }, "pi-builtin": { profile: "kimi", effort: "high" } } } });
    await ctx.plugin(tomrade);
    await settle();
    expect(ctx.agent.settingsOf().engines.tomrade).toEqual({ profile: "deepseek", effort: "high" });
  } finally {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("claims no ticket work with the built-in pi switched off, ready or not", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-engine-"));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }], tomrade] });
  try {
    await settle();
    let ready = false;
    ctx.agent.engine({ id: "loop", title: "loop", author: "ai:test", available: async () => (ready ? { ok: true } : { ok: false, need: "model" }), turn: async () => ({ stop: "end" }) });
    expect((await ctx.agent.engineViews())[0]).toMatchObject({ id: "tomrade", ok: false, need: "model", capabilities: ["backlog"] });
    ready = true;
    expect((await ctx.agent.engineViews())[0]).toMatchObject({ id: "tomrade", ok: true, capabilities: ["backlog"] });
  } finally {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
