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
import loop, { compactRow, render } from "@tomradex/engine-loop";

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
