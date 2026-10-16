import { Context, Service } from "cordis";
import { z } from "zod";
import { modelErrorKind, type ModelErrorKind } from "@tomradex/domain";
import type {} from "@tomradex/ipc";
import type { SettingsSection } from "@tomradex/settings";
import { AnthropicModel } from "./anthropic.js";
import { ImagesModel } from "./images.js";
export { ImagesModel } from "./images.js";
import { LlmError } from "./errors.js";
import { assistantMessage, collect, userMessage, type ChatEvent, type ChatModel, type ChatRequest, type Collected, type LlmRole, type Message } from "./model.js";
import { OpenAiCompatible } from "./openai.js";
import { withPromptTools } from "./prompt-tools.js";
import { guessProviders, keyHint, listModels, pickModel, PROVIDERS, usableModels, type ModelListing, type QuickSetupResult } from "./providers.js";

export * from "./model.js";
export { PROVIDERS, guessProviders, keyHint, listModels, pickModel, usableModels, type ModelListing, type ProviderPreset, type QuickSetupResult } from "./providers.js";
export { LlmError, type LlmErrorResponse } from "./errors.js";
export { OpenAiCompatible, type OpenAiConfig } from "./openai.js";
export { AnthropicModel, type AnthropicConfig } from "./anthropic.js";
export { withPromptTools } from "./prompt-tools.js";

export interface CompletionRequest {
  system: string;
  user: string;
  temperature?: number;
  /** Absent, 8000: room for a long document. */
  maxTokens?: number;
  /** Ends the request; a caller that cannot wait long passes AbortSignal.timeout(…). */
  signal?: AbortSignal;
  /** The whole call, repair round included, ends after this long. Absent, only silence ends it (COMPLETION_IDLE_MS, or UNSTREAMED_ANSWER_MS for a model that does not stream). */
  timeoutMs?: number;
  /** False skips the repair round: a caller with a fallback takes it rather than a second request. */
  repair?: boolean;
}

/** A model that sends nothing for this long has stopped answering; a long document still streaming is never cut. */
export const COMPLETION_IDLE_MS = 90_000;

/**
 * A model that does not stream (a signed-in CLI) sends nothing until its whole
 * answer is ready, so silence means nothing until this long has passed.
 */
export const UNSTREAMED_ANSWER_MS = 10 * 60_000;

/** The structured seam: one JSON document matching a schema. Kept from v1; compound tools live on it. */
export interface LLMProvider {
  completeJson<T>(schema: z.ZodType<T>, request: CompletionRequest): Promise<T>;
}

/** One tiny request with a profile: whether it answers, and if not, which part to fix. */
export type ModelTest = { ok: true } | { ok: false; kind: ModelErrorKind; detail: string };

/** One token from `model`, or why not. A timeout reads as the address, not the key. */
export async function probe(model: ChatModel, timeoutMs = 20_000): Promise<ModelTest> {
  try {
    // a retry is not an answer: the request it announces may still fail
    for await (const event of model.chat({ system: "Reply with one word.", messages: [userMessage("ping")], maxTokens: 1 }, AbortSignal.timeout(timeoutMs))) if (event.type !== "retry") break;
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: err instanceof Error && err.name === "TimeoutError" ? "network" : modelErrorKind(detail), detail };
  }
}

export interface LlmStatus {
  ok: boolean;
  reason?: string;
  profile?: { id: string; title: string; provider: string; model: string };
}

/**
 * A model another plugin answers one-shot prompts with — a local agent the
 * person is signed in to. It stands in for the worker role only while no
 * profile is configured, so planning works with a subscription and no API key.
 */
export interface LentModel {
  id: string;
  title: string;
  /** Whether it can answer now; asked before each call, so keep it cached. */
  ready(): Promise<boolean>;
  model: ChatModel;
}

/** A provider as the quick setup offers it, in the person's language and order. */
export interface ProviderView {
  id: string;
  title: string;
  hint: string;
  keyPage?: string;
  local?: boolean;
}

/** A model found on this computer: a key in the environment, or a local server answering. */
export interface DetectedModel {
  id: string;
  preset: string;
  source: "env" | "local";
  /** The variable and a masked key, or the models a local server has. */
  detail: string;
}

