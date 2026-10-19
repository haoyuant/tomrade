import { inputMimes, type ChatEvent, type ChatModel, type ChatRequest, type InputModality, type Message, type StopReason } from "./model.js";
import { LlmError, NativeSearchRefused } from "./errors.js";
import { fetchFailure, pause, sseData } from "./openai.js";

export interface GeminiConfig {
  apiKey: string;
  /** With or without the `models/` prefix the compatible endpoint lists. */
  model: string;
  /** Default https://generativelanguage.googleapis.com/v1beta. */
  baseURL?: string;
  inputModalities?: InputModality[];
  /** Whether the model searches Google on its own; by default Gemini 3 and later, the ones that combine it with function calling. */
  webSearch?: boolean;
  retries?: number;
  retryDelayMs?: number;
}

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const PROVIDER = "gemini";
/** Google Search beside function tools: Gemini 3 and 4. */
const SEARCHES = /^gemini-([3-9]|\d{2,})/;
const TRANSIENT = new Set([408, 500, 502, 503, 504]);
const LEVELS = new Set(["low", "medium", "high"]);

export const bareModel = (model: string) => model.replace(/^models\//, "");

type Step = { type: string; [key: string]: unknown };

/** A 429 that names a used-up or zero quota (a model the free tier does not include) will not pass by waiting; a plain rate limit will. */
const exhausted = (body: string) => /quota|billing|limit: 0\b/i.test(body);

/** Gemini's levels stop at low for some models; anything below asks for the least it takes everywhere. */
const levelOf = (effort?: string): string | undefined => (!effort ? undefined : LEVELS.has(effort) ? effort : /x?high|max/.test(effort) ? "high" : "low");

const contentOf = (block: Message["content"][number]): Record<string, unknown> | null => {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type !== "media") return null;
  const { mime, base64 } = block.media;
  const type = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "document";
  return { type, data: base64, mime_type: mime };
};

/**
 * The conversation as Interactions steps. A reply Gemini wrote goes back as the steps it streamed,
 * thoughts and signatures included, as stateless requests must; anyone else's as plain output and calls.
 */
export function toSteps(request: ChatRequest): Step[] {
  const out: Step[] = [];
  const names = new Map<string, string>();
  for (const message of request.messages) {
    if (message.role === "user") {
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const name = names.get(block.id);
        out.push({ type: "function_result", call_id: block.id, ...(name ? { name } : {}), result: [{ type: "text", text: block.content }], ...(block.isError ? { is_error: true } : {}) });
      }
      const content = message.content.map(contentOf).filter((c): c is Record<string, unknown> => !!c);
      if (content.length) out.push({ type: "user_input", content });
      continue;
    }
    for (const block of message.content) if (block.type === "tool_call") names.set(block.id, block.name);
    const native = message.content.find((b) => b.type === "native" && b.provider === PROVIDER);
    if (native?.type === "native") {
      out.push(...(native.data as Step[]));
      continue;
    }
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    if (text) out.push({ type: "model_output", content: [{ type: "text", text }] });
    for (const block of message.content) if (block.type === "tool_call") out.push({ type: "function_call", id: block.id, name: block.name, arguments: block.args ?? {} });
  }
  return out;
}

export function interactionBody(model: string, request: ChatRequest, search: boolean): Record<string, unknown> {
  const tools: Record<string, unknown>[] = (request.tools ?? []).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema }));
  if (search) tools.push({ type: "google_search" });
  const choice = request.toolChoice;
  const level = levelOf(request.effort);
  const config = {
    ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
    ...(level ? { thinking_level: level } : {}),
    ...(choice ? { tool_choice: typeof choice === "string" ? choice : { allowed_tools: { mode: "any", tools: [choice.name] } } } : {})
  };
  return {
    model: bareModel(model),
    store: false,
    stream: true,
    ...(request.system ? { system_instruction: request.system } : {}),
    input: toSteps(request),
    ...(tools.length ? { tools } : {}),
    ...(Object.keys(config).length ? { generation_config: config } : {}),
    ...(request.json ? { response_format: { type: "text", mime_type: "application/json" } } : {})
  };
}

