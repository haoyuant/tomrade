import { inputMimes, type InputModality, type MediaData, type ChatEvent, type ChatModel, type ChatRequest, type StopReason } from "./model.js";
import { LlmError, NativeSearchRefused } from "./errors.js";
import { fitsResponses, readResponses, responsesBody, searchesOnResponses } from "./responses.js";

export interface OpenAiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  inputModalities?: InputModality[];
  outputModalities?: ("image" | "audio")[];
  /** Tries after the first for a 429, a 5xx or a dropped connection, before any reply has streamed. Default 2. */
  retries?: number;
  /** The first wait between tries; each later one is three times longer. Default 1000. */
  retryDelayMs?: number;
  /** Whether the model searches the web on its own through the Responses API; by default OpenAI's current models and DeepSeek's v4-pro. */
  webSearch?: boolean;
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Record<string, unknown>[];
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
      const media = message.content.filter(b => b.type === "media");
      if (media.length) out.push({ role: "user", content: [
        ...(text ? [{ type: "text", text }] : []),
        ...media.map(({ media: m }) => {
          const url = `data:${m.mime};base64,${m.base64}`;
          if (m.mime.startsWith("image/")) return { type: "image_url", image_url: { url } };
          if (m.mime.startsWith("audio/")) return { type: "input_audio", input_audio: { data: m.base64, format: m.mime === "audio/mpeg" ? "mp3" : "wav" } };
          if (m.mime.startsWith("video/")) return { type: "video_url", video_url: { url } };
          return { type: "file", file: { filename: m.name, file_data: url } };
        })
      ] });
      else if (text) out.push({ role: "user", content: text });
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
  /** Cached input, by provider: OpenAI and OpenRouter `prompt_tokens_details.cached_tokens`, DeepSeek `prompt_cache_hit_tokens`, Kimi `cached_tokens`. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null; prompt_cache_hit_tokens?: number; cached_tokens?: number } | null;
  choices?: {
    finish_reason?: string | null;
    delta?: { content?: string | { type: string; text?: string; image_url?: { url: string } }[] | null; images?: { image_url: { url: string }; index?: number }[]; audio?: { data?: string; transcript?: string }; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
  }[];
}

/** Any chat/completions endpoint: DeepSeek, OpenAI, Kimi, OpenRouter, Ollama, vLLM, LM Studio… */
/** Statuses worth one more try: the request was fine, the moment was not. */
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

/** What a failed fetch says about itself: undici hides the socket error in `cause`. */
export const fetchFailure = (err: unknown): string => {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
};

export const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

export class OpenAiCompatible implements ChatModel {
  get capabilities() {
    return {
      tools: true,
      streaming: true,
      json: true,
      mediaInput: inputMimes(this.config.inputModalities ?? []),
      mediaOutput: this.config.outputModalities ?? [],
      nativeWebSearch: this.config.webSearch ?? searchesOnResponses(this.config.baseURL, this.config.model)
    };
  }

  /**
   * OpenAI's newer models take only `max_completion_tokens` and only the default
   * temperature; most other compatible endpoints still want `max_tokens`. OpenAI
   * gets the new name from the start, and any endpoint that refuses a parameter
   * this way is asked again without it, remembered for later requests. gpt-5.5
   * on chat/completions also refuses a reasoning effort beside function tools:
   * a step with tools then goes at the model's own effort.
   */
  private tokenField: "max_tokens" | "max_completion_tokens";
  private omitTemperature = false;
  private omitEffortWithTools = false;

  constructor(private readonly config: OpenAiConfig) {
    this.tokenField = /^https?:\/\/api\.openai\.com(\/|$)/i.test(config.baseURL) ? "max_completion_tokens" : "max_tokens";
  }