/** `roles.worker` naming a lent model rather than a profile: `lent:<id>`. */
export const LENT_WORKER = "lent:";

/** A lent model as Settings offers it for the worker role. */
export interface LenderView {
  id: string;
  title: string;
  ready: boolean;
}

/** Lent calls start local processes; past this many at once, the rest wait their turn. */
export const LENT_CONCURRENCY = 2;

/** Who answers worker calls (planning, duplicate checks): a profile, a lent model, or nobody yet. */
export interface WorkerStatus {
  ok: boolean;
  via?: "profile" | "lent";
  title?: string;
  reason?: string;
}

/**
 * The model seam. An engine picks its own profile per thread (falling back to
 * the first configured one); `worker` is what compound tools and workflow
 * steps generate content with — often cheaper.
 */
export interface LlmService extends LLMProvider {
  for(role: LlmRole): ChatModel;
  /** A specific profile by id, regardless of role bindings. Throws on an unknown id. */
  forProfile(id: string): ChatModel;
  /** Whether the first configured profile is usable — what an engine without its own pick falls back to. */
  ready(): LlmStatus;
  /** The configured profiles, for pickers. */
  profiles(): { id: string; title: string }[];
  /** Ask the profile's endpoint for one token — a wrong key or address shows when it is saved, not in the first conversation. */
  test(profile: ModelProfile): Promise<ModelTest>;
  /** The models an endpoint lists that a profile of its kind can use. */
  listing(endpoint: Pick<ModelProfile, "provider" | "baseURL" | "apiKey">): Promise<ModelListing>;
  /** Offer a model for worker calls while no profile is configured; returns the withdrawal. */
  lend(model: LentModel): () => void;
  worker(): Promise<WorkerStatus>;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "llm.test": (profile: ModelProfile) => ModelTest;
    "llm.models": (endpoint: Pick<ModelProfile, "provider" | "baseURL" | "apiKey">) => ModelListing;
    "llm.worker": () => WorkerStatus;
    "llm.lenders": () => LenderView[];
    "llm.providers": () => ProviderView[];
    "llm.guess": (key: string) => string[];
    "llm.detect": () => DetectedModel[];
    "llm.quickSetup": (input: { preset: string; apiKey?: string }) => QuickSetupResult;
    "llm.adopt": (id: string) => QuickSetupResult;
  }
}

declare module "cordis" {
  interface Context {
    llm: LlmService;
  }
}

export const modelProfileSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(""),
  provider: z.enum(["openai-compatible", "anthropic", "openai-images"]),
  baseURL: z.string().optional(),
  apiKey: z.string().default(""),
  model: z.string().min(1),
  /** Render tools into the prompt for a model without native tool calling. Degraded. */
  promptTools: z.boolean().optional(),
  inputModalities: z.array(z.enum(["image", "audio", "video", "pdf"])).optional(),
  outputModalities: z.array(z.enum(["image", "audio"])).max(1).optional()
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export interface ModelsSettings {
  profiles: ModelProfile[];
  /** worker: "" picks for itself (the first profile, else a ready lent model), a profile id, or `lent:<id>`. */
  roles: { worker: string };
}

export const MODELS_SECTION: SettingsSection<ModelsSettings> = {
  id: "models",
  title: "Models",
  description: "Model profiles. Each engine picks its own per thread, in Engines below; the worker role generates content inside tools and can be cheaper.",
  schema: z.object({
    profiles: z.array(modelProfileSchema).default([]),
    roles: z.object({ worker: z.string().default("") }).default({ worker: "" })
  }),
  defaults: { profiles: [], roles: { worker: "" } },
  order: 10
};

const parseCandidates = (content: string): string[] => [content, content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")];

/** The output as `schema`, or the one problem worth telling the model (and then the person) about. */
function fit<T>(schema: z.ZodType<T>, content: string): { ok: true; value: T } | { ok: false; problem: string } {
  let problem = "it is not valid JSON";
  for (const candidate of parseCandidates(content)) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return { ok: true, value: parsed.data };
    const issue = parsed.error.issues[0];
    problem = `${issue.path.length ? issue.path.join(".") : "the document"}: ${issue.message}`;
  }
  return { ok: false, problem };
}

