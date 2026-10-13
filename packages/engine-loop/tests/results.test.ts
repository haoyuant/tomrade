/**
 * What the loop's model reads back from a tool: a long list arrives whole with
 * its rows shortened rather than cut mid-record, and an identical read within
 * one turn is answered from memory instead of run again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { fakeChat, type ChatEvent, type ChatModel, type ChatRequest } from "@tomradex/llm";
import loop, { compactRow, elideOldResults, render } from "@tomradex/engine-loop";
import type { Message } from "@tomradex/llm";

const item = (n: number) => ({
  id: `id-${n}`,
  key: `TOM-${n}`,
  title: `Ticket ${n} about the daily water goal`,
  body: "x".repeat(600),
  status: "backlog",
  parentId: null,
  labels: ["goal"],
  blocks: [],
  evidence: { resources: [], submissions: [], reviews: [] },
  fields: {}
});

describe("render", () => {
  it("leaves a small result alone", () => {
    expect(render({ count: 3 })).toBe('{"count":3}');
    expect(render([item(1)])).toBe(JSON.stringify([item(1)]));
  });

  it("keeps every row of a long list, shortened, and says so", () => {
    const out = render(Array.from({ length: 12 }, (_, i) => item(i + 1)));
    expect(out.startsWith("(all 12 items; ")).toBe(true);
    for (let i = 1; i <= 12; i++) expect(out).toContain(`"key":"TOM-${i}"`);
    expect(out).not.toContain("truncated");
    expect(out).not.toContain("evidence");
    expect(out).not.toContain("parentId");
    expect(out.length).toBeLessThan(12 * 400);
  });

  it("drops rows only past the list cap, count first", () => {
    const out = render(Array.from({ length: 400 }, (_, i) => item(i + 1)));
    expect(out).toMatch(/^\(400 items; showing the first \d+ /);
    expect(out.length).toBeLessThan(17_000);
  });

  it("reads a text answer as written, line breaks and all", () => {
    expect(render("exit 0\nhello\nworld")).toBe("exit 0\nhello\nworld");
  });

  it("still cuts a single oversized record the old way", () => {
    expect(render({ body: "y".repeat(10_000) })).toContain("truncated");
  });

  it("compactRow shortens text, drops empties and nested records, keeps flat lists", () => {
    expect(compactRow(item(1))).toEqual({ id: "id-1", key: "TOM-1", title: "Ticket 1 about the daily water goal", body: "x".repeat(160) + "…", status: "backlog", labels: ["goal"] });
  });
});

describe("read memo", () => {
  async function drive(steps: ChatEvent[][]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loop-memo-"));
    const requests: ChatRequest[] = [];
    let step = 0;
    const model: ChatModel = {
      capabilities: { tools: true, streaming: true, json: true },
      async *chat(request) {
        requests.push(structuredClone(request));
        for (const ev of steps[step++] ?? [{ type: "stop", reason: "end" }]) yield ev;
      }
    };
    const f = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop] });
    const { ctx, project, board } = f;
    f.items.create({ projectId: project.id, boardId: board.id, title: "Dark mode toggle", by: "human" });
    const thread = ctx.agent.newThread(project.id, "loop");
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    const toolResults = (i: number) => requests[i]!.messages.at(-1)!.content.filter((c) => c.type === "tool_result") as { content: string }[];
    // Only calls that ran leave a trace; the answered-from-memory one does not.
    const traces = ctx.agent.thread(project.id, thread.id).messages.flatMap((m) => (m.block.type === "trace" ? [m.block.tool] : []));
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    return { toolResults, traces };
  }
  const call = (id: string, name: string, args: unknown): ChatEvent[] => [{ type: "tool_call", id, name, args }, { type: "stop", reason: "tool_use" }];

  it("answers an identical read from memory, and forgets after a write", async () => {
    const { toolResults, traces } = await drive([
      call("a", "list_items", { search: "dark" }),
      call("b", "list_items", { search: "dark" }),
      call("c", "create_item", { title: "Light mode", body: null }),
      call("d", "list_items", { search: "dark" }),
      [{ type: "stop", reason: "end" }]
    ]);
    expect(toolResults(1)[0]!.content).toContain('"title":"Dark mode toggle"');
    expect(toolResults(2)[0]!.content).toContain("identical to an earlier call this turn");
    expect(toolResults(4)[0]!.content).toContain('"title":"Dark mode toggle"');
    expect(traces).toEqual(["list_items", "create_item", "list_items"]);
  });
});

/**
 * A thinking model can spend the whole output allowance reasoning and stop at the limit with
 * nothing to show. That used to end the run as if it had finished — silently, every time the
 * user asked again. Seen live with DeepSeek at effort high: 8192 tokens, all reasoning.
 */
