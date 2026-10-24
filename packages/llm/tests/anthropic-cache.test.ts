/**
 * What Anthropic is asked to cache: the stable system text as one block, the
 * volatile tail after it uncached, and the last message as the breakpoint that
 * keeps the conversation so far in the cache for the next turn.
 */
import { afterEach, expect, it, vi } from "vitest";
import { AnthropicModel, OpenAiCompatible, collect, userMessage } from "@tomradex/llm";

afterEach(() => vi.unstubAllGlobals());

const reply = () => new Response([
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'
].join(""), { headers: { "content-type": "text/event-stream" } });

it("caches the stable system block, sends the tail uncached after it, and marks the last message", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: { body?: string }) => (bodies.push(JSON.parse(init.body ?? "{}")), reply()));
  const model = new AnthropicModel({ baseURL: "http://localhost", apiKey: "k", model: "claude" });
  await collect(model.chat({ system: "stable", systemTail: "cards for this turn", messages: [userMessage("first"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, userMessage("second")] }));
  expect(bodies[0].system).toEqual([{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }, { type: "text", text: "cards for this turn" }]);
  const messages = bodies[0].messages as { content: Record<string, unknown>[] }[];
  expect(messages[0].content[0]).not.toHaveProperty("cache_control");
  expect(messages[2].content[0]).toMatchObject({ type: "text", text: "second", cache_control: { type: "ephemeral" } });

  await collect(model.chat({ system: "stable", messages: [userMessage("alone")] }));
  expect(bodies[1].system).toEqual([{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }]);
});

it("appends the tail to the one system string a provider without cache blocks takes", async () => {
  const bodies: Record<string, unknown>[] = [];
  const sse = new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  vi.stubGlobal("fetch", async (_url: unknown, init: { body?: string }) => (bodies.push(JSON.parse(init.body ?? "{}")), sse));
  await collect(new OpenAiCompatible({ baseURL: "http://localhost/v1", apiKey: "k", model: "m" }).chat({ system: "stable", systemTail: "tail", messages: [userMessage("hi")] }));
  expect((bodies[0].messages as { role: string; content: string }[])[0]).toEqual({ role: "system", content: "stable\n\ntail" });
});
