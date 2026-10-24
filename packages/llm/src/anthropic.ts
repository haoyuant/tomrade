import Anthropic from "@anthropic-ai/sdk";
import { inputMimes, type InputModality, type ChatEvent, type ChatModel, type ChatRequest, type Message, type StopReason } from "./model.js";
import { LlmError, MediaRefused, NativeSearchRefused, mediaRefusal } from "./errors.js";
import { fetchFailure, pause } from "./openai.js";
import { errorMessage } from "@tomradex/contracts";

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  inputModalities?: InputModality[];
  /** Whether the endpoint runs Claude's own web search; by default only Anthropic's API does, not a proxy. */
  webSearch?: boolean;
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "image" | "document"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

const PROVIDER = "anthropic";

/** A reply that searched is replayed as Anthropic wrote it, so the results and citations stay with it. */
const nativeOf = (message: Message): unknown[] | undefined => {
  const native = message.content.find((b) => b.type === "native" && b.provider === PROVIDER);
  return native?.type === "native" ? (native.data as unknown[]) : undefined;
};

function toMessages(request: ChatRequest): { role: "user" | "assistant"; content: unknown[] }[] {
  return request.messages
    .map((message) => ({
      role: message.role,
      content: nativeOf(message) ?? message.content.flatMap((block): AnthropicContent[] => {
        if (block.type === "native") return [];
        if (block.type === "text") return [{ type: "text", text: block.text }];
        if (block.type === "media") return [{ type: block.media.mime === "application/pdf" ? "document" : "image", source: { type: "base64", media_type: block.media.mime, data: block.media.base64 } }];
        if (block.type === "tool_call") return [{ type: "tool_use", id: block.id, name: block.name, input: block.args ?? {} }];
        return [{ type: "tool_result", tool_use_id: block.id, content: block.content, is_error: block.isError }];
      })
    }))
    .filter((m) => m.content.length > 0);
}

/** The last message's last block carries a cache breakpoint: everything before it is the prefix the next request reuses. */
function markedLast(messages: unknown[]): unknown[] {
  const last = messages[messages.length - 1] as { role: string; content: unknown } | undefined;
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return messages;
  const content = [...(last.content as Record<string, unknown>[])];
  const block = content[content.length - 1]!;
  if (block.type !== "text" && block.type !== "tool_result" && block.type !== "tool_use" && block.type !== "image" && block.type !== "document") return messages;
  content[content.length - 1] = { ...block, cache_control: { type: "ephemeral" } };
  return [...messages.slice(0, -1), { ...last, content }];
}

const FIRST_PARTY = /^https?:\/\/api\.anthropic\.com(\/|$)/i;
/** Dynamic filtering needs Opus or Sonnet 4.6 or later; other models get the basic search. */
const FILTERING = /^claude-(opus|sonnet)-(4-[6-9]|[5-9])/;
const searchTool = (model: string) => ({ type: FILTERING.test(model) ? "web_search_20260209" : "web_search_20250305", name: "web_search" });
/** A long server-side search pauses the turn; each pause is resumed, up to this many. */
const CONTINUATIONS = 5;

const RETRIES = 2;
const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const stopOf = (reason: string | null | undefined): StopReason =>
  reason === "tool_use" ? "tool_use" : reason === "max_tokens" ? "max_tokens" : reason === "refusal" ? "refusal" : "end";