interface StreamEvent {
  event_type?: string;
  index?: number;
  step?: Step;
  delta?: { type?: string; text?: string; arguments?: string; signature?: string; annotations?: { type?: string; url?: string; title?: string }[]; [key: string]: unknown };
  interaction?: {
    status?: string;
    usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number; total_cached_tokens?: number };
  };
  error?: { code?: string; message?: string };
}

/**
 * An Interactions stream as chat events: output text as it comes, a function call once its step
 * ends, the cited pages listed after the answer, and the steps themselves as native data so the
 * next request of the turn carries them back.
 */
export async function* readInteraction(data: AsyncIterable<string>): AsyncGenerator<ChatEvent> {
  const steps = new Map<number, Step>();
  const args = new Map<number, string>();
  const sources = new Map<string, string>();
  const cite = (list?: { type?: string; url?: string; title?: string }[]) => {
    for (const a of list ?? []) if (a.type === "url_citation" && a.url && !sources.has(a.url)) sources.set(a.url, a.title || a.url);
  };
  let stop: StopReason = "end";
  let calls = 0;
  for await (const raw of data) {
    if (raw === "[DONE]") break;
    let event: StreamEvent;
    try {
      event = JSON.parse(raw) as StreamEvent;
    } catch {
      continue;
    }
    const index = event.index ?? 0;
    if (event.event_type === "step.start" && event.step) {
      const step = { ...event.step };
      steps.set(index, step);
      if (step.type === "model_output") {
        for (const part of (step.content as { type?: string; text?: string; annotations?: [] }[] | undefined) ?? []) {
          if (part.type === "text" && part.text) yield { type: "text", delta: part.text };
          cite(part.annotations);
        }
      }
    } else if (event.event_type === "step.delta" && event.delta) {
      const step = steps.get(index);
      const delta = event.delta;
      if (!step) continue;
      if (delta.type === "text" && delta.text) {
        yield { type: "text", delta: delta.text };
        const content = ((step.content as { type: string; text: string }[] | undefined) ??= []);
        const last = content.at(-1);
        if (last?.type === "text") last.text += delta.text;
        else content.push({ type: "text", text: delta.text });
      } else if (delta.type === "arguments_delta") args.set(index, (args.get(index) ?? "") + (delta.arguments ?? ""));
      else if (delta.type === "thought_signature") step.signature = `${(step.signature as string | undefined) ?? ""}${delta.signature ?? ""}`;
      else if (delta.type === "text_annotation_delta") {
        cite(delta.annotations);
        const content = (step.content as { annotations?: unknown[] }[] | undefined)?.at(-1);
        if (content) content.annotations = [...(content.annotations ?? []), ...(delta.annotations ?? [])];
      } else if (delta.type === step.type) {
        // a built-in tool's call or result arrives whole in its delta
        const { type: _type, ...rest } = delta;
        Object.assign(step, rest);
      }
    } else if (event.event_type === "step.stop") {
      const step = steps.get(index);
      if (step?.type !== "function_call") continue;
      const raw = args.get(index);
      if (raw !== undefined) {
        try {
          step.arguments = raw ? JSON.parse(raw) : {};
        } catch {
          step.arguments = { __raw: raw };
        }
      }
      calls += 1;
      yield { type: "tool_call", id: (step.id as string | undefined) ?? `call_${calls}`, name: (step.name as string | undefined) ?? "", args: step.arguments ?? {} };
    } else if (event.event_type === "interaction.completed") {
      const status = event.interaction?.status;
      const u = event.interaction?.usage;
      if (u) {
        yield {
          type: "usage",
          inputTokens: u.total_input_tokens,
          // thinking is billed as output
          outputTokens: (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0),
          ...(u.total_cached_tokens ? { cacheReadTokens: u.total_cached_tokens } : {})
        };
      }
      if (status === "incomplete" || status === "budget_exceeded") stop = "max_tokens";
      else if (status === "failed") throw new LlmError("Gemini could not finish the reply (status failed)");
    } else if (event.event_type === "error") {
      throw new LlmError(`LLM request failed: ${event.error?.message ?? event.error?.code ?? "error event"}`);
    }
  }
  const written = [...steps.entries()].sort(([a], [b]) => a - b).map(([, step]) => step);
  if (written.length) yield { type: "native", provider: PROVIDER, data: written };
  if (sources.size) yield { type: "text", delta: "\n\n" + [...sources].map(([url, title]) => `- [${title.replace(/[[\]]/g, "")}](${url})`).join("\n") };
  yield { type: "stop", reason: calls > 0 && stop === "end" ? "tool_use" : stop };
}

