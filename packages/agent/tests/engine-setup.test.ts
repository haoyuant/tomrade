/** An engine's setup as this machine sees it: what availability says replaces the declared one. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";

it("shows the install commands this machine has, falling back to the declared ones", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-setup-"));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }]] });
  try {
    const setup = { install: ["npm i -g acme"], docs: "https://acme.example/install" };
    ctx.agent.engine({ id: "acme", title: "Acme", author: "ai:acme", setup, available: async () => ({ ok: false, need: "install", setup: { ...setup, install: [] } }), turn: async () => ({ stop: "end" }) });
    ctx.agent.engine({ id: "plain", title: "Plain", author: "ai:plain", setup, available: async () => ({ ok: false, need: "install" }), turn: async () => ({ stop: "end" }) });
    const views = await ctx.agent.engineViews();
    expect(views.find((e) => e.id === "acme")?.setup).toEqual({ install: [], docs: "https://acme.example/install" });
    expect(views.find((e) => e.id === "plain")?.setup).toEqual(setup);
  } finally {
    await ctx.fiber.dispose();
  }
});
