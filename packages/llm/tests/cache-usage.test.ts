/**
 * Each provider names its cached input differently. The adapters read them all,
 * so a turn on Tomrade's own profiles reports cache reads the way agent engines
 * do — and input stays every prompt token read, cached ones included.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicModel, OpenAiCompatible, collect, userMessage } from "@tomradex/llm";

const sse = (chunks: string[]) => new Response(chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const usageOf = async (usage: Record<string, unknown>) => {
  vi.stubGlobal("fetch", async () => sse(['{"choices":[{"delta":{"content":"ok"}}]}', JSON.stringify({ choices: [], usage })]));
  return (await collect(new OpenAiCompatible({ baseURL: "http://localhost/v1", apiKey: "k", model: "m" }).chat({ system: "s", messages: [userMessage("hi")] }))).usage;
};

afterEach(() => vi.unstubAllGlobals());

describe("cached input", () => {
  it("reads OpenAI's cached_tokens", async () => {
    expect(await usageOf({ prompt_tokens: 2000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 1536 } })).toEqual({ inputTokens: 2000, outputTokens: 10, cacheReadTokens: 1536 });
  });

  it("reads DeepSeek's prompt_cache_hit_tokens", async () => {
    expect(await usageOf({ prompt_tokens: 68000, completion_tokens: 300, prompt_cache_hit_tokens: 52000, prompt_cache_miss_tokens: 16000 })).toEqual({ inputTokens: 68000, outputTokens: 300, cacheReadTokens: 52000 });
  });

  it("reads Kimi's cached_tokens", async () => {
    expect(await usageOf({ prompt_tokens: 900, completion_tokens: 5, cached_tokens: 512 })).toEqual({ inputTokens: 900, outputTokens: 5, cacheReadTokens: 512 });
  });

  it("leaves the counts out when the endpoint says nothing about a cache", async () => {
    expect(await usageOf({ prompt_tokens: 900, completion_tokens: 5 })).toEqual({ inputTokens: 900, outputTokens: 5 });
  });

  it("counts Anthropic's cache read and write into input, and reports both", async () => {
    vi.stubGlobal("fetch", async () => new Response([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":40,"cache_read_input_tokens":12000,"cache_creation_input_tokens":800}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join(""), { headers: { "content-type": "text/event-stream" } }));
    const out = await collect(new AnthropicModel({ baseURL: "http://localhost", apiKey: "k", model: "claude" }).chat({ system: "s", messages: [userMessage("hi")] }));
    expect(out.usage).toEqual({ inputTokens: 12840, outputTokens: 25, cacheReadTokens: 12000, cacheWriteTokens: 800 });
  });
});