/**
 * One JSON document matching `schema`. Output that does not fit gets one repair
 * round with the problem quoted back; output that still does not fit is refused
 * naming `label` and the field, because the model answering here is the worker,
 * not whichever engine runs the conversation.
 */
export async function completeJson<T>(model: ChatModel, schema: z.ZodType<T>, request: CompletionRequest, label = "The worker model"): Promise<T> {
  const messages: Message[] = [userMessage(request.user)];
  const deadline = request.timeoutMs !== undefined ? AbortSignal.timeout(request.timeoutMs) : undefined;
  let problem = "";
  const maxTokens = request.maxTokens ?? 8000;
  for (let attempt = 0; attempt < (request.repair === false ? 1 : 2); attempt += 1) {
    const out = await collectWithin(
      (signal) => model.chat({ system: request.system, messages, json: model.capabilities.json, temperature: request.temperature ?? 0.2, maxTokens }, signal),
      { label, signal: request.signal, deadline, timeoutMs: request.timeoutMs, streaming: model.capabilities.streaming }
    );
    // A model that reasons before it answers can spend the whole limit thinking.
    if (!out.text && out.stop === "max_tokens") throw new LlmError(`${label} used its whole output limit (${maxTokens} tokens) before answering — a model that reasons first can spend it all thinking`);
    if (!out.text) throw new LlmError(`${label} returned no content`);
    const result = fit(schema, out.text.trim());
    if (result.ok) return result.value;
    problem = out.stop === "max_tokens" ? "it was cut off at the output limit" : result.problem;
    messages.push(assistantMessage({ text: out.text, toolCalls: [] }), userMessage(`That reply does not fit the required JSON shape (${problem}). Reply with the corrected JSON document only.`));
  }
  throw new LlmError(`${label} returned output that failed schema validation — ${problem}`);
}

/**
 * Collect one reply, ending it when the caller withdraws, the deadline passes, or the model goes
 * silent — for one that does not stream, stays silent past UNSTREAMED_ANSWER_MS. Settles on abort
 * even when the model ignores its signal, so no caller waits on a hang.
 */