/** Claude over the Messages API. No sampling params — current models refuse them; effort/thinking stay at their defaults. */
export class AnthropicModel implements ChatModel {
  get capabilities() {
    return {
      tools: true,
      streaming: true,
      json: false,
      mediaInput: inputMimes(this.config.inputModalities ?? ["image", "pdf"]).filter(mime => mime.startsWith("image/") || mime === "application/pdf"),
      nativeWebSearch: this.config.webSearch ?? (!this.config.baseURL || FIRST_PARTY.test(this.config.baseURL))
    };
  }

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
    const search = !!request.webSearch && this.capabilities.nativeWebSearch;
    const tools: unknown[] = [
      ...(request.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      ...(search ? [searchTool(this.config.model)] : [])
    ];
    const send = (messages: unknown[]) => this.client.messages.create(
      {
        model: this.config.model,
        max_tokens: request.maxTokens ?? 16000,
        stream: true,
        // The cached prefix is the stable system text; what changes between turns follows it uncached,
        // and the last message is marked too, so the conversation so far is read from the cache next turn.
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }, ...(request.systemTail ? [{ type: "text" as const, text: request.systemTail }] : [])],
        messages: markedLast(messages) as Anthropic.MessageParam[],
        ...(tools.length
          ? {
              tools: tools as Anthropic.ToolUnion[],
              ...(choice ? { tool_choice: typeof choice === "string" ? { type: choice } : { type: "tool", name: choice.name } } : {})
            }
          : {})
      },
      { signal }
    );

    let messages: unknown[] = toMessages(request);
    // What Claude wrote across every pause, as Anthropic wrote it; thinking left out, as before.
    const written: Record<string, unknown>[] = [];
    const sources = new Map<string, string>();
    let stop: StopReason = "end";
    for (let round = 0; ; round += 1) {
      let stream!: Awaited<ReturnType<typeof send>>;
      for (let attempt = 1; ; attempt += 1) {
        try {
          stream = await send(messages);
          break;
        } catch (err) {
          const kinds = err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError ? mediaRefusal(err.status, err.message, request) : null;
          if (kinds) throw new MediaRefused(`Claude refused ${kinds.join(", ")} input: ${errorMessage(err)}`, kinds, err);
          if (search && err instanceof Anthropic.BadRequestError) throw new NativeSearchRefused(`Claude's web search was refused: ${err.message}`, err);
          const status = err instanceof Anthropic.APIError ? err.status : undefined;
          const transient = err instanceof Anthropic.APIConnectionError || (status !== undefined && TRANSIENT.has(status));
          if (signal?.aborted || !transient || attempt > RETRIES) throw err;
          const after = Number((err as { headers?: Headers }).headers?.get?.("retry-after"));
          const delayMs = Number.isFinite(after) && after > 0 && after <= 20 ? after * 1000 : 1000 * 3 ** (attempt - 1);
          yield { type: "retry", attempt, max: RETRIES, reason: status ? `HTTP ${status}` : fetchFailure(err), delayMs };
          await pause(delayMs, signal);
        }
      }

      const blocks = new Map<number, { block: Record<string, unknown>; json: string }>();
      let paused = false;
      for await (const event of stream) {
        if (event.type === "message_start") {
          // Anthropic's input_tokens leaves out what the cache read and wrote; the other adapters' input counts all of it.
          const { input_tokens, cache_read_input_tokens: read, cache_creation_input_tokens: write } = event.message.usage;
          yield {
            type: "usage",
            inputTokens: input_tokens + (read ?? 0) + (write ?? 0),
            ...(read != null ? { cacheReadTokens: read } : {}),
            ...(write != null ? { cacheWriteTokens: write } : {})
          };
        } else if (event.type === "content_block_start") {
          const kind = event.content_block.type;
          if (kind !== "thinking" && kind !== "redacted_thinking") blocks.set(event.index, { block: { ...event.content_block }, json: "" });
        } else if (event.type === "content_block_delta") {
          const open = blocks.get(event.index);
          if (event.delta.type === "text_delta") {
            if (open) open.block.text = String(open.block.text ?? "") + event.delta.text;
            yield { type: "text", delta: event.delta.text };
          } else if (event.delta.type === "input_json_delta" && open) open.json += event.delta.partial_json;
          else if (event.delta.type === "citations_delta" && open) {
            const citation = event.delta.citation;
            open.block.citations = [...((open.block.citations as unknown[] | null) ?? []), citation];
            if (citation.type === "web_search_result_location" && !sources.has(citation.url)) sources.set(citation.url, citation.title || citation.url);
          }
        } else if (event.type === "content_block_stop") {
          const open = blocks.get(event.index);
          if (!open) continue;
          blocks.delete(event.index);
          if (open.block.type === "tool_use" || open.block.type === "server_tool_use") {
            let args: unknown = {};
            try {
              args = open.json ? JSON.parse(open.json) : {};
            } catch {
              args = { __raw: open.json };
            }
            open.block.input = args;
            if (open.block.type === "tool_use") yield { type: "tool_call", id: String(open.block.id), name: String(open.block.name), args };
          }
          written.push(open.block);
        } else if (event.type === "message_delta") {
          yield { type: "usage", outputTokens: event.usage.output_tokens };
          paused = event.delta.stop_reason === "pause_turn";
          stop = stopOf(event.delta.stop_reason);
        }
      }
      if (!paused || round >= CONTINUATIONS) break;
      // Resumed by sending back what it wrote so far; the server sees its own unfinished search and goes on.
      messages = [...toMessages(request), { role: "assistant", content: written }];
    }
    if (sources.size) yield { type: "text", delta: "\n\n" + [...sources].map(([url, title]) => `- [${title.replace(/[[\]]/g, "")}](${url})`).join("\n") };
    if (written.some((b) => b.type === "server_tool_use")) yield { type: "native", provider: PROVIDER, data: written };
    yield { type: "stop", reason: stop };
  }
}
