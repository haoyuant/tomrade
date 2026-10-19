/** A model profile that is removed stops being any engine's pick: the engine is back on its default, not on a dead id. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, type AgentSettings } from "@tomradex/agent";

const engine = (id: string, usesModels: boolean) => ({ id, title: id, author: `ai:${id}`, usesModels, available: async () => ({ ok: true }), turn: async () => ({ stop: "end" as const }) });

it("drops an engine's pick of a profile that is gone, on registration and whenever the profiles change", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-removed-profile-"));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }]] });
  const engines = () => (ctx.settings.get().agent as AgentSettings).engines;
  const write = (models: unknown, picks: Record<string, unknown>) => {
    const all = ctx.settings.get();
    ctx.settings.set({ ...all, models, agent: { ...(all.agent as AgentSettings), engines: picks } });
  };
  try {
    write({ profiles: [{ id: "kept" }] }, { modeled: { profile: "gone", effort: "high" }, cli: { profile: "gone" } });
    ctx.agent.engine(engine("modeled", true));
    ctx.agent.engine(engine("cli", false));
    // an engine with its own models keeps whatever `profile` means to it
    expect(engines()).toEqual({ modeled: { effort: "high" }, cli: { profile: "gone" } });

    write({ profiles: [{ id: "kept" }, { id: "other" }] }, { modeled: { profile: "other" }, cli: { profile: "gone" } });
    expect(engines().modeled).toEqual({ profile: "other" });
    write({ profiles: [{ id: "kept" }] }, engines());
    expect(engines()).toEqual({ modeled: {}, cli: { profile: "gone" } });
  } finally {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
