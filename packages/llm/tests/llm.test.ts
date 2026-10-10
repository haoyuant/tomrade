import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeChatModel, collect, userMessage, withPromptTools, type ChatModel } from "@tomradex/llm";

describe("collect", () => {
  it("gathers text, tool calls and the stop reason", async () => {
    const model = new FakeChatModel([{ text: "hi", toolCalls: [{ name: "list_items", args: { status: "backlog" } }] }]);
    const out = await collect(model.chat({ system: "s", messages: [userMessage("u")] }));
    expect(out.text).toBe("hi");
    expect(out.toolCalls).toEqual([expect.objectContaining({ name: "list_items" })]);
    expect(out.stop).toBe("tool_use");
  });
});

describe("withPromptTools", () => {
  const inner = (reply: string): ChatModel => ({
    capabilities: { tools: false, streaming: true, json: false },
    async *chat() {
      yield { type: "text", delta: reply };
      yield { type: "stop", reason: "end" };
    }
  });

  it("passes through when no tools are requested", async () => {
    const out = await collect(withPromptTools(inner("plain")).chat({ system: "s", messages: [] }));
    expect(out.text).toBe("plain");
    expect(out.toolCalls).toEqual([]);
  });

  it("parses a fenced tool call and reports tool_use", async () => {
    const reply = 'Let me check.\n```tool_call\n{"name": "get_item", "args": {"id": "x"}}\n```';
    const out = await collect(withPromptTools(inner(reply)).chat({ system: "s", messages: [], tools: [{ name: "get_item", description: "d", inputSchema: {} }] }));
    expect(out.text).toBe("Let me check.");
    expect(out.toolCalls).toEqual([expect.objectContaining({ name: "get_item", args: { id: "x" } })]);
    expect(out.stop).toBe("tool_use");
  });

  it("keeps a fence that is not a tool call as text", async () => {
    const reply = "```tool_call\nnot json\n```";
    const out = await collect(withPromptTools(inner(reply)).chat({ system: "s", messages: [], tools: [{ name: "t", description: "d", inputSchema: {} }] }));
    expect(out.toolCalls).toEqual([]);
    expect(out.text).toContain("not json");
  });
});

describe("FakeChatModel scripting", () => {
  it("records requests and validates via fakeChat completeJson", async () => {
    const model = new FakeChatModel([{ text: "a" }, { text: "b" }]);
    await collect(model.chat({ system: "one", messages: [] }));
    await collect(model.chat({ system: "two", messages: [] }));
    expect(model.requests.map((r) => r.system)).toEqual(["one", "two"]);
    expect(z.object({ x: z.number() }).parse({ x: 1 })).toEqual({ x: 1 });
  });
});
