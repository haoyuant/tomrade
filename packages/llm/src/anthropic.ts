import Anthropic from "@anthropic-ai/sdk";
import { inputMimes, type InputModality, type ChatEvent, type ChatModel, type ChatRequest, type StopReason } from "./model.js";
import { LlmError } from "./errors.js";
import { fetchFailure, pause } from "./openai.js";

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  inputModalities?: InputModality[];
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "image" | "document"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

function toMessages(request: ChatRequest): { role: "user" | "assistant"; content: AnthropicContent[] }[] {
  return request.messages
    .map((message) => ({
      role: message.role,
      content: message.content.map((block): AnthropicContent => {
        if (block.type === "text") return { type: "text", text: block.text };
        if (block.type === "media") return { type: block.media.mime === "application/pdf" ? "document" : "image", source: { type: "base64", media_type: block.media.mime, data: block.media.base64 } };
        if (block.type === "tool_call") return { type: "tool_use", id: block.id, name: block.name, input: block.args ?? {} };
        return { type: "tool_result", tool_use_id: block.id, content: block.content, is_error: block.isError };
      })
    }))
    .filter((m) => m.content.length > 0);
}

const RETRIES = 2;
const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const stopOf = (reason: string | null | undefined): StopReason =>
  reason === "tool_use" ? "tool_use" : reason === "max_tokens" ? "max_tokens" : reason === "refusal" ? "refusal" : "end";

/** Claude over the Messages API. No sampling params — current models refuse them; effort/thinking stay at their defaults. */
export class AnthropicModel implements ChatModel {
  get capabilities() { return { tools: true, streaming: true, json: false, mediaInput: inputMimes(this.config.inputModalities ?? ["image", "pdf"]).filter(mime => mime.startsWith("image/") || mime === "application/pdf") }; }

  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicConfig) {
    // Retried here instead of inside the SDK, so each attempt can be told to the person waiting.
    this.client = new Anthropic({ apiKey: config.apiKey, maxRetries: 0, ...(config.baseURL ? { baseURL: config.baseURL } : {}) });
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    for (const message of request.messages) for (const block of message.content) {
      if (block.type === "media" && !this.capabilities.mediaInput.includes(block.media.mime)) throw new LlmError(`This model profile does not accept ${block.media.mime}`);
    }
    const choice = request.toolChoice;
    const send = () => this.client.messages.create(
      {
        model: this.config.model,
        max_tokens: request.maxTokens ?? 16000,
        stream: true,
        // The stable prefix ends at the system block; the conversation varies after it.
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: toMessages(request) as Anthropic.MessageParam[],
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) as Anthropic.Tool[],
              ...(choice ? { tool_choice: typeof choice === "string" ? { type: choice } : { type: "tool", name: choice.name } } : {})
            }
          : {})
      },
      { signal }
    );
    let stream!: Awaited<ReturnType<typeof send>>;
    for (let attempt = 1; ; attempt += 1) {
      try {
        stream = await send();
        break;
      } catch (err) {
        const status = err instanceof Anthropic.APIError ? err.status : undefined;
        const transient = err instanceof Anthropic.APIConnectionError || (status !== undefined && TRANSIENT.has(status));
        if (signal?.aborted || !transient || attempt > RETRIES) throw err;
        const after = Number((err as { headers?: Headers }).headers?.get?.("retry-after"));
        const delayMs = Number.isFinite(after) && after > 0 && after <= 20 ? after * 1000 : 1000 * 3 ** (attempt - 1);
        yield { type: "retry", attempt, max: RETRIES, reason: status ? `HTTP ${status}` : fetchFailure(err), delayMs };
        await pause(delayMs, signal);
      }
    }

    let stop: StopReason = "end";
    let tool: { id: string; name: string; json: string } | null = null;
    for await (const event of stream) {
      if (event.type === "message_start") {
        yield { type: "usage", inputTokens: event.message.usage.input_tokens };
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") tool = { id: event.content_block.id, name: event.content_block.name, json: "" };
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") yield { type: "text", delta: event.delta.text };
        else if (event.delta.type === "input_json_delta" && tool) tool.json += event.delta.partial_json;
      } else if (event.type === "content_block_stop") {
        if (tool) {
          let args: unknown = {};
          try {
            args = tool.json ? JSON.parse(tool.json) : {};
          } catch {
            args = { __raw: tool.json };
          }
          yield { type: "tool_call", id: tool.id, name: tool.name, args };
          tool = null;
        }
      } else if (event.type === "message_delta") {
        yield { type: "usage", outputTokens: event.usage.output_tokens };
        stop = stopOf(event.delta.stop_reason);
      }
    }
    yield { type: "stop", reason: stop };
  }
}
