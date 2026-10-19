import type { ChatEvent, ChatRequest, StopReason } from "./model.js";
import { LlmError } from "./errors.js";

const OPENAI = /^https?:\/\/api\.openai\.com(\/|$)/i;
const DEEPSEEK = /^https?:\/\/api\.deepseek\.com(\/|$)/i;

/**
 * Whether the model searches the web on its own through the Responses API:
 * OpenAI's current models, and DeepSeek's v4-pro (the only one its `web_search` serves).
 */
export const searchesOnResponses = (baseURL: string, model: string): boolean =>
  (OPENAI.test(baseURL) && /^(gpt-4\.1|gpt-4o|gpt-5|o3|o4)/.test(model)) || (DEEPSEEK.test(baseURL) && /^deepseek-v4-pro/.test(model));

/** Whether every input of the request has a Responses form; one that has not goes through chat/completions without the search. */
export const fitsResponses = (request: ChatRequest): boolean =>
  !request.json && request.messages.every((m) => m.content.every((b) => b.type !== "media" || b.media.mime.startsWith("image/") || b.media.mime === "application/pdf"));

/**
 * The conversation as Responses input items. Reasoning is not sent back, as on chat/completions; a
 * function call goes without an item id, so no model asks for the reasoning that came with it.
 */
export function toResponsesInput(request: ChatRequest): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.role === "user") {
      for (const block of message.content) if (block.type === "tool_result") out.push({ type: "function_call_output", call_id: block.id, output: block.content });
      const parts = message.content.flatMap((block): Record<string, unknown>[] => {
        if (block.type === "text") return [{ type: "input_text", text: block.text }];
        if (block.type !== "media") return [];
        const url = `data:${block.media.mime};base64,${block.media.base64}`;
        return [block.media.mime.startsWith("image/") ? { type: "input_image", image_url: url } : { type: "input_file", filename: block.media.name, file_data: url }];
      });
      if (parts.length) out.push({ role: "user", content: parts });
    } else {
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      if (text) out.push({ role: "assistant", content: text });
      for (const block of message.content) if (block.type === "tool_call") out.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.args ?? {}) });
    }
  }
  return out;
}

export function responsesBody(model: string, request: ChatRequest): Record<string, unknown> {
  const choice = request.toolChoice;
  return {
    model,
    instructions: request.system,
    input: toResponsesInput(request),
    stream: true,
    store: false,
    tools: [...(request.tools ?? []).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })), { type: "web_search" }],
    ...(choice ? { tool_choice: typeof choice === "string" ? choice : { type: "function", name: choice.name } } : {}),
    ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.effort ? { reasoning: { effort: request.effort } } : {})
  };
}

const parseArgs = (raw: string): unknown => {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { __raw: raw };
  }
};

interface ResponseEvent {
  type: string;
  delta?: string;
  annotation?: { type?: string; url?: string; title?: string };
  item?: { type?: string; call_id?: string; name?: string; arguments?: string; content?: { annotations?: { type?: string; url?: string; title?: string }[] }[] };
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } | null } | null;
    incomplete_details?: { reason?: string } | null;
    error?: { message?: string } | null;
  };
  message?: string;
}

/** A Responses stream as chat events: text as it comes, function calls when complete, the cited pages listed after the answer. */
export async function* readResponses(data: AsyncIterable<string>): AsyncGenerator<ChatEvent> {
  const sources = new Map<string, string>();
  const cite = (a?: { type?: string; url?: string; title?: string }) => {
    if (a?.type === "url_citation" && a.url && !sources.has(a.url)) sources.set(a.url, a.title || a.url);
  };
  let stop: StopReason = "end";
  let calls = 0;
  for await (const raw of data) {
    if (raw === "[DONE]") break;
    let event: ResponseEvent;
    try {
      event = JSON.parse(raw) as ResponseEvent;
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && event.delta) yield { type: "text", delta: event.delta };
    else if (event.type === "response.output_text.annotation.added") cite(event.annotation);
    else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      calls += 1;
      yield { type: "tool_call", id: event.item.call_id ?? `call_${calls}`, name: event.item.name ?? "", args: parseArgs(event.item.arguments ?? "") };
    } else if (event.type === "response.output_item.done" && event.item?.type === "message") {
      for (const part of event.item.content ?? []) for (const a of part.annotations ?? []) cite(a);
    } else if (event.type === "response.completed" || event.type === "response.incomplete") {
      const u = event.response?.usage;
      if (u) yield { type: "usage", inputTokens: u.input_tokens, outputTokens: u.output_tokens, ...(u.input_tokens_details?.cached_tokens != null ? { cacheReadTokens: u.input_tokens_details.cached_tokens } : {}) };
      const reason = event.response?.incomplete_details?.reason;
      if (reason === "max_output_tokens") stop = "max_tokens";
      else if (reason === "content_filter") stop = "refusal";
    } else if (event.type === "response.failed" || event.type === "error") {
      throw new LlmError(`LLM request failed: ${event.response?.error?.message ?? event.message ?? event.type}`);
    }
  }
  if (sources.size) yield { type: "text", delta: "\n\n" + [...sources].map(([url, title]) => `- [${title.replace(/[[\]]/g, "")}](${url})`).join("\n") };
  yield { type: "stop", reason: calls > 0 && stop === "end" ? "tool_use" : stop };
}