async function collectWithin(
  open: (signal: AbortSignal) => AsyncIterable<ChatEvent>,
  opts: { label: string; signal?: AbortSignal; deadline?: AbortSignal; timeoutMs?: number; streaming: boolean }
): Promise<Collected> {
  const quietMs = opts.streaming ? COMPLETION_IDLE_MS : UNSTREAMED_ANSWER_MS;
  const idle = new AbortController();
  const signal = AbortSignal.any([idle.signal, ...(opts.signal ? [opts.signal] : []), ...(opts.deadline ? [opts.deadline] : [])]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), quietMs);
  };
  const why = (): unknown =>
    idle.signal.aborted ? new LlmError(opts.streaming ? `${opts.label} sent nothing for ${quietMs / 1000}s` : `${opts.label} did not answer within ${quietMs / 60_000} minutes`)
    : opts.deadline?.aborted ? new LlmError(`${opts.label} did not answer within ${(opts.timeoutMs ?? 0) / 1000}s`)
    : opts.signal?.reason ?? new LlmError(`${opts.label} request was cancelled`);
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(why());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  async function* touching(events: AsyncIterable<ChatEvent>): AsyncIterable<ChatEvent> {
    for await (const event of events) {
      touch();
      yield event;
    }
  }
  touch();
  try {
    return await Promise.race([collect(touching(open(signal))), aborted]);
  } catch (error) {
    throw signal.aborted ? why() : error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** ctx.llm: profiles + roles from settings, adapters cached until settings change. */
export class Llm extends Service implements LlmService {
  static provide = "llm";
  static inject = ["settings"];

  private cache = new Map<string, ChatModel>();
  private lent: LentModel[] = [];
  private lentRunning = 0;
  private lentWaiting: (() => void)[] = [];

  constructor(ctx: Context) {
    super(ctx, "llm");
  }

  [Service.init]() {
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("llm.test", (profile) => ctx.llm.test(profile));
      ctx.ipc.handle("llm.models", (endpoint) => ctx.llm.listing(endpoint));
      ctx.ipc.handle("llm.worker", () => ctx.llm.worker());
      ctx.ipc.handle("llm.lenders", () => this.lenders());
      ctx.ipc.handle("llm.providers", () => this.providers());
      ctx.ipc.handle("llm.guess", (key) => guessProviders(key));
      ctx.ipc.handle("llm.detect", () => this.detect());
      ctx.ipc.handle("llm.quickSetup", (input) => this.quickSetup(input));
      ctx.ipc.handle("llm.adopt", (id) => this.adopt(id));
    });
    this.ctx.settings.register(MODELS_SECTION);
    this.migrateLegacy();
    this.ctx.on("settings/changed", () => this.cache.clear());
  }

  private models(): ModelsSettings {
    return (this.ctx.settings.get().models as ModelsSettings | undefined) ?? MODELS_SECTION.defaults;
  }

  private profileFor(role: LlmRole): ModelProfile | undefined {
    const { profiles, roles } = this.models();
    return profiles.find((p) => p.id === roles[role]) ?? profiles[0];
  }

  ready(): LlmStatus {
    const profile = this.models().profiles[0];
    const zh = this.ctx.settings.locale?.() === "zh";
    if (!profile) return { ok: false, reason: zh ? "还没有配置模型——去 设置 → 助手 里添加一个" : "No model profile configured — add one in Settings → Assistant" };
    // A local endpoint (Ollama, LM Studio) needs no key; Anthropic always does.
    if (profile.provider === "anthropic" && !profile.apiKey) return { ok: false, reason: zh ? `配置“${profile.title || profile.id}”没有 API Key` : `Profile "${profile.title || profile.id}" has no API key` };
    return { ok: true, profile: { id: profile.id, title: profile.title || profile.model, provider: profile.provider, model: profile.model } };
  }

  for(role: LlmRole): ChatModel {
    const profile = this.profileFor(role);
    if (!profile) throw new LlmError("No model profile configured — add one in Settings → Assistant");
    return this.adapterOf(profile);
  }

  forProfile(id: string): ChatModel {
    const profile = this.models().profiles.find((p) => p.id === id);
    if (!profile) throw new LlmError(`Unknown model profile "${id}" — pick another in the panel or Settings → Assistant`);
    return this.adapterOf(profile);
  }

  profiles(): { id: string; title: string }[] {
    return this.models().profiles.map((p) => ({ id: p.id, title: p.title || p.model }));
  }

  async test(input: ModelProfile): Promise<ModelTest> {
    const profile = modelProfileSchema.parse(input);
    // an image endpoint has no one-token request; it shows its worth on the first picture
    if (profile.provider === "openai-images") return { ok: true };
    return probe(this.build(profile));
  }

  /** What the endpoint lists, for the profile form's model picker. A listing-less endpoint is an empty list, not an error. */
  async listing(endpoint: Pick<ModelProfile, "provider" | "baseURL" | "apiKey">): Promise<ModelListing> {
    // the same defaults build() talks to
    const baseURL = endpoint.baseURL || { anthropic: "", "openai-images": "https://api.openai.com/v1", "openai-compatible": "https://api.deepseek.com" }[endpoint.provider];
    const result = await listModels({ provider: endpoint.provider === "anthropic" ? "anthropic" : "openai-compatible", baseURL }, endpoint.apiKey.trim());
    if (!result.ok) return { ok: false, kind: modelErrorKind(result.detail), detail: result.detail };
    return { ok: true, models: usableModels(endpoint.provider, result.models ?? []) };
  }

  private adapterOf(profile: ModelProfile): ChatModel {
    const key = JSON.stringify(profile);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const model = this.build(profile);
    this.cache.set(key, model);
    return model;
  }

  private build(profile: ModelProfile): ChatModel {
    const base: ChatModel =
      profile.provider === "openai-images"
        ? new ImagesModel({ baseURL: profile.baseURL ?? "https://api.openai.com/v1", apiKey: profile.apiKey, model: profile.model })
        : profile.provider === "anthropic"
        ? new AnthropicModel({ apiKey: profile.apiKey, model: profile.model, baseURL: profile.baseURL, inputModalities: profile.inputModalities })
        : new OpenAiCompatible({ baseURL: profile.baseURL ?? "https://api.deepseek.com", apiKey: profile.apiKey, model: profile.model, inputModalities: profile.inputModalities, outputModalities: profile.outputModalities });
    return profile.promptTools && profile.provider !== "openai-images" ? withPromptTools({ capabilities: { ...base.capabilities, tools: false }, chat: (r, s) => base.chat(r, s) }) : base;
  }

  async completeJson<T>(schema: z.ZodType<T>, request: CompletionRequest): Promise<T> {
    const source = await this.workerSource();
    if (source.kind === "lent") {
      const lent = source.lent;
      return this.lentSlot(() => completeJson(lent.model, schema, request, `${lent.title} (signed in on this computer)`), request.signal);
    }
    if (source.kind === "none" && source.chosen) throw new LlmError(source.reason);
    const profile = source.kind === "profile" ? source.profile : undefined;
    const label = profile ? `Worker model ${profile.title || profile.model} (${profile.model}, Settings → Assistant)` : undefined;
    return completeJson(this.for("worker"), schema, request, label);
  }

  /**
   * Who answers worker calls. A lent model the person chose is never swapped for
   * another source behind their back: when it is not ready, the call says why.
   */
  private async workerSource(): Promise<{ kind: "profile"; profile: ModelProfile } | { kind: "lent"; lent: LentModel } | { kind: "none"; reason: string; chosen: boolean }> {
    const chosen = this.models().roles.worker;
    if (chosen.startsWith(LENT_WORKER)) {
      const id = chosen.slice(LENT_WORKER.length);
      const lent = this.lent.find((m) => m.id === id);
      if (lent && (await lent.ready().catch(() => false))) return { kind: "lent", lent };
      const zh = this.zh();
      const name = lent?.title ?? id;
      return { kind: "none", chosen: true, reason: zh ? `执行模型选的是 ${name}，但它现在用不了——先登录它，或在 设置 → 助手 里换一个` : `The worker is set to ${name}, which cannot answer right now — sign it in, or pick another in Settings → Assistant` };
    }
    const profile = this.profileFor("worker");
    if (profile) return { kind: "profile", profile };
    const lent = await this.readyLent();
    if (lent) return { kind: "lent", lent };
    return { kind: "none", chosen: false, reason: this.ready().reason ?? "" };
  }

  /** Runs `call` once fewer than LENT_CONCURRENCY lent calls are running; withdrawing while queued leaves the queue. */
  private async lentSlot<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    while (this.lentRunning >= LENT_CONCURRENCY) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener("abort", stop);
          resolve();
        };
        const stop = () => {
          this.lentWaiting = this.lentWaiting.filter((w) => w !== go);
          reject(signal?.reason ?? new LlmError("The worker request was cancelled"));
        };
        this.lentWaiting.push(go);
        signal?.addEventListener("abort", stop, { once: true });
      });
    }
    this.lentRunning += 1;
    try {
      return await call();
    } finally {
      this.lentRunning -= 1;
      this.lentWaiting.shift()?.();
    }
  }

  async lenders(): Promise<LenderView[]> {
    return Promise.all(this.lent.map(async (m) => ({ id: m.id, title: m.title, ready: await m.ready().catch(() => false) })));
  }

  lend(model: LentModel): () => void {
    this.lent.push(model);
    return () => {
      this.lent = this.lent.filter((m) => m !== model);
    };
  }

  async worker(): Promise<WorkerStatus> {
    const source = await this.workerSource();
    if (source.kind === "profile") return { ok: true, via: "profile", title: source.profile.title || source.profile.model };
    if (source.kind === "lent") return { ok: true, via: "lent", title: source.lent.title };
    return { ok: false, reason: source.reason };
  }

  private zh(): boolean {
    return this.ctx.settings.locale?.() === "zh";
  }

  providers(): ProviderView[] {
    const zh = this.zh();
    // Reachable from mainland China first for a Chinese reader; the paid global APIs first otherwise.
    const order = zh ? ["deepseek", "kimi", "anthropic", "openai", "openrouter", "ollama"] : ["anthropic", "openai", "deepseek", "openrouter", "kimi", "ollama"];
    return [...PROVIDERS]
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      .map((p) => ({ id: p.id, title: p.title, hint: zh ? p.hint.zh : p.hint.en, ...(p.keyPage ? { keyPage: p.keyPage } : {}), ...(p.local ? { local: true } : {}) }));
  }

  /** Keys exported in the person's shell and local servers, minus what a profile already uses. */
  async detect(): Promise<DetectedModel[]> {
    const profiles = this.models().profiles;
    const found: DetectedModel[] = [];
    for (const preset of PROVIDERS) {
      if (preset.env) {
        const key = process.env[preset.env]?.trim();
        if (key && !profiles.some((p) => p.apiKey === key)) found.push({ id: `env:${preset.env}`, preset: preset.id, source: "env", detail: `${preset.env} · ${keyHint(key)}` });
      }
      if (preset.local && !profiles.some((p) => p.baseURL === preset.baseURL)) {
        const listing = await listModels(preset, "", 800);
        if (listing.ok && listing.models?.length) found.push({ id: `local:${preset.id}`, preset: preset.id, source: "local", detail: listing.models.slice(0, 3).join(", ") });
      }
    }
    return found;
  }

  adopt(id: string): Promise<QuickSetupResult> {
    const [source, name] = id.split(":");
    if (source === "local") return this.quickSetup({ preset: name });
    const preset = PROVIDERS.find((p) => p.env === name);
    if (source !== "env" || !preset) throw new Error(`Nothing detected as ${id}`);
    return this.quickSetup({ preset: preset.id, apiKey: process.env[name] ?? "" });
  }

  /**
   * One key to a working profile: the provider's listing checks the key and
   * names a model, one token checks the model, and the profile goes first so
   * every engine uses it. A profile on the same endpoint takes the new key.
   */
  async quickSetup(input: { preset: string; apiKey?: string }): Promise<QuickSetupResult> {
    const preset = PROVIDERS.find((p) => p.id === input.preset);
    if (!preset) throw new Error(`Unknown provider ${input.preset}`);
    const apiKey = input.apiKey?.trim() ?? "";
    if (!preset.local && !apiKey) return { ok: false, kind: "auth", detail: "no API key" };
    const listing = await listModels(preset, apiKey);
    if (!listing.ok) return { ok: false, kind: modelErrorKind(listing.detail), detail: listing.detail };
    const model = pickModel(preset, listing.models);
    if (!model) return { ok: false, kind: "model", detail: `${preset.title} lists no model to use` };
    const models = this.models();
    const same = models.profiles.find((p) => p.provider === preset.provider && (p.baseURL || "") === preset.baseURL);
    const taken = new Set(models.profiles.map((p) => p.id));
    let id = same?.id ?? preset.id;
    for (let n = 2; !same && taken.has(id); n += 1) id = `${preset.id}-${n}`;
    const profile: ModelProfile = { ...same, id, title: same?.title || preset.title, provider: preset.provider, ...(preset.baseURL ? { baseURL: preset.baseURL } : {}), apiKey, model };
    const test = await this.test(profile);
    if (!test.ok && test.kind !== "rate") return test;
    const all = this.ctx.settings.get();
    this.ctx.settings.set({ ...all, models: { ...models, profiles: [profile, ...models.profiles.filter((p) => p !== same)] } });
    return { ok: true, profile: { id, title: profile.title, model } };
  }

  private async readyLent(): Promise<LentModel | undefined> {
    for (const model of this.lent) if (await model.ready().catch(() => false)) return model;
    return undefined;
  }

  /** A v1 `llm` section with a key becomes the first profile, bound to both roles. */
  private migrateLegacy(): void {
    const all = this.ctx.settings.get();
    const models = all.models as ModelsSettings | undefined;
    const legacy = all.llm as { apiKey?: string; baseURL?: string; model?: string } | undefined;
    if (models?.profiles?.length || !legacy?.apiKey || !legacy.model) return;
    this.ctx.settings.set({
      ...all,
      models: {
        profiles: [{ id: "default", title: legacy.model, provider: "openai-compatible", baseURL: legacy.baseURL ?? "https://api.deepseek.com", apiKey: legacy.apiKey, model: legacy.model }],
        roles: { worker: "default" }
      }
    });
  }
}

