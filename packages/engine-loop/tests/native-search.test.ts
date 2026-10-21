/**
 * A model that searches the web on its own does so, and is not also offered the
 * web search plugin's tool; any other model gets the plugin's tool as before.
 * When the provider turns its own search down, the turn says so once and goes
 * on with the plugin's tool instead of failing. With neither, the agent is told
 * search is unavailable and the person is shown, once, how to get it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Service, type Context } from "cordis";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fresh } from "@tomradex/testkit";
import { Tools, defineTool } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { NativeSearchRefused, fakeChat, type ChatEvent, type ChatModel, type ChatRequest } from "@tomradex/llm";
import loop, { createLoopEngine } from "@tomradex/engine-loop";
import WebSearch from "@tomradex/web-search";

const plugin = {
  name: "fake-web-search",
  inject: ["tools"],
  apply(ctx: Context) {
    for (const name of ["web_search", "web_fetch"]) ctx.tools.register(defineTool({ name, title: name, description: `${name} for tests`, input: z.object({}), execute: () => "results" }));
  }
};

async function drive(nativeWebSearch: boolean, reply: (request: ChatRequest, step: number) => ChatEvent[] | Error, search: unknown = plugin, asks = 1) {
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
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop, search as typeof plugin] });
  const thread = ctx.agent.newThread(project.id, "loop");
  let status;
  for (let i = 0; i < asks; i += 1) {
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "what's new with deepseek?" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).not.toBe("running");
    status = ctx.agent.store.run(project.id, run.runId)?.status;
  }
  const messages = ctx.agent.store.messages(project.id, thread.id);
  const notes = messages.flatMap((m) => (m.block.type === "note" ? [m.block.text] : []));
  const cards = messages.flatMap((m) => (m.block.type === "card" ? [m.block] : []));
  await ctx.fiber.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  return { requests, status, notes, cards };
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

  it("tells the agent search is unavailable when neither path is, and shows the person once how to get it", async () => {
    const results: string[] = [];
    const { status, cards } = await drive(
      false,
      (request) => {
        for (const block of request.messages.at(-1)?.content ?? []) if (block.type === "tool_result") results.push(block.content);
        return request.messages.at(-1)?.content.some((b) => b.type === "tool_result") ? answer : [{ type: "tool_call", id: "s", name: "web_search", args: { query: "deepseek" } }, { type: "stop", reason: "tool_use" }];
      },
      WebSearch,
      2
    );
    expect(status).toBe("done");
    expect(results).toHaveLength(2);
    for (const result of results) expect(result).toMatch(/^ERROR: No web search provider is switched on.*go on without the web/);
    expect(cards).toHaveLength(1);
    expect(cards[0].schema).toBe("finding");
    const card = cards[0].data as { tone: string; actions: { kind: string; pane?: string }[] };
    expect(card.tone).toBe("warn");
    expect(card.actions).toEqual([expect.objectContaining({ kind: "settings" }), expect.objectContaining({ kind: "settings", pane: "plugins" })]);
    expect(card.actions[0].pane).toBeUndefined();
  });

  it("offers in one click an official search plugin the person's models call for", async () => {
    class FakeCommunity extends Service {
      static provide = "community";
      constructor(ctx: Context) {
        super(ctx, "community");
      }
      offers = async (kind: string) => (kind === "webSearchProviders" ? [{ id: "tomrade/example-search", title: "Example Search" }] : []);
    }
    const searching = { name: "search-with-offer", apply: (ctx: Context) => void (ctx.plugin(WebSearch), ctx.plugin(FakeCommunity)) };
    const { cards } = await drive(
      false,
      (request) => (request.messages.at(-1)?.content.some((b) => b.type === "tool_result") ? answer : [{ type: "tool_call", id: "s", name: "web_search", args: { query: "kimi" } }, { type: "stop", reason: "tool_use" }]),
      searching
    );
    const actions = (cards[0]?.data as { actions: { kind: string; pluginId?: string; label: string; done?: string }[] }).actions;
    expect(actions[0]).toEqual({ kind: "install-plugin", pluginId: "tomrade/example-search", label: "Install Example Search", done: "Example Search is installed: web search works from your next message." });
    expect(actions.slice(1).map((a) => a.kind)).toEqual(["settings", "settings"]);
  });

  it("shows no such card when search works", async () => {
    const { cards } = await drive(false, (request) =>
      request.messages.at(-1)?.content.some((b) => b.type === "tool_result") ? answer : [{ type: "tool_call", id: "s", name: "web_search", args: {} }, { type: "stop", reason: "tool_use" }]
    );
    expect(cards).toEqual([]);
  });

  it("marks a model that searches on its own where the model is picked", async () => {
    for (const nativeWebSearch of [true, false]) {
      const model: ChatModel = { capabilities: { tools: true, streaming: true, json: true, nativeWebSearch }, async *chat() {} };
      const { ctx } = await fresh({ plugins: [fakeChat(model)] });
      const pick = createLoopEngine(ctx).local?.picks?.().find((p) => p.key === "profile");
      expect(pick?.choices[0].searchesWeb).toBe(nativeWebSearch ? true : undefined);
      await ctx.fiber.dispose();
    }
  });
});