  /** Whether a 400 named a parameter this model will not take, now adjusted for. */
  private adjustTo(refusal: string): boolean {
    if (this.tokenField === "max_tokens" && /'max_tokens'[^"]*'max_completion_tokens'/.test(refusal)) {
      this.tokenField = "max_completion_tokens";
      return true;
    }
    if (!this.omitTemperature && /Unsupported (value|parameter): 'temperature'/.test(refusal)) {
      this.omitTemperature = true;
      return true;
    }
    if (!this.omitEffortWithTools && /Function tools with reasoning_effort are not supported/i.test(refusal)) {
      this.omitEffortWithTools = true;
      return true;
    }
    return false;
  }

  /**
   * One hiccup — a rate limit, an overloaded server, a dropped connection — no
   * longer ends a run twenty steps in: it is tried again, after Retry-After when
   * the server names one. Only before the reply streams, so nothing is said twice.
   */
  private async *post(url: string, init: RequestInit & { signal?: AbortSignal }): AsyncGenerator<ChatEvent, Response> {
    const retries = this.config.retries ?? 2;
    const wait = (attempt: number) => (this.config.retryDelayMs ?? 1000) * 3 ** (attempt - 1);
    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (init.signal?.aborted || attempt > retries) throw err;
        yield { type: "retry", attempt, max: retries, reason: fetchFailure(err), delayMs: wait(attempt) };
        await pause(wait(attempt), init.signal);
        continue;
      }
      if (!TRANSIENT.has(res.status) || attempt > retries) return res;
      const after = Number(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => {});
      const delayMs = Number.isFinite(after) && after > 0 && after <= 20 ? after * 1000 : wait(attempt);
      yield { type: "retry", attempt, max: retries, reason: `HTTP ${res.status}`, delayMs };
      await pause(delayMs, init.signal);
    }
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    for (const message of request.messages) for (const block of message.content) {
      if (block.type === "media" && !this.capabilities.mediaInput.includes(block.media.mime)) throw new LlmError(`This model profile does not accept ${block.media.mime}`);
    }
    // The model's own search lives on the Responses API; only a request that asks for it goes there.
    if (request.webSearch && this.capabilities.nativeWebSearch && fitsResponses(request)) {
      yield* this.respond(request, signal);
      return;
    }
    const messages = toMessages(request);
    const body = (): Record<string, unknown> => {
      const out: Record<string, unknown> = {
        model: this.config.model,
        stream: true,
        stream_options: { include_usage: true },
        messages
      };
      if (this.config.outputModalities?.length) out.modalities = ["text", ...this.config.outputModalities];
      if (this.config.outputModalities?.includes("audio")) out.audio = { voice: "alloy", format: "pcm16" };
      if (request.temperature !== undefined && !this.omitTemperature) out.temperature = request.temperature;
      if (request.maxTokens !== undefined) out[this.tokenField] = request.maxTokens;
      if (request.effort && !(this.omitEffortWithTools && request.tools?.length)) out.reasoning_effort = request.effort;
      if (request.tools?.length) {
        out.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
        const choice = request.toolChoice;
        if (choice) out.tool_choice = typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
      }
      if (request.json) out.response_format = { type: "json_object" };
      return out;
    };

    const url = this.config.baseURL.replace(/\/$/, "") + "/chat/completions";
    let res: Response;
    for (let adjusted = 0; ; adjusted += 1) {
      res = yield* this.post(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + this.config.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body()),
        signal
      });
      if (res.ok) break;
      const text = await res.text().catch(() => "");
      if (res.status === 400 && adjusted < 3 && this.adjustTo(text)) continue;
      const requestId = res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? undefined;
      throw new LlmError(`LLM request failed ${res.status}: ${text.slice(0, 300)}`, undefined, { status: res.status, url: res.url || url, ...(requestId ? { requestId } : {}), body: text.slice(0, 8000) });
    }
    if (!res.body) throw new LlmError("LLM response had no body");

    const calls = new Map<number, { id: string; name: string; args: string }>();
    const images = new Set<string>();
    const audio: Buffer[] = [];
    const image = (url: string): MediaData => {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(url);
      if (!match) throw new LlmError("Model returned an image without inline bytes; configure base64 image output");
      return { name: `image-${images.size}.${match[1].split("/")[1].replace("+xml", "")}`, mime: match[1], base64: match[2] };
    };
    let stop: StopReason = "end";
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        continue;
      }
      if (chunk.usage) {
        const u = chunk.usage;
        const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens;
        yield { type: "usage", inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, ...(cached != null ? { cacheReadTokens: cached } : {}) };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) yield { type: "text", delta: delta.content };
      const parts = Array.isArray(delta.content) ? delta.content : [];
      for (const part of parts) if (part.type === "text" && part.text) yield { type: "text", delta: part.text };
      for (const url of [...(delta.images ?? []).map(i => i.image_url.url), ...parts.filter(p => p.type === "image_url" && p.image_url).map(p => p.image_url!.url)]) {
        if (!images.has(url)) { images.add(url); yield { type: "media", media: image(url) }; }
      }
      if (delta.audio?.data) audio.push(Buffer.from(delta.audio.data, "base64"));
      if (delta.audio?.transcript) yield { type: "text", delta: delta.audio.transcript };
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
    if (audio.length) {
      const pcm = Buffer.concat(audio);
      const header = Buffer.alloc(44);
      header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
      header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
      header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
      header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
      yield { type: "media", media: { name: "response.wav", mime: "audio/wav", base64: Buffer.concat([header, pcm]).toString("base64") } };
    }
    yield { type: "stop", reason: stop };
  }

  private async *respond(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const url = this.config.baseURL.replace(/\/$/, "") + "/responses";
    const res = yield* this.post(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + this.config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(responsesBody(this.config.model, request)),
      signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // An endpoint, model or account without the search refuses it: the caller searches another way.
      if (res.status === 400 || res.status === 404 || res.status === 422) throw new NativeSearchRefused(`The model's web search was refused (${res.status}): ${text.slice(0, 300)}`);
      const requestId = res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? undefined;
      throw new LlmError(`LLM request failed ${res.status}: ${text.slice(0, 300)}`, undefined, { status: res.status, url: res.url || url, ...(requestId ? { requestId } : {}), body: text.slice(0, 8000) });
    }
    if (!res.body) throw new LlmError("LLM response had no body");
    yield* readResponses(sseData(res.body));
  }
}
