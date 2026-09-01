import type { ChatEvent, ChatModel, ChatRequest, StopReason } from "./model.js";
import { LlmError } from "./errors.js";

export interface OpenAiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

function toMessages(request: ChatRequest): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: request.system }];
  for (const message of request.messages) {
    if (message.role === "user") {
      // Tool results must directly follow the assistant turn that asked for them.
      for (const block of message.content) {
        if (block.type === "tool_result") out.push({ role: "tool", tool_call_id: block.id, content: block.content });
      }
      const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) out.push({ role: "user", content: text });
    } else {
      const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = message.content.filter((b) => b.type === "tool_call");
      const row: OpenAiMessage = { role: "assistant", content: text || null };
      if (calls.length) row.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
      out.push(row);
    }
  }
  return out;
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

const parseArgs = (raw: string): unknown => {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { __raw: raw };
  }
};

interface StreamChunk {
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  choices?: {
    finish_reason?: string | null;
    delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
  }[];
}

/** Any chat/completions endpoint: DeepSeek, OpenAI, Kimi, OpenRouter, Ollama, vLLM, LM Studio… */
export class OpenAiCompatible implements ChatModel {
  capabilities = { tools: true, streaming: true, json: true };

  constructor(private readonly config: OpenAiConfig) {}

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toMessages(request)
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.effort) body.reasoning_effort = request.effort;
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      const choice = request.toolChoice;
      if (choice) body.tool_choice = typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
    }
    if (request.json) body.response_format = { type: "json_object" };

    const res = await fetch(this.config.baseURL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + this.config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) throw new LlmError(`LLM request failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    if (!res.body) throw new LlmError("LLM response had no body");

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let stop: StopReason = "end";
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        continue;
      }
      if (chunk.usage) yield { type: "usage", inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) yield { type: "text", delta: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        const slot = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        calls.set(tc.index, slot);
      }
      if (choice.finish_reason === "tool_calls") stop = "tool_use";
      else if (choice.finish_reason === "length") stop = "max_tokens";
      else if (choice.finish_reason === "content_filter") stop = "refusal";
    }
    let n = 0;
    for (const [, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
      yield { type: "tool_call", id: call.id || `call_${n}`, name: call.name, args: parseArgs(call.args) };
      n += 1;
    }
    if (n > 0) stop = "tool_use";
    yield { type: "stop", reason: stop };
  }
}