describe("output limit", () => {
  async function drive(steps: ChatEvent[][], options?: Record<string, unknown>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loop-limit-"));
    const requests: ChatRequest[] = [];
    let step = 0;
    const model: ChatModel = {
      capabilities: { tools: true, streaming: true, json: true },
      async *chat(request) {
        requests.push(structuredClone(request));
        for (const ev of steps[step++] ?? [{ type: "stop", reason: "end" }]) yield ev;
      }
    };
    const f = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop] });
    const { ctx, project } = f;
    const thread = ctx.agent.newThread(project.id, "loop", null, { options });
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "draw it" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).not.toBe("running");
    const status = ctx.agent.store.run(project.id, run.runId)?.status;
    const blocks = ctx.agent.thread(project.id, thread.id).messages.filter((m) => m.role !== "user").map((m) => m.block);
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    return { requests, status, blocks };
  }

  it("says so when the limit is hit before any answer, instead of ending quietly", async () => {
    const { status, blocks } = await drive([[{ type: "usage", inputTokens: 900, outputTokens: 8192 }, { type: "stop", reason: "max_tokens" }]]);
    expect(status).toBe("error");
    const error = blocks.find((b) => b.type === "error");
    expect(error && "text" in error ? error.text : "").toMatch(/output limit/);
  });

  it("keeps what was written before the cut, and still says it was cut", async () => {
    const { status, blocks } = await drive([[{ type: "text", delta: "Here is the plan: first" }, { type: "stop", reason: "max_tokens" }]]);
    expect(status).toBe("error");
    expect(blocks.map((b) => b.type)).toEqual(["text", "error"]);
  });

  it("drops extended thinking for the rest of the turn when the thinking alone hit the limit", async () => {
    const { status, blocks, requests } = await drive(
      [
        [{ type: "usage", inputTokens: 900, outputTokens: 8192 }, { type: "stop", reason: "max_tokens" }],
        [{ type: "tool_call", id: "a", name: "list_items", args: {} }, { type: "stop", reason: "tool_use" }],
        [{ type: "text", delta: "Done." }, { type: "stop", reason: "end" }]
      ],
      { effort: "high" }
    );
    expect(status).toBe("done");
    expect(requests.map((r) => r.effort)).toEqual(["high", undefined, undefined]);
    expect(blocks.map((b) => b.type)).toEqual(["note", "trace", "text"]);
  });

  it("says the arguments were broken JSON, and where, instead of naming every field as missing", async () => {
    const raw = '{"title": "Light "mode" toggle", "body": null}';
    const { requests } = await drive([[{ type: "tool_call", id: "a", name: "create_item", args: { __raw: raw } }, { type: "stop", reason: "tool_use" }]]);
    const result = requests[1]!.messages.at(-1)!.content.find((c) => c.type === "tool_result") as { content: string };
    expect(result.content).toMatch(/not valid JSON/);
    expect(result.content).toContain('"Light "mode');
    expect(result.content).not.toMatch(/title: Invalid input/);
  });

  it("gives up with the error if the retry is cut off too", async () => {
    const overflow: ChatEvent[] = [{ type: "stop", reason: "max_tokens" }];
    const { status, requests } = await drive([overflow, overflow], { effort: "high" });
    expect(status).toBe("error");
    expect(requests).toHaveLength(2);
  });
});

