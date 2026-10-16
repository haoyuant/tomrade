/**
 * A kit of tools few conversations use stays out of the loop's requests until
 * the model loads it — by asking for the kit, or by opening a playbook that
 * names its tools — and a coding session carries its own kit from the start.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fresh } from "@tomradex/testkit";
import { Tools, defineTool } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { fakeChat, type ChatEvent, type ChatModel, type ChatRequest } from "@tomradex/llm";
import loop, { LOAD_TOOLS } from "@tomradex/engine-loop";

const kits = {
  name: "kit-tools",
  inject: ["tools", "agent"],
  apply(ctx: Context) {
    for (const [name, kit] of [["create_template", "routines"], ["schedule_template", "routines"], ["plugin_build", "plugins"], ["link_code", "code"]] as const)
      ctx.tools.register(defineTool({ name, kit, title: name, description: `${name} for tests`, input: z.object({}), execute: () => ({ ok: name }) }));
    ctx.tools.kit("routines", "recurring tickets on a schedule");
    ctx.agent.playbook({ id: "studio.build", title: "Build a plugin", when: "building a plugin", tools: ["plugin_build"], body: "Build it." });
  }
};

async function drive(steps: ChatEvent[][], history: string[] = [], seen?: (request: ChatRequest) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loop-kits-"));
  const offered: string[][] = [];
  const results: string[] = [];
  let step = 0;
  const model: ChatModel = {
    capabilities: { tools: true, streaming: true, json: true },
    async *chat(request: ChatRequest) {
      seen?.(request);
      offered.push((request.tools ?? []).map((t) => t.name));
      for (const block of request.messages.at(-1)?.content ?? []) if (block.type === "tool_result") results.push(block.content);
      for (const ev of steps[step++] ?? [{ type: "stop", reason: "end" }]) yield ev;
    }
  };
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop, kits] });
  const thread = ctx.agent.newThread(project.id, "loop");
  for (const tool of history) ctx.agent.store.appendMessage(project.id, thread.id, "agent", { type: "trace", tool, args: {}, ok: true, summary: "", ms: 1 }, null);
  const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
  await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).not.toBe("running");
  await ctx.fiber.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  return { offered, results };
}

const call = (name: string, args: unknown = {}): ChatEvent[] => [{ type: "tool_call", id: name, name, args }, { type: "stop", reason: "tool_use" }];

describe("tool kits in the loop", () => {
  it("offers a kit's tools only after load_tools, which names every kit it could load and what it is for", async () => {
    let described = "";
    const { offered, results } = await drive([call(LOAD_TOOLS, { kit: "routines" }), call("create_template")], [], (request) => (described ||= request.tools?.find((t) => t.name === LOAD_TOOLS)?.description ?? ""));
    expect(described).toContain("routines — recurring tickets on a schedule (create_template, schedule_template)");
    expect(described).toContain("plugins (plugin_build)");
    expect(offered[0]).toContain(LOAD_TOOLS);
    expect(offered[0]).not.toContain("create_template");
    expect(offered[0]).not.toContain("link_code");
    expect(offered[1]).toEqual(expect.arrayContaining(["create_template", "schedule_template", LOAD_TOOLS]));
    expect(offered[1]).not.toContain("plugin_build");
    expect(results[0]).toBe("Loaded create_template, schedule_template: call them directly.");
    expect(results[1]).toContain("create_template");
  });

  it("brings in the tools a playbook names when it is opened", async () => {
    const { offered } = await drive([call("open_playbook", { id: "studio.build" }), [{ type: "stop", reason: "end" }]]);
    expect(offered[0]).not.toContain("plugin_build");
    expect(offered[1]).toContain("plugin_build");
  });

  it("keeps offering a kit's tool an earlier turn used, and refuses a kit it does not have", async () => {
    const { offered, results } = await drive([call(LOAD_TOOLS, { kit: "nope" })], ["create_template"]);
    expect(offered[0]).toContain("create_template");
    expect(offered[0]).not.toContain("schedule_template");
    expect(results[0]).toMatch(/^ERROR: no kit "nope"/);
  });
});
