/**
 * Gemini on Google's Interactions API: requests are stateless steps, a reply's
 * own steps (thoughts, calls, search, with their signatures) go back as Gemini
 * wrote them, the stream comes back as the usual chat events, and what a key
 * cannot do (Google Search, a model off its plan) says so instead of waiting.
 */
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { GeminiModel, Llm, LlmError, NativeSearchRefused, assistantMessage, collect, probe, toolResultsMessage, userMessage, type ChatRequest, type ModelsSettings } from "@tomradex/llm";

const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`).join("") + "event: done\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
const serve = (...replies: Response[]) => {
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return replies.shift() ?? new Response("{}", { status: 500 });
  });
};
afterEach(() => vi.unstubAllGlobals());

const gemini = (model = "models/gemini-3.8-flash") => new GeminiModel({ apiKey: "AIza-key", model, inputModalities: ["image"], retryDelayMs: 1 });
const ask = (over: Partial<ChatRequest> = {}): ChatRequest => ({ system: "Be brief.", messages: [userMessage("Look up TOM-1.")], ...over });
const tools = [{ name: "get_item", description: "Fetch a ticket", inputSchema: { type: "object", properties: { key: { type: "string" } } } }];

const called = [
  { event_type: "interaction.created", interaction: { model: "gemini-3.8-flash" } },
  { event_type: "step.start", index: 0, step: { type: "thought" } },
  { event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "SIG-THOUGHT" } },
  { event_type: "step.stop", index: 0 },
  { event_type: "step.start", index: 1, step: { type: "function_call", id: "call_1", name: "get_item", arguments: {}, signature: "SIG-CALL" } },
  { event_type: "step.delta", index: 1, delta: { type: "arguments_delta", arguments: '{"key":' } },
  { event_type: "step.delta", index: 1, delta: { type: "arguments_delta", arguments: '"TOM-1"}' } },
  { event_type: "step.stop", index: 1 },
  { event_type: "interaction.completed", interaction: { status: "requires_action", usage: { total_input_tokens: 70, total_output_tokens: 18, total_thought_tokens: 100, total_cached_tokens: 0 } } }
];

describe("Gemini on the Interactions API", () => {
  it("asks statelessly with the model's bare name, the system, the steps, the tools and the thinking level", async () => {
    serve(sse(called));
    await collect(gemini().chat(ask({ tools, effort: "xhigh", maxTokens: 4000, toolChoice: { name: "get_item" } })));
    expect(sent[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(sent[0]!.headers["x-goog-api-key"]).toBe("AIza-key");
    expect(sent[0]!.body).toEqual({
      model: "gemini-3.8-flash",
      store: false,
      stream: true,
      system_instruction: "Be brief.",
      input: [{ type: "user_input", content: [{ type: "text", text: "Look up TOM-1." }] }],
      tools: [{ type: "function", name: "get_item", description: "Fetch a ticket", parameters: { type: "object", properties: { key: { type: "string" } } } }],
      generation_config: { max_output_tokens: 4000, thinking_level: "high", tool_choice: { allowed_tools: { mode: "any", tools: ["get_item"] } } }
    });
  });

  it("hands over a call once its step ends, counts thinking as output, and gives the steps back with their signatures", async () => {
    serve(sse(called), sse([
      { event_type: "step.start", index: 0, step: { type: "model_output" } },
      { event_type: "step.delta", index: 0, delta: { type: "text", text: "It is " } },
      { event_type: "step.delta", index: 0, delta: { type: "text", text: "Fix login." } },
      { event_type: "step.stop", index: 0 },
      { event_type: "interaction.completed", interaction: { status: "completed", usage: { total_input_tokens: 200, total_output_tokens: 5, total_cached_tokens: 64 } } }
    ]));
    const step = await collect(gemini().chat(ask({ tools })));
    expect(step.toolCalls).toEqual([{ id: "call_1", name: "get_item", args: { key: "TOM-1" } }]);
    expect(step.stop).toBe("tool_use");
    expect(step.usage).toEqual({ inputTokens: 70, outputTokens: 118 });
    const messages = [userMessage("Look up TOM-1."), assistantMessage(step), toolResultsMessage([{ id: "call_1", content: '{"title":"Fix login"}' }])];
    const answer = await collect(gemini().chat(ask({ messages, tools })));
    expect(sent[1]!.body.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "Look up TOM-1." }] },
      { type: "thought", signature: "SIG-THOUGHT" },
      { type: "function_call", id: "call_1", name: "get_item", arguments: { key: "TOM-1" }, signature: "SIG-CALL" },
      { type: "function_result", call_id: "call_1", name: "get_item", result: [{ type: "text", text: '{"title":"Fix login"}' }] }
    ]);
    expect(answer).toMatchObject({ text: "It is Fix login.", stop: "end", usage: { inputTokens: 200, outputTokens: 5, cacheReadTokens: 64 } });
  });

  it("sends another model's turns as plain output and calls, and media as content", async () => {
    serve(sse([{ event_type: "interaction.completed", interaction: { status: "completed" } }]));
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "What is this?" }, { type: "media" as const, media: { name: "a.png", mime: "image/png", base64: "AAAA" } }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Checking." }, { type: "tool_call" as const, id: "c9", name: "get_item", args: { key: "TOM-9" } }] },
      toolResultsMessage([{ id: "c9", content: "gone", isError: true }])
    ];
    await collect(gemini().chat(ask({ messages, json: true })));
    expect(sent[0]!.body.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "What is this?" }, { type: "image", data: "AAAA", mime_type: "image/png" }] },
      { type: "model_output", content: [{ type: "text", text: "Checking." }] },
      { type: "function_call", id: "c9", name: "get_item", arguments: { key: "TOM-9" } },
      { type: "function_result", call_id: "c9", name: "get_item", result: [{ type: "text", text: "gone" }], is_error: true }
    ]);
    expect(sent[0]!.body.response_format).toEqual({ type: "text", mime_type: "application/json" });
  });

  it("searches Google beside the tools on Gemini 3 and later, keeps the search steps, and lists the cited pages", async () => {
    expect(gemini("gemini-2.5-flash").capabilities.nativeWebSearch).toBe(false);
    expect(gemini("gemini-4-argon").capabilities.nativeWebSearch).toBe(true);
    serve(sse([
      { event_type: "step.start", index: 0, step: { type: "google_search_call", id: "s1", signature: "SIG-S" } },
      { event_type: "step.delta", index: 0, delta: { type: "google_search_call", arguments: { queries: ["deepseek search api"] } } },
      { event_type: "step.stop", index: 0 },
      { event_type: "step.start", index: 1, step: { type: "google_search_result", call_id: "s1" } },
      { event_type: "step.delta", index: 1, delta: { type: "google_search_result", result: [{ search_suggestions: "<div/>" }], signature: "SIG-R" } },
      { event_type: "step.stop", index: 1 },
      { event_type: "step.start", index: 2, step: { type: "model_output", content: [{ type: "text", text: "DeepSeek shipped search." }] } },
      { event_type: "step.delta", index: 2, delta: { type: "text_annotation_delta", annotations: [{ type: "url_citation", url: "https://api-docs.deepseek.com/guides/search/", title: "Search [API]" }] } },
      { event_type: "step.stop", index: 2 },
      { event_type: "interaction.completed", interaction: { status: "completed" } }
    ]));
    const out = await collect(gemini().chat(ask({ tools, webSearch: true })));
    expect((sent[0]!.body.tools as { type: string }[]).map((t) => t.type)).toEqual(["function", "google_search"]);
    expect(out.text).toBe("DeepSeek shipped search.\n\n- [Search API](https://api-docs.deepseek.com/guides/search/)");
    expect(out.native?.[0]).toEqual({
      provider: "gemini",
      data: [
        { type: "google_search_call", id: "s1", signature: "SIG-S", arguments: { queries: ["deepseek search api"] } },
        { type: "google_search_result", call_id: "s1", result: [{ search_suggestions: "<div/>" }], signature: "SIG-R" },
        { type: "model_output", content: [{ type: "text", text: "DeepSeek shipped search.", annotations: [{ type: "url_citation", url: "https://api-docs.deepseek.com/guides/search/", title: "Search [API]" }] }] }
      ]
    });
  });

  it("says the search was refused when the key's plan has none, so the loop searches another way", async () => {
    const quota = () => new Response('{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","code":"too_many_requests"}}', { status: 429 });
    serve(quota());
    const model = gemini();
    await expect(collect(model.chat(ask({ webSearch: true })))).rejects.toBeInstanceOf(NativeSearchRefused);
    expect(sent).toHaveLength(1);
    // and is not asked again: later turns go to the plugin from the start
    expect(model.capabilities.nativeWebSearch).toBe(false);
  });

  it("does not wait out a model the key's plan does not include, and the check says so", async () => {
    const zero = () => new Response('event: error\ndata: {"error":{"message":"Rate limit exceeded for model gemini-4-argon (limit: 0 input tokens per minute on Free Tier).","code":"rate_limit_exceeded"},"event_type":"error"}\n\n', { status: 429 });
    serve(zero());
    expect(await probe(gemini("gemini-4-argon"))).toMatchObject({ ok: false, kind: "model", detail: expect.stringContaining("not available on your plan") });
    expect(sent).toHaveLength(1);
  });

  it("tries an overloaded model again, and a stream that ends in an error fails with Gemini's words", async () => {
    serve(new Response('{"error":{"message":"high demand"}}', { status: 503 }), sse([{ event_type: "error", error: { code: "internal", message: "backend hiccup" } }]));
    const events: string[] = [];
    await expect(
      (async () => {
        for await (const e of gemini().chat(ask())) events.push(e.type);
      })()
    ).rejects.toThrow(/backend hiccup/);
    expect(events[0]).toBe("retry");
    expect(sent).toHaveLength(2);
  });

  it("fails plainly on a request it got wrong", async () => {
    serve(new Response('{"error":{"message":"bad tool schema"}}', { status: 400 }));
    const failed = collect(gemini().chat(ask({ tools })));
    await expect(failed).rejects.toBeInstanceOf(LlmError);
    await expect(failed).rejects.not.toBeInstanceOf(NativeSearchRefused);
  });
});

describe("the save-time check", () => {
  it("tells a model that never answered from one that kept failing, rather than blaming the address", async () => {
    const silent = { capabilities: { tools: true, streaming: true, json: true }, chat: async function* (_r: ChatRequest, signal?: AbortSignal) { await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))); } };
    expect(await probe(silent as never, 50)).toMatchObject({ ok: false, kind: "slow" });
    const busy = { capabilities: { tools: true, streaming: true, json: true }, chat: async function* (_r: ChatRequest, signal?: AbortSignal) { yield { type: "retry" as const, attempt: 1, max: 2, reason: "HTTP 503", delayMs: 10 }; await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))); } };
    expect(await probe(busy as never, 50)).toMatchObject({ ok: false, kind: "server", detail: expect.stringContaining("HTTP 503") });
  });
});

it("moves a profile saved on Gemini's compatible endpoint to the Gemini provider, key and id kept", async () => {
  const ctx = new Context();
  const file = path.join(os.tmpdir(), `tomrade-gemini-${Date.now()}-${Math.random()}.json`);
  await ctx.plugin(Settings, { path: file });
  const profiles: ModelsSettings["profiles"] = [
    { id: "g", title: "Gemini", provider: "openai-compatible", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: "AIza-key", model: "models/gemini-3.8-flash" },
    { id: "pics", title: "Nano", provider: "openai-compatible", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: "AIza-key", model: "models/gemini-3.1-flash-image", outputModalities: ["image"] },
    { id: "d", title: "DeepSeek", provider: "openai-compatible", baseURL: "https://api.deepseek.com", apiKey: "sk", model: "deepseek-flash" }
  ];
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles, roles: { worker: "g" } } });
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
  await ctx.plugin(Llm);
  const saved = (ctx.settings.get().models as ModelsSettings).profiles;
  expect(saved[0]).toEqual({ id: "g", title: "Gemini", provider: "gemini", apiKey: "AIza-key", model: "gemini-3.8-flash" });
  expect(saved.slice(1)).toEqual(profiles.slice(1));
  expect((ctx.settings.get().models as ModelsSettings).roles.worker).toBe("g");
});
