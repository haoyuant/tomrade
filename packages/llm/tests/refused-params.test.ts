/**
 * OpenAI's newer models refuse `max_tokens` (they take `max_completion_tokens`)
 * and any temperature but the default, while DeepSeek and most compatible
 * endpoints still want `max_tokens`. A refusal of that kind is asked again
 * without the parameter, and remembered.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAiCompatible, collect, userMessage } from "@tomradex/llm";

let server: http.Server;
let base = "";
let bodies: Record<string, unknown>[] = [];
/** Answers like a gpt-5 model when true, like DeepSeek when false. */
let strict = true;
const refuse = (message: string, param: string, code: string) => JSON.stringify({ error: { message, type: "invalid_request_error", param, code } });
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      if (strict && "max_tokens" in body) return res.writeHead(400, { "content-type": "application/json" }).end(refuse("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", "max_tokens", "unsupported_parameter"));
      if (strict && "temperature" in body && body.temperature !== 1) return res.writeHead(400, { "content-type": "application/json" }).end(refuse(`Unsupported value: 'temperature' does not support ${body.temperature} with this model. Only the default (1) value is supported.`, "temperature", "unsupported_value"));
      if (!strict && "max_completion_tokens" in body) return res.writeHead(400, { "content-type": "application/json" }).end(refuse("Unknown parameter: 'max_completion_tokens'", "max_completion_tokens", "invalid"));
      res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const model = () => new OpenAiCompatible({ baseURL: base, apiKey: "k", model: "m", retryDelayMs: 1 });
const ask = (m: OpenAiCompatible, extra: { temperature?: number } = {}) => collect(m.chat({ system: "s", messages: [userMessage("ping")], maxTokens: 50, ...extra }));

describe("parameters a model refuses", () => {
  it("asks again with max_completion_tokens and keeps using it", async () => {
    strict = true;
    bodies = [];
    const m = model();
    expect((await ask(m)).text).toBe("pong");
    expect((await ask(m)).text).toBe("pong");
    expect(bodies.map((b) => ("max_tokens" in b ? "max_tokens" : "max_completion_tokens" in b ? `max_completion_tokens=${b.max_completion_tokens}` : "-"))).toEqual(["max_tokens", "max_completion_tokens=50", "max_completion_tokens=50"]);
  });

  it("drops a temperature the model only takes at its default", async () => {
    strict = true;
    bodies = [];
    const m = model();
    expect((await ask(m, { temperature: 0.2 })).text).toBe("pong");
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty("temperature");
    bodies = [];
    await ask(m, { temperature: 0.2 });
    expect(bodies).toHaveLength(1);
  });

  it("sends max_tokens to endpoints that take it", async () => {
    strict = false;
    bodies = [];
    expect((await ask(model(), { temperature: 0.2 })).text).toBe("pong");
    expect(bodies).toEqual([expect.objectContaining({ max_tokens: 50, temperature: 0.2 })]);
  });

  it("sends max_completion_tokens to OpenAI from the first request", () => {
    const sent: Record<string, unknown>[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));
      return new Response('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    }) as typeof fetch;
    return ask(new OpenAiCompatible({ baseURL: "https://api.openai.com/v1", apiKey: "k", model: "gpt-5.5" }))
      .then((out) => {
        expect(out.text).toBe("pong");
        expect(sent).toEqual([expect.objectContaining({ max_completion_tokens: 50 })]);
        expect(sent[0]).not.toHaveProperty("max_tokens");
      })
      .finally(() => (globalThis.fetch = real));
  });
});
