import Anthropic from "@anthropic-ai/sdk";
import type { ChatEvent, ChatModel, ChatRequest, StopReason } from "./model.js";

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

function toMessages(request: ChatRequest): { role: "user" | "assistant"; content: AnthropicContent[] }[] {
  return request.messages
    .map((message) => ({
      role: message.role,
      content: message.content.map((block): AnthropicContent => {
        if (block.type === "text") return { type: "text", text: block.text };
        if (block.type === "tool_call") return { type: "tool_use", id: block.id, name: block.name, input: block.args ?? {} };
        return { type: "tool_result", tool_use_id: block.id, content: block.content, is_error: block.isError };
      })
    }))
    .filter((m) => m.content.length > 0);
}

const stopOf = (reason: string | null | undefined): StopReason =>
  reason === "tool_use" ? "tool_use" : reason === "max_tokens" ? "max_tokens" : reason === "refusal" ? "refusal" : "end";

/** Claude over the Messages API. No sampling params — current models refuse them; effort/thinking stay at their defaults. */
export class AnthropicModel implements ChatModel {
  capabilities = { tools: true, streaming: true, json: false };

  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) });
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const choice = request.toolChoice;
    const stream = await this.client.messages.create(
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
