/**
 * A model that searches the web on its own does so, and is not also offered the
 * web search plugin's tool; any other model gets the plugin's tool as before.
 * When the provider turns its own search down, the turn says so once and goes
 * on with the plugin's tool instead of failing.
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
import { NativeSearchRefused, fakeChat, type ChatEvent, type ChatModel, type ChatRequest } from "@tomradex/llm";
import loop from "@tomradex/engine-loop";

const plugin = {
  name: "fake-web-search",
  inject: ["tools"],
  apply(ctx: Context) {
    for (const name of ["web_search", "web_fetch"]) ctx.tools.register(defineTool({ name, title: name, description: `${name} for tests`, input: z.object({}), execute: () => "results" }));
  }
};

async function drive(nativeWebSearch: boolean, reply: (request: ChatRequest, step: number) => ChatEvent[] | Error) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loop-search-"));
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    capabilities: { tools: true, streaming: true, json: true, nativeWebSearch },
    async *chat(request: ChatRequest) {
      requests.push(request);
      const out = reply(request, requests.length - 1);
      if (out instanceof Error) throw out;
      yield* out;
    }
  };
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop, plugin] });
  const thread = ctx.agent.newThread(project.id, "loop");
  const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "what's new with deepseek?" });
  await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).not.toBe("running");
  const status = ctx.agent.store.run(project.id, run.runId)?.status;
  const notes = ctx.agent.store.messages(project.id, thread.id).flatMap((m) => (m.block.type === "note" ? [m.block.text] : []));
  await ctx.fiber.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  return { requests, status, notes };
}

const answer: ChatEvent[] = [{ type: "text", delta: "done" }, { type: "stop", reason: "end" }];
const offered = (request: ChatRequest) => (request.tools ?? []).map((t) => t.name);

describe("web search in the loop", () => {
  it("lets a model with its own search use it, without the plugin's search tool", async () => {
    const { requests } = await drive(true, () => answer);
    expect(requests[0].webSearch).toBe(true);
    expect(offered(requests[0])).not.toContain("web_search");
    expect(offered(requests[0])).toContain("web_fetch");
  });

  it("offers the plugin's search tool to a model without its own", async () => {
    const { requests } = await drive(false, () => answer);
    expect(requests[0].webSearch).toBeUndefined();
    expect(offered(requests[0])).toContain("web_search");
  });

  it("goes on with the plugin's tool for the rest of the turn when the provider refuses its search", async () => {
    const { requests, status, notes } = await drive(true, (_request, step) =>
      step === 0 ? new NativeSearchRefused("web search is not enabled") : step === 1 ? [{ type: "tool_call", id: "c1", name: "web_search", args: {} }, { type: "stop", reason: "tool_use" }] : answer
    );
    expect(status).toBe("done");
    expect(requests).toHaveLength(3);
    for (const request of requests.slice(1)) {
      expect(request.webSearch).toBeUndefined();
      expect(offered(request)).toContain("web_search");
    }
    expect(notes).toHaveLength(1);
  });
});