/** Gemini on Google's Interactions API, stateless: each request carries the whole conversation. */
export class GeminiModel implements ChatModel {
  /** Google turned its search down for this key; later turns search through a plugin from the start. */
  private searchRefused = false;

  constructor(private readonly config: GeminiConfig) {}

  get capabilities() {
    return {
      tools: true,
      streaming: true,
      json: true,
      mediaInput: inputMimes(this.config.inputModalities ?? []),
      nativeWebSearch: !this.searchRefused && (this.config.webSearch ?? SEARCHES.test(bareModel(this.config.model)))
    };
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    for (const message of request.messages) for (const block of message.content) {
      if (block.type === "media" && !this.capabilities.mediaInput.includes(block.media.mime)) throw new LlmError(`This model profile does not accept ${block.media.mime}`);
    }
    const search = !!request.webSearch && this.capabilities.nativeWebSearch;
    const url = `${(this.config.baseURL || GEMINI_BASE).replace(/\/$/, "")}/interactions`;
    const body = JSON.stringify(interactionBody(this.config.model, request, search));
    const retries = this.config.retries ?? 2;
    const wait = (attempt: number) => (this.config.retryDelayMs ?? 1000) * 3 ** (attempt - 1);
    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers: { "x-goog-api-key": this.config.apiKey, "content-type": "application/json" }, body, signal });
      } catch (err) {
        if (signal?.aborted || attempt > retries) throw new LlmError(`LLM request failed: ${fetchFailure(err)}`, err);
        yield { type: "retry", attempt, max: retries, reason: fetchFailure(err), delayMs: wait(attempt) };
        await pause(wait(attempt), signal);
        continue;
      }
      if (res.ok && res.body) {
        yield* readInteraction(sseData(res.body));
        return;
      }
      const text = await res.text().catch(() => "");
      const limited = res.status === 429 && !exhausted(text);
      if ((TRANSIENT.has(res.status) || limited) && attempt <= retries) {
        const after = Number(res.headers.get("retry-after"));
        const delayMs = Number.isFinite(after) && after > 0 && after <= 20 ? after * 1000 : wait(attempt);
        yield { type: "retry", attempt, max: retries, reason: `HTTP ${res.status}`, delayMs };
        await pause(delayMs, signal);
        continue;
      }
      // Google Search is off for free-tier keys (a zero quota) and for some models: the caller searches another way.
      if (search && (res.status === 400 || res.status === 404 || (res.status === 429 && !limited))) {
        this.searchRefused = true;
        throw new NativeSearchRefused(`Gemini's Google Search was refused (${res.status}): ${text.slice(0, 300)}`);
      }
      // a zero limit is the model's tier, not spent credit: said in the words modelRefusal reads
      const why = res.status === 429 && !limited && /limit: ?0\b/.test(text) ? " (not available on your plan)" : "";
      throw new LlmError(`LLM request failed ${res.status}${why}: ${text.slice(0, 300)}`, undefined, { status: res.status, url: res.url || url, body: text.slice(0, 8000) });
    }
  }
}
