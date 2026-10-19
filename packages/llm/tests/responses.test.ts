/**
 * OpenAI's current models and DeepSeek's v4-pro search the web on their own
 * through the Responses API: a request that asks for it goes to /responses with
 * the conversation as input items, the stream comes back as the same chat
 * events, the cited pages are kept, and a refusal says it was the search.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmError, NativeSearchRefused, OpenAiCompatible, collect, toolResultsMessage, userMessage, type ChatRequest } from "@tomradex/llm";

const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

let sent: { url: string; body: Record<string, unknown> }[] = [];
const serve = (...replies: Response[]) => {
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return replies.shift() ?? new Response("{}", { status: 500 });
  });
};
afterEach(() => vi.unstubAllGlobals());

const openai = (model = "gpt-5.5") => new OpenAiCompatible({ baseURL: "https://api.openai.com/v1", apiKey: "k", model, retryDelayMs: 1 });
const deepseek = (model: string) => new OpenAiCompatible({ baseURL: "https://api.deepseek.com", apiKey: "k", model });
const ask = (over: Partial<ChatRequest> = {}): ChatRequest => ({ system: "Be brief.", messages: [userMessage("what's new?")], webSearch: true, ...over });

const answered = [
  { type: "response.created" },
  { type: "response.output_item.added", item: { type: "web_search_call" } },
  { type: "response.output_text.delta", delta: "DeepSeek shipped " },
  { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://api-docs.deepseek.com/guides/search/", title: "Search & Fetch" } },
  { type: "response.output_text.delta", delta: "a search API." },
  { type: "response.completed", response: { usage: { input_tokens: 900, output_tokens: 40, input_tokens_details: { cached_tokens: 512 } } } }
];

describe("searching on the Responses API", () => {
  it("is what OpenAI's current models and DeepSeek's v4-pro do, and nothing else unless configured", () => {
    expect(openai().capabilities.nativeWebSearch).toBe(true);
    expect(openai("gpt-4o-mini").capabilities.nativeWebSearch).toBe(true);
    expect(openai("gpt-3.5-turbo").capabilities.nativeWebSearch).toBe(false);
    expect(deepseek("deepseek-v4-pro").capabilities.nativeWebSearch).toBe(true);
    expect(deepseek("deepseek-flash").capabilities.nativeWebSearch).toBe(false);
    expect(new OpenAiCompatible({ baseURL: "https://openrouter.ai/api/v1", apiKey: "k", model: "openai/gpt-5.5" }).capabilities.nativeWebSearch).toBe(false);
    expect(new OpenAiCompatible({ baseURL: "http://localhost:8080/v1", apiKey: "k", model: "m", webSearch: true }).capabilities.nativeWebSearch).toBe(true);
  });

  it("sends the conversation as input items with the search beside the function tools", async () => {
    serve(sse(answered));
    const messages = [
      userMessage("what's new?"),
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Looking." }, { type: "tool_call" as const, id: "c1", name: "get_item", args: { key: "TOM-1" } }] },
      toolResultsMessage([{ id: "c1", content: "{}" }])
    ];
    await collect(openai().chat(ask({ messages, tools: [{ name: "get_item", description: "d", inputSchema: { type: "object" } }], maxTokens: 4000, effort: "low", toolChoice: "auto" })));
    expect(sent[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(sent[0]!.body).toEqual({
      model: "gpt-5.5",
      instructions: "Be brief.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "what's new?" }] },
        { role: "assistant", content: "Looking." },
        { type: "function_call", call_id: "c1", name: "get_item", arguments: '{"key":"TOM-1"}' },
        { type: "function_call_output", call_id: "c1", output: "{}" }
      ],
      stream: true,
      store: false,
      tools: [{ type: "function", name: "get_item", description: "d", parameters: { type: "object" } }, { type: "web_search" }],
      tool_choice: "auto",
      max_output_tokens: 4000,
      reasoning: { effort: "low" }
    });
  });

  it("streams the answer with the cited pages listed, and reports usage with the cache", async () => {
    serve(sse(answered));
    const out = await collect(deepseek("deepseek-v4-pro").chat(ask()));
    expect(sent[0]!.url).toBe("https://api.deepseek.com/responses");
    expect(out.text).toBe("DeepSeek shipped a search API.\n\n- [Search & Fetch](https://api-docs.deepseek.com/guides/search/)");
    expect(out.usage).toEqual({ inputTokens: 900, outputTokens: 40, cacheReadTokens: 512 });
    expect(out.stop).toBe("end");
  });

  it("hands over a function call once it is complete, and says when the output ran out", async () => {
    serve(
      sse([
        { type: "response.output_item.added", item: { type: "function_call", call_id: "c9", name: "get_item", arguments: "" } },
        { type: "response.function_call_arguments.delta", delta: '{"key":' },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "c9", name: "get_item", arguments: '{"key":"TOM-9"}' } },
        { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } }
      ]),
      sse([{ type: "response.output_text.delta", delta: "Half" }, { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }])
    );
    const called = await collect(openai().chat(ask()));
    expect(called.toolCalls).toEqual([{ id: "c9", name: "get_item", args: { key: "TOM-9" } }]);
    expect(called.stop).toBe("tool_use");
    expect((await collect(openai().chat(ask()))).stop).toBe("max_tokens");
  });

  it("keeps chat/completions for a request that does not search, or asks for JSON", async () => {
    const chat = () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    serve(chat(), chat(), chat());
    await collect(openai().chat(ask({ webSearch: false })));
    await collect(openai().chat(ask({ json: true })));
    await collect(deepseek("deepseek-flash").chat(ask()));
    expect(sent.map((s) => s.url)).toEqual(["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions", "https://api.deepseek.com/chat/completions"]);
    expect(sent.every((s) => !("tools" in s.body) || !JSON.stringify(s.body.tools).includes("web_search"))).toBe(true);
  });

  it("says the search was refused when the endpoint turns the request down, and nothing else is", async () => {
    serve(new Response('{"error":{"message":"Tool web_search is not supported with this model."}}', { status: 400 }), new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    await expect(collect(openai().chat(ask()))).rejects.toBeInstanceOf(NativeSearchRefused);
    const refused = collect(openai().chat(ask()));
    await expect(refused).rejects.toBeInstanceOf(LlmError);
    await expect(collect(openai().chat(ask()))).rejects.not.toBeInstanceOf(NativeSearchRefused);
  });

  it("fails with the provider's reason when the stream says it failed", async () => {
    serve(sse([{ type: "response.failed", response: { error: { message: "search backend unavailable" } } }]));
    await expect(collect(openai().chat(ask()))).rejects.toThrow("search backend unavailable");
  });
});