/** Deterministic provider for tests and offline demos: structured calls only. */
export class FakeLlm implements LlmService {
  constructor(private readonly respond: (system: string, user: string) => unknown) {}

  async completeJson<T>(schema: z.ZodType<T>, request: CompletionRequest): Promise<T> {
    return schema.parse(this.respond(request.system, request.user));
  }

  for(): ChatModel {
    throw new LlmError("FakeLlm has no chat model; use fakeChat() in tests that run an engine");
  }

  forProfile(): ChatModel {
    throw new LlmError("FakeLlm has no chat model; use fakeChat() in tests that run an engine");
  }

  async test(): Promise<ModelTest> {
    return { ok: true };
  }

  async listing(): Promise<ModelListing> {
    return { ok: true, models: [] };
  }

  profiles(): { id: string; title: string }[] {
    return [];
  }

  ready(): LlmStatus {
    return { ok: false, reason: "FakeLlm answers completeJson only" };
  }

  lend(): () => void {
    return () => {};
  }

  async worker(): Promise<WorkerStatus> {
    return { ok: true, via: "profile", title: "fake" };
  }
}

/** A plugin that provides ctx.llm from a FakeLlm — the seam, swapped. */
export const fakeLlm = (respond: (system: string, user: string) => unknown) => ({
  name: "fake-llm",
  apply(ctx: Context) {
    ctx.provide("llm", new FakeLlm(respond));
  }
});