/**
 * A reply cut at the output limit can carry a call whose arguments were cut too and still parse —
 * a write with half its content. pi refuses those; so does the loop now.
 */
describe("cut-off calls", () => {
  it("does not run a call from a reply that hit the output limit, and tells the model why", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loop-cut-"));
    const requests: ChatRequest[] = [];
    const steps: ChatEvent[][] = [
      [{ type: "tool_call", id: "a", name: "create_item", args: { title: "Half a tit", body: null } }, { type: "stop", reason: "max_tokens" }],
      [{ type: "text", delta: "Sorry." }, { type: "stop", reason: "end" }]
    ];
    let step = 0;
    const model: ChatModel = {
      capabilities: { tools: true, streaming: true, json: true },
      async *chat(request) {
        requests.push(structuredClone(request));
        for (const ev of steps[step++] ?? [{ type: "stop", reason: "end" }]) yield ev;
      }
    };
    const f = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop] });
    const { ctx, project } = f;
    const thread = ctx.agent.newThread(project.id, "loop");
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "add it" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    const result = requests[1]!.messages.at(-1)!.content.find((c) => c.type === "tool_result") as { content: string; isError?: boolean };
    expect(result.content).toMatch(/output limit/);
    expect(result.isError).toBe(true);
    expect(f.items.list({ projectId: project.id }).some((i) => i.title === "Half a tit")).toBe(false);
    const traces = ctx.agent.thread(project.id, thread.id).messages.filter((m) => m.block.type === "trace");
    expect(traces).toHaveLength(0);
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("context budget", () => {
  const results = (n: number, size: number): Message[] =>
    Array.from({ length: n }, (_, i) => [
      { role: "assistant" as const, content: [{ type: "tool_call" as const, id: `c${i}`, name: "read_file", args: { path: `f${i}` } }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, id: `c${i}`, content: String(i).repeat(size) }] }
    ]).flat();
  const contents = (messages: Message[]) => messages.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])));

  it("drops the oldest results first, only as many as asked, and never the latest two", () => {
    const messages = results(5, 10_000);
    const freed = elideOldResults(messages, 15_000);
    expect(freed).toBeGreaterThanOrEqual(15_000);
    const after = contents(messages);
    expect(after.slice(0, 2).every((c) => c.startsWith("(result dropped"))).toBe(true);
    expect(after.slice(2)).toEqual(["2".repeat(10_000), "3".repeat(10_000), "4".repeat(10_000)]);
    elideOldResults(messages, 1e9);
    expect(contents(messages).slice(-2)).toEqual(["3".repeat(10_000), "4".repeat(10_000)]);
  });

  it("trims the next request once the provider reports a request past the budget", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loop-budget-"));
    const requests: ChatRequest[] = [];
    const read = (id: string, limit: number): ChatEvent[] => [{ type: "tool_call", id, name: "list_items", args: { limit } }, { type: "stop", reason: "tool_use" }];
    const steps: ChatEvent[][] = [read("a", 30), read("b", 29), [{ type: "usage", inputTokens: 90_000, outputTokens: 10 }, ...read("c", 28)], [{ type: "stop", reason: "end" }]];
    let step = 0;
    const model: ChatModel = {
      capabilities: { tools: true, streaming: true, json: true },
      async *chat(request) {
        requests.push(structuredClone(request));
        for (const ev of steps[step++] ?? [{ type: "stop", reason: "end" }]) yield ev;
      }
    };
    const f = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop] });
    const { ctx, project, board } = f;
    for (let i = 0; i < 30; i++) f.items.create({ projectId: project.id, boardId: board.id, title: `Ticket ${i}`, body: "x".repeat(400), by: "human" });
    const thread = ctx.agent.newThread(project.id, "loop");
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "look around" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(contents(requests[2]!.messages).some((c) => c.startsWith("(result dropped"))).toBe(false);
    const last = contents(requests[3]!.messages);
    expect(last[0]).toMatch(/^\(result dropped/);
    expect(last.slice(1).every((c) => !c.startsWith("(result dropped"))).toBe(true);
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
