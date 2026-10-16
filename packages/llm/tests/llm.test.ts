import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { COMPLETION_IDLE_MS, FakeChatModel, collect, completeJson, userMessage, withPromptTools, type ChatModel } from "@tomradex/llm";

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

describe("completeJson", () => {
  const schema = z.object({ priority: z.number() });

  it("gives the model one chance to repair output that does not fit, quoting what was wrong", async () => {
    const model = new FakeChatModel([{ text: '{"priority": "high"}' }, { text: '{"priority": 3}' }]);
    expect(await completeJson(model, schema, { system: "s", user: "u" }, "DeepSeek (deepseek-chat)")).toEqual({ priority: 3 });
    expect(JSON.stringify(model.requests[1].messages)).toContain("priority");
  });

  it("names the model and the field when the repair does not fit either", async () => {
    const model = new FakeChatModel([{ text: '{"priority": "high"}' }, { text: "```json\n{\"priority\": \"high\"}\n```" }]);
    await expect(completeJson(model, schema, { system: "s", user: "u" }, "DeepSeek (deepseek-chat)")).rejects.toThrow(/DeepSeek \(deepseek-chat\).*priority/);
    expect(model.requests).toHaveLength(2);
  });

  it("skips the repair round when the caller has its own fallback", async () => {
    const model = new FakeChatModel([{ text: '{"priority": "high"}' }, { text: '{"priority": 3}' }]);
    await expect(completeJson(model, schema, { system: "s", user: "u", repair: false })).rejects.toThrow(/priority/);
    expect(model.requests).toHaveLength(1);
  });

  it("says a reply cut off before any answer spent the output limit, as a model that reasons first does", async () => {
    const thinking: ChatModel = { capabilities: { tools: false, streaming: true, json: true }, chat: async function* () { yield { type: "stop", reason: "max_tokens" } as const; } };
    await expect(completeJson(thinking, schema, { system: "s", user: "u", maxTokens: 8000 }, "DeepSeek (deepseek-flash)")).rejects.toThrow(/DeepSeek \(deepseek-flash\) used its whole output limit \(8000 tokens\) before answering/);
    const empty: ChatModel = { capabilities: { tools: false, streaming: true, json: true }, chat: async function* () { yield { type: "stop", reason: "end" } as const; } };
    await expect(completeJson(empty, schema, { system: "s", user: "u" }, "Kimi")).rejects.toThrow("Kimi returned no content");
  });

  // Never answers and ignores its signal: the worst a provider can do.
  const hung: ChatModel = { capabilities: { tools: false, streaming: true, json: true }, chat: async function* () { await new Promise(() => {}); } };

  it("gives up at the deadline even when the model ignores its signal", async () => {
    const started = Date.now();
    await expect(completeJson(hung, schema, { system: "s", user: "u", timeoutMs: 50 }, "DeepSeek (deepseek-chat)")).rejects.toThrow(/DeepSeek \(deepseek-chat\) did not answer within 0.05s/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("ends when the caller withdraws", async () => {
    const controller = new AbortController();
    const pending = completeJson(hung, schema, { system: "s", user: "u", signal: controller.signal });
    controller.abort(new Error("client went away"));
    await expect(pending).rejects.toThrow("client went away");
  });

  it("ends a model that goes silent, without a deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = completeJson(hung, schema, { system: "s", user: "u" }, "Kimi");
      const settled = expect(pending).rejects.toThrow(`Kimi sent nothing for ${COMPLETION_IDLE_MS / 1000}s`);
      await vi.advanceTimersByTimeAsync(COMPLETION_IDLE_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }
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