export interface FakeTurn {
  text?: string;
  toolCalls?: { name: string; args: unknown; id?: string }[];
}

/** Scripted ChatModel: each chat() call plays the next turn and records the request. */
export class FakeChatModel implements ChatModel {
  capabilities = { tools: true, streaming: true, json: true };
  requests: ChatRequest[] = [];
  private step = 0;

  constructor(private readonly turns: FakeTurn[] | ((request: ChatRequest, step: number) => FakeTurn)) {}

  async *chat(request: ChatRequest) {
    this.requests.push(request);
    const turn = typeof this.turns === "function" ? this.turns(request, this.step) : (this.turns[this.step] ?? { text: "(script exhausted)" });
    this.step += 1;
    if (turn.text) yield { type: "text", delta: turn.text } as const;
    let n = 0;
    for (const call of turn.toolCalls ?? []) {
      yield { type: "tool_call", id: call.id ?? `fake_${this.step}_${n}`, name: call.name, args: call.args } as const;
      n += 1;
    }
    yield { type: "stop", reason: n > 0 ? ("tool_use" as const) : ("end" as const) } as const;
  }
}

/** A plugin providing ctx.llm where both roles chat through `model` and completeJson answers via `respond`. */
export const fakeChat = (model: ChatModel, respond?: (system: string, user: string) => unknown) => ({
  name: "fake-chat",
  apply(ctx: Context) {
    const service: LlmService = {
      for: () => model,
      forProfile: () => model,
      profiles: () => [{ id: "fake", title: "fake" }],
      ready: () => ({ ok: true, profile: { id: "fake", title: "fake", provider: "fake", model: "fake" } }),
      test: async () => ({ ok: true }),
      listing: async () => ({ ok: true, models: ["fake"] }),
      lend: () => () => {},
      worker: async () => ({ ok: true, via: "profile", title: "fake" }),
      completeJson: async <T,>(schema: z.ZodType<T>, request: CompletionRequest): Promise<T> => {
        if (!respond) throw new LlmError("fakeChat was given no completeJson responder");
        return schema.parse(respond(request.system, request.user));
      }
    };
    ctx.provide("llm", service);
  }
});

export default Llm;
