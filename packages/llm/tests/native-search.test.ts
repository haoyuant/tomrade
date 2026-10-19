/**
 * Claude searches the web on its own when the request asks and the endpoint is
 * Anthropic's: the server tool goes out, the reply's search blocks come back to
 * be replayed as written, a paused search is resumed, the cited pages are kept,
 * and a refusal says it was the search so the caller can search another way.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicModel, NativeSearchRefused, assistantMessage, collect, toolResultsMessage, userMessage, type ChatRequest } from "@tomradex/llm";

const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

const start = { type: "message_start", message: { usage: { input_tokens: 10 } } };
const end = (stop: string) => [{ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: "message_stop" }];
const searched = [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"deepseek search api"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://api-docs.deepseek.com/guides/search/", title: "Search & Fetch", encrypted_content: "x" }] } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "text", text: "", citations: null } },
  { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://api-docs.deepseek.com/guides/search/", title: "Search & Fetch", cited_text: "…", encrypted_index: "e" } } },
  { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "It launched on October 17." } },
  { type: "content_block_stop", index: 2 }
];

let bodies: Record<string, unknown>[] = [];
const serve = (...replies: (Response | (() => Response))[]) => {
  bodies = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = replies.shift();
    if (!next) throw new Error("no reply scripted");
    return typeof next === "function" ? next() : next;
  });
};

afterEach(() => vi.unstubAllGlobals());

const ask = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({ system: "s", messages: [userMessage("when did it launch?")], webSearch: true, ...overrides });
const claude = (model = "claude-opus-5-5") => new AnthropicModel({ apiKey: "k", model, baseURL: "http://localhost", webSearch: true });
const toolTypes = (body: Record<string, unknown>) => ((body.tools as { type?: string; name: string }[] | undefined) ?? []).map((t) => t.type ?? t.name);

describe("Claude's own web search", () => {
  it("is native on Anthropic's API, not on another endpoint unless configured", () => {
    expect(new AnthropicModel({ apiKey: "k", model: "m" }).capabilities.nativeWebSearch).toBe(true);
    expect(new AnthropicModel({ apiKey: "k", model: "m", baseURL: "https://api.anthropic.com/v1" }).capabilities.nativeWebSearch).toBe(true);
    expect(new AnthropicModel({ apiKey: "k", model: "m", baseURL: "https://api.deepseek.com/anthropic" }).capabilities.nativeWebSearch).toBe(false);
    expect(claude().capabilities.nativeWebSearch).toBe(true);
  });

  it("sends the server tool beside the request's own tools, the filtering one where the model has it", async () => {
    serve(sse([start, ...end("end_turn")]), sse([start, ...end("end_turn")]), sse([start, ...end("end_turn")]));
    await collect(claude().chat(ask({ tools: [{ name: "get_item", description: "d", inputSchema: { type: "object" } }] })));
    expect(toolTypes(bodies[0])).toEqual(["get_item", "web_search_20260209"]);
    await collect(claude("claude-haiku-4-5").chat(ask()));
    expect(toolTypes(bodies[1])).toEqual(["web_search_20250305"]);
    await collect(claude().chat(ask({ webSearch: false })));
    expect(bodies[2].tools).toBeUndefined();
  });

  it("streams the answer with the cited pages listed, and keeps the search blocks for the next request", async () => {
    serve(sse([...searched, { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "tu_1", name: "get_item", input: {} } }, { type: "content_block_stop", index: 3 }, ...end("tool_use")]), sse([start, ...end("end_turn")]));
    const out = await collect(claude().chat(ask()));
    expect(out.text).toBe("It launched on October 17.\n\n- [Search & Fetch](https://api-docs.deepseek.com/guides/search/)");
    expect(out.toolCalls).toEqual([{ id: "tu_1", name: "get_item", args: {} }]);
    expect(out.native?.[0].provider).toBe("anthropic");

    const messages = [...ask().messages, assistantMessage(out), toolResultsMessage([{ id: "tu_1", content: "{}" }])];
    await collect(claude().chat(ask({ messages })));
    const replayed = (bodies[1].messages as { role: string; content: { type: string; input?: unknown; citations?: unknown[] }[] }[])[1];
    expect(replayed.role).toBe("assistant");
    expect(replayed.content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text", "tool_use"]);
    expect(replayed.content[0].input).toEqual({ query: "deepseek search api" });
    expect(replayed.content[2].citations).toHaveLength(1);
  });

  it("resumes a search the server paused, sending back what it wrote so far", async () => {
    serve(sse([start, ...searched.slice(1, 6), ...end("pause_turn")]), sse([start, ...searched.slice(6), ...end("end_turn")]));
    const out = await collect(claude().chat(ask()));
    expect(bodies).toHaveLength(2);
    const resumed = (bodies[1].messages as { role: string; content: { type: string }[] }[]).at(-1)!;
    expect(resumed.role).toBe("assistant");
    expect(resumed.content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result"]);
    expect(out.stop).toBe("end");
    expect(out.text).toContain("It launched on October 17.");
  });

  it("says the search was refused when a request with it is turned down, and nothing else is", async () => {
    const refused = () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "web search is not enabled" } }), { status: 400, headers: { "content-type": "application/json" } });
    serve(refused, refused);
    await expect(collect(claude().chat(ask()))).rejects.toBeInstanceOf(NativeSearchRefused);
    const plain = collect(claude().chat(ask({ webSearch: false })));
    await expect(plain).rejects.not.toBeInstanceOf(NativeSearchRefused);
  });
});
