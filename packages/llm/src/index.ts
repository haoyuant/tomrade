import { Context, Service } from "cordis";
import { z } from "zod";
import { modelErrorKind, wordsLocale, type ModelErrorKind, type WordsLocale } from "@tomradex/domain";
import type {} from "@tomradex/db";
import type {} from "@tomradex/desktop-surface";
import type {} from "@tomradex/ipc";
import type { SettingsSection } from "@tomradex/settings";
import type { WebSearchProvider } from "@tomradex/web-search";
import { BUILTIN_PROVIDERS } from "./builtin-providers.js";
import { sameCapabilities, type ModelCapabilities } from "./capabilities.js";
export { ImagesModel } from "./images.js";
import { LlmError, MediaRefused } from "./errors.js";
import { assistantMessage, collect, modalityOf, userMessage, type ChatEvent, type ChatModel, type ChatRequest, type Collected, type LlmRole, type Message } from "./model.js";
import { withPromptTools } from "./prompt-tools.js";
import type { ModelProviderSpec, ModelProviderView, ProviderSignIn } from "./provider.js";
import { guessFrom, keyHint, pickModel, type ModelListing, type ProviderPreset, type QuickSetupResult } from "./providers.js";
import { WORKER_CALLS_MIGRATIONS, WORKER_CALLS_TABLES, WorkerCallLog, type WorkerPurpose, type WorkerSpend, type WorkerUsageSummary } from "./worker-usage.js";
import { REFUSED_MEDIA_MIGRATION, REFUSED_MEDIA_TABLES, RefusedMedia } from "./refused-media.js";
import { LLM_WORDS } from "./words.js";

export * from "./model.js";
export { guessFrom, keyHint, listModels, pickModel, usableModels, type ModelListing, type ProviderPreset, type QuickSetupResult } from "./providers.js";
export { ANTHROPIC, BUILTIN_PROVIDERS, DEEPSEEK, GEMINI, KIMI, OPENAI, OPENAI_COMPATIBLE, OPENAI_IMAGES, OPENROUTER, PROVIDERS, guessProviders } from "./builtin-providers.js";
export { GeminiModel, type GeminiConfig } from "./gemini.js";
export { openRouterSignIn, type OpenRouterSignIn } from "./openrouter-auth.js";
export { deepseekKey, deepseekProvider, type DeepSeekKey } from "./search/deepseek.js";
export { kimiKey, kimiProvider, type KimiKey } from "./search/kimi.js";
export type { ModelListResult, ModelProviderSpec, ModelProviderView, ProviderProfile, ProviderSignIn } from "./provider.js";
export { LlmError, MediaRefused, NativeMediaRefused, NativeSearchRefused, type LlmErrorResponse } from "./errors.js";
export { OpenAiCompatible, type OpenAiConfig } from "./openai.js";
export { AnthropicModel, type AnthropicConfig } from "./anthropic.js";
export type { ModelCapabilities } from "./capabilities.js";
export { withPromptTools } from "./prompt-tools.js";
export type { WorkerPurpose, WorkerSpend, WorkerUsage, WorkerUsageSummary } from "./worker-usage.js";

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
  /** What the call is for, so the Usage pane can say what the worker spent on what. */
  purpose?: WorkerPurpose;
}

const NO_PROFILE = "No model profile configured — add one in Settings → Assistant";
// Reachable from mainland China first for a Chinese reader; the paid global APIs first otherwise.
const PROVIDER_ORDER: Record<WordsLocale, string[]> = {
  en: ["anthropic", "openai", "gemini", "deepseek", "openrouter", "kimi", "ollama"],
  zh: ["deepseek", "kimi", "anthropic", "openai", "gemini", "openrouter", "ollama"]
};

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

/** One token from `model`, or why not. A model that never answers in time is slow or busy, not an unreachable address. */
export async function probe(model: ChatModel, timeoutMs = 45_000): Promise<ModelTest> {
  let retried = "";
  try {
    // a retry is not an answer: the request it announces may still fail
    for await (const event of model.chat({ system: "Reply with one word.", messages: [userMessage("ping")], maxTokens: 1 }, AbortSignal.timeout(timeoutMs))) {
      if (event.type !== "retry") break;
      retried = event.reason;
    }
    return { ok: true };
  } catch (err) {
    // the message keeps 300 characters of the body; a tier refusal names its limit further on
    const response = err instanceof LlmError ? err.response : undefined;
    const detail = response && response.body.length > 300 ? `LLM request failed ${response.status}: ${response.body.slice(0, 2000)}` : err instanceof Error ? err.message : String(err);
    if (!(err instanceof Error && err.name === "TimeoutError")) return { ok: false, kind: modelErrorKind(detail), detail };
    // Out of time while retrying an overloaded or limited model is that answer, not an unreachable address.
    if (retried) return { ok: false, kind: modelErrorKind(retried), detail: `No answer within ${timeoutMs / 1000}s; the last try said ${retried}` };
    return { ok: false, kind: "slow", detail: `No answer within ${timeoutMs / 1000}s: ${detail}` };
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
  /** Its place in Automatic and in the picker: the lowest ready one answers. Absent, after every ranked one. */
  rank?: number;
  /** Whether it can answer now; asked before each call, so keep it cached. */
  ready(): Promise<boolean>;
  model: ChatModel;
}

/** A provider as the quick setup offers it, in the person's language and order. */
export interface ProviderView {
  id: string;
  title: string;
  hint: string;
  /** The model provider a profile for it uses, and where it starts. */
  provider: string;
  baseURL: string;
  model: string;
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
  /** null: still checking whether it is signed in (its first check can take a model call). */
  ready: boolean | null;
}

/** How long Settings waits for a lent model to say whether it is ready before it shows it as checking. */
export const LENDER_WAIT_MS = 1500;

/** Lent calls start local processes; past this many at once, the rest wait their turn. */
export const LENT_CONCURRENCY = 2;

/** A sign-in ends in the key the profile keeps, or says why not. */
export type SignInResult = { ok: true; apiKey: string } | { ok: false; detail: string };

/** How long a sign-in in the browser may take before it is given up. */
export const SIGN_IN_MS = 5 * 60_000;

/** Which way web search goes: the profiles whose model searches on its own, and the service that searches for the rest. */
export interface SearchRoute {
  native: string[];
  /** null: nobody can search for the other models. */
  service: string | null;
}

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
  /** Serve the profiles naming `provider.id`, and offer its presets; returns the withdrawal. */
  registerProvider(provider: ModelProviderSpec): () => void;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "llm.test": (profile: ModelProfile) => ModelTest;
    "llm.models": (endpoint: Pick<ModelProfile, "provider" | "baseURL" | "apiKey">) => ModelListing;
    "llm.worker": () => WorkerStatus;
    "llm.lenders": () => LenderView[];
    "llm.providers": () => ProviderView[];
    "llm.modelProviders": () => ModelProviderView[];
    "llm.guess": (key: string) => string[];
    "llm.detect": () => DetectedModel[];
    "llm.quickSetup": (input: { preset: string; apiKey?: string }) => QuickSetupResult;
    "llm.adopt": (id: string) => QuickSetupResult;
    "llm.workerUsage": () => WorkerUsageSummary;
    "llm.searchRoute": () => SearchRoute;
    /** Runs the provider's own sign-in, in the person's browser. */
    "llm.signIn": (provider: string) => SignInResult;
  }
  interface Broadcasts {
    /** A model provider came or went (a plugin's); the setup and the profile form refetch. */
    "llm.providersChanged": () => void;
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
  /** The model provider that builds it: one of the app's own ("deepseek", "anthropic", "openai-compatible"…) or one a plugin adds. */
  provider: z.string().min(1),
  baseURL: z.string().optional(),
  apiKey: z.string().default(""),
  model: z.string().min(1),
  /** Render tools into the prompt for a model without native tool calling. Degraded. */
  promptTools: z.boolean().optional(),
  /** What the model reads and makes besides text, detected by Tomrade from the provider's listing; never ticked by hand. */
  inputModalities: z.array(z.enum(["image", "audio", "video", "pdf"])).optional(),
  outputModalities: z.array(z.enum(["image", "audio"])).optional()
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
export async function completeJson<T>(model: ChatModel, schema: z.ZodType<T>, request: CompletionRequest, label = "The worker model", spent?: WorkerSpend): Promise<T> {
  const messages: Message[] = [userMessage(request.user)];
  const deadline = request.timeoutMs !== undefined ? AbortSignal.timeout(request.timeoutMs) : undefined;
  let problem = "";
  const maxTokens = request.maxTokens ?? 8000;
  for (let attempt = 0; attempt < (request.repair === false ? 1 : 2); attempt += 1) {
    const out = await collectWithin(
      (signal) => model.chat({ system: request.system, messages, json: model.capabilities.json, temperature: request.temperature ?? 0.2, maxTokens }, signal),
      { label, signal: request.signal, deadline, timeoutMs: request.timeoutMs, streaming: model.capabilities.streaming }
    );
    if (spent) {
      spent.inputTokens += out.usage.inputTokens;
      spent.cacheReadTokens += out.usage.cacheReadTokens ?? 0;
      spent.outputTokens += out.usage.outputTokens;
    }
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

export const LlmConfig = z.object({
  /** The app's own providers come with the service; a composition that gives each a row of its own sets false. */
  builtins: z.boolean().default(true)
}).prefault({});
export type LlmConfig = z.infer<typeof LlmConfig>;

/** A provider's sign-in, or none: one registered against an older contract says `signIn: "apiKey"`. */
const signInOf = (kind: ModelProviderSpec): ProviderSignIn | undefined =>
  typeof kind.signIn === "object" && kind.signIn !== null && typeof kind.signIn.run === "function" ? kind.signIn : undefined;

/** ctx.llm: profiles + roles from settings, adapters cached until settings change. */
export class Llm extends Service implements LlmService {
  static provide = "llm";
  static inject = ["settings"];
  static Config = LlmConfig;

  private cache = new Map<string, ChatModel>();
  private kinds: Map<string, ModelProviderSpec>;
  /** Its own context: a provider registers from the caller's, which need not have settings. */
  private readonly home: Context;
  private resyncSearches: (() => void) | null = null;
  private lent: LentModel[] = [];
  private lentRunning = 0;
  private lentWaiting: (() => void)[] = [];
  private calls: WorkerCallLog | null = null;
  private refused = new RefusedMedia();

  constructor(ctx: Context, config: LlmConfig = { builtins: true }) {
    super(ctx, "llm");
    this.home = ctx;
    this.kinds = new Map((config.builtins ? BUILTIN_PROVIDERS : []).map((p) => [p.id, p]));
  }

  [Service.init]() {
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("llm.test", (profile) => ctx.llm.test(profile));
      ctx.ipc.handle("llm.searchRoute", () => this.searchRoute());
      ctx.ipc.handle("llm.models", (endpoint) => ctx.llm.listing(endpoint));
      ctx.ipc.handle("llm.worker", () => ctx.llm.worker());
      ctx.ipc.handle("llm.lenders", () => this.lenders());
      ctx.ipc.handle("llm.providers", () => this.providers());
      ctx.ipc.handle("llm.modelProviders", () => this.modelProviders());
      ctx.ipc.handle("llm.guess", (key) => guessFrom(this.presets(), key));
      ctx.ipc.handle("llm.detect", () => this.detect());
      ctx.ipc.handle("llm.quickSetup", (input) => this.quickSetup(input));
      ctx.ipc.handle("llm.adopt", (id) => this.adopt(id));
      ctx.ipc.handle("llm.workerUsage", () => this.workerUsage());
      ctx.ipc.handle("llm.signIn", (provider) => this.signIn(provider));
    });
    this.ctx.inject(["db"], (ctx) => {
      ctx.db.migrate("llm", [...WORKER_CALLS_MIGRATIONS, REFUSED_MEDIA_MIGRATION], { scope: "hub", tables: { ...WORKER_CALLS_TABLES, ...REFUSED_MEDIA_TABLES } });
      ctx.effect(() => {
        this.calls = new WorkerCallLog(ctx.db.hub);
        this.refused.attach(ctx.db.hub);
        this.refused.keepFor(this.models().profiles);
        return () => {
          this.calls = null;
          this.refused.attach(null);
        };
      });
    });
    this.ctx.settings.register(MODELS_SECTION);
    this.migrateLegacy();
    this.claimProfiles([...this.kinds.values()]);
    this.ctx.inject(["webSearch"], (ctx) => this.offerSearches(ctx));
    this.ctx.on("settings/changed", () => {
      this.cache.clear();
      this.refused.keepFor(this.models().profiles);
    });
    void this.redetect().catch((err) => this.ctx.logger.warn(`model media not re-detected: ${err instanceof Error ? err.message : String(err)}`));
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
    const w = this.words();
    if (!profile) return { ok: false, reason: w("noProfile") };
    // A local endpoint (Ollama, LM Studio) needs no key; Anthropic always does.
    if (this.kinds.get(profile.provider)?.keyRequired && !profile.apiKey) return { ok: false, reason: w("noApiKey", { profile: profile.title || profile.id }) };
    return { ok: true, profile: { id: profile.id, title: profile.title || profile.model, provider: profile.provider, model: profile.model } };
  }

  for(role: LlmRole): ChatModel {
    const profile = this.profileFor(role);
    if (!profile) throw new LlmError(NO_PROFILE);
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
    const kind = this.kinds.get(profile.provider);
    if (!kind) return { ok: false, kind: "model", detail: this.unknown(profile.provider) };
    // an image endpoint has no one-token request; it shows its worth on the first picture
    if (!kind.chat) return { ok: true };
    return probe(this.build(profile));
  }

  /** What the endpoint lists, for the profile form's model picker. A listing-less endpoint is an empty list, not an error. */
  async listing(endpoint: Pick<ModelProfile, "provider" | "baseURL" | "apiKey">): Promise<ModelListing> {
    const kind = this.kinds.get(endpoint.provider);
    if (!kind) return { ok: false, kind: "model", detail: this.unknown(endpoint.provider) };
    const result = await kind.list({ baseURL: endpoint.baseURL || undefined, apiKey: endpoint.apiKey.trim() });
    if (!result.ok) return { ok: false, kind: modelErrorKind(result.detail), detail: result.detail };
    const models = kind.usable(result.models ?? []);
    const capabilities: Record<string, ModelCapabilities> = {};
    for (const id of models) {
      const detected = kind.capabilities(id, result.capabilities[id]);
      if (detected) capabilities[id] = detected;
    }
    return { ok: true, models, capabilities };
  }

  /**
   * Profiles take the media their endpoint now lists for their model, replacing
   * values saved before detection or ticked by hand. An endpoint that answers
   * nothing about the model leaves the stored values.
   */
  async redetect(): Promise<void> {
    const asked = new Map<string, Promise<ModelListing | null>>();
    const found = new Map<string, { model: string; detected: ModelCapabilities }>();
    for (const profile of this.models().profiles) {
      if (!this.kinds.get(profile.provider)?.chat) continue;
      const key = JSON.stringify([profile.provider, profile.baseURL ?? "", profile.apiKey]);
      if (!asked.has(key)) asked.set(key, this.listing(profile).catch(() => null));
      const listing = await asked.get(key);
      const detected = listing?.ok ? listing.capabilities[profile.model] : undefined;
      if (detected && !sameCapabilities(profile, detected)) found.set(profile.id, { model: profile.model, detected });
    }
    if (!found.size) return;
    // read again: the person may have edited a profile while the listings were asked
    const all = this.ctx.settings.get();
    const models = this.models();
    const profiles = models.profiles.map((p) => {
      const hit = found.get(p.id);
      return hit && hit.model === p.model ? { ...p, ...hit.detected } : p;
    });
    this.ctx.settings.set({ ...all, models: { ...models, profiles } });
  }

  registerProvider(provider: ModelProviderSpec): () => void {
    // tied to the caller, so a plugin's provider goes with it
    return this.ctx.effect(() => {
      this.kinds.set(provider.id, provider);
      this.claimProfiles([provider]);
      this.providersChanged();
      return () => {
        if (this.kinds.get(provider.id) !== provider) return;
        this.kinds.delete(provider.id);
        this.providersChanged();
      };
    }, `llm.registerProvider(${provider.id})`);
  }

  private providersChanged(): void {
    this.cache.clear();
    this.resyncSearches?.();
    this.ctx.get("ipc")?.send("llm.providersChanged");
  }

  async signIn(provider: string): Promise<SignInResult> {
    const kind = this.kinds.get(provider);
    const signIn = kind && signInOf(kind);
    if (!signIn) return { ok: false, detail: kind ? `${kind.title.en} has no sign-in; paste a key instead` : this.unknown(provider) };
    const signal = AbortSignal.timeout(SIGN_IN_MS);
    // given up on time even when the sign-in does not listen to the signal
    const gaveUp = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error(`${kind.title.en} sign-in was not finished within ${SIGN_IN_MS / 60_000} minutes`)), { once: true }));
    try {
      const { apiKey } = await Promise.race([signIn.run({ open: (url) => this.ctx.emit("desktop/open-external", url), signal }), gaveUp]);
      if (typeof apiKey !== "string" || !apiKey.trim()) return { ok: false, detail: `${kind.title.en} sign-in ended without a key` };
      return { ok: true, apiKey: apiKey.trim() };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private unknown(provider: string): string {
    return `No model provider "${provider}" is installed — switch its plugin back on, or pick another profile in Settings → Assistant`;
  }

  /** The app's own in their order, whichever row registered first; a plugin's after them. */
  private ranked(): ModelProviderSpec[] {
    const rank = (id: string) => {
      const i = BUILTIN_PROVIDERS.findIndex((p) => p.id === id);
      return i < 0 ? BUILTIN_PROVIDERS.length : i;
    };
    return [...this.kinds.values()].sort((a, b) => rank(a.id) - rank(b.id));
  }

  private presets(): ProviderPreset[] {
    return this.ranked().flatMap((spec) => spec.presets.map((preset) => ({ ...preset, provider: spec.id })));
  }

  /** The presets in the reader's order: reachable ones first for a Chinese reader, the paid global APIs first otherwise. */
  private ordered(): ProviderPreset[] {
    const order = PROVIDER_ORDER[wordsLocale(this.words().locale)];
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    // a provider's own presets, which the order does not know, come after the app's
    return this.presets().sort((a, b) => rank(a.id) - rank(b.id));
  }

  modelProviders(): ModelProviderView[] {
    const locale = wordsLocale(this.words().locale);
    return this.ranked().map((k) => ({
      id: k.id, title: k.title[locale], keyRequired: k.keyRequired, baseURL: k.baseURL, chat: k.chat, defaultInput: k.defaultInput, ...(signInOf(k) ? { signIn: signInOf(k)!.title[locale] } : {})
    }));
  }

  private adapterOf(profile: ModelProfile): ChatModel {
    const key = JSON.stringify(profile);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const model = this.remembering(profile, this.build(profile));
    this.cache.set(key, model);
    return model;
  }

  /** The profile's model, minus the media it has refused; a new refusal is kept as it passes through. */
  private remembering(profile: ModelProfile, base: ChatModel): ChatModel {
    const refused = this.refused;
    return {
      get capabilities() {
        const caps = base.capabilities;
        const off = refused.of(profile.id, profile.model);
        return off.length && caps.mediaInput ? { ...caps, mediaInput: caps.mediaInput.filter((mime) => !off.includes(modalityOf(mime)!)) } : caps;
      },
      async *chat(request, signal) {
        try {
          yield* base.chat(request, signal);
        } catch (err) {
          if (err instanceof MediaRefused) refused.add(profile.id, profile.model, err.kinds);
          throw err;
        }
      }
    };
  }

  private build(profile: ModelProfile): ChatModel {
    const kind = this.kinds.get(profile.provider);
    if (!kind) throw new LlmError(this.unknown(profile.provider));
    const base = kind.build(profile);
    return profile.promptTools && kind.chat ? withPromptTools({ capabilities: { ...base.capabilities, tools: false }, chat: (r, s) => base.chat(r, s) }) : base;
  }

  async completeJson<T>(schema: z.ZodType<T>, request: CompletionRequest): Promise<T> {
    const source = await this.workerSource();
    if (source.kind === "lent") {
      const lent = source.lent;
      return this.lentSlot(
        () => this.tallied(`lent:${lent.id}`, lent.title, request, (spent) => completeJson(lent.model, schema, request, `${lent.title} (signed in on this computer)`, spent)),
        request.signal
      );
    }
    if (source.kind === "none") throw new LlmError(source.chosen ? source.reason : NO_PROFILE);
    const profile = source.profile;
    const label = `Worker model ${profile.title || profile.model} (${profile.model}, Settings → Assistant)`;
    return this.tallied(`profile:${profile.id}`, profile.title || profile.model, request, (spent) => completeJson(this.for("worker"), schema, request, label, spent));
  }

  /** What worker calls spent today and over the last week, by source and purpose. */
  workerUsage(now = Date.now()): WorkerUsageSummary {
    return this.calls?.summary(now) ?? { today: [], week: [] };
  }

  /** One worker call, its tokens kept for the Usage pane. Keeping them never fails the call. */
  private async tallied<T>(source: string, title: string, request: CompletionRequest, call: (spent: WorkerSpend) => Promise<T>): Promise<T> {
    const at = Date.now();
    const spent: WorkerSpend = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
    let ok = false;
    try {
      const out = await call(spent);
      ok = true;
      return out;
    } finally {
      try {
        this.calls?.record({ at, source, title, purpose: request.purpose ?? null, ...spent, ok });
      } catch (err) {
        this.ctx.logger.warn(`worker usage not recorded: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
      const name = lent?.title ?? id;
      return { kind: "none", chosen: true, reason: this.words()("workerUnavailable", { name }) };
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
    return Promise.all(this.lent.map(async (m) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // the check goes on and keeps its answer for the next look
      const waited = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), LENDER_WAIT_MS)));
      const ready = await Promise.race([m.ready().catch(() => false), waited]);
      clearTimeout(timer);
      return { id: m.id, title: m.title, ready };
    }));
  }

  lend(model: LentModel): () => void {
    // Plugins start in any order; the rank, not who lent first, decides who answers.
    const rank = (m: LentModel) => m.rank ?? Number.MAX_SAFE_INTEGER;
    this.lent = [...this.lent, model].sort((a, b) => rank(a) - rank(b));
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

  private words() {
    return LLM_WORDS(this.ctx.settings.locale?.());
  }

  providers(): ProviderView[] {
    const locale = wordsLocale(this.words().locale);
    return this.ordered().map((p) => ({ id: p.id, title: p.title, hint: p.hint[locale], provider: p.provider, baseURL: p.baseURL, model: p.model, ...(p.keyPage ? { keyPage: p.keyPage } : {}), ...(p.local ? { local: true } : {}) }));
  }

  /** Keys exported in the person's shell and local servers, minus what a profile already uses. */
  async detect(): Promise<DetectedModel[]> {
    const profiles = this.models().profiles;
    const found: DetectedModel[] = [];
    for (const preset of this.ordered()) {
      if (preset.env) {
        const key = process.env[preset.env]?.trim();
        if (key && !profiles.some((p) => p.apiKey === key)) found.push({ id: `env:${preset.env}`, preset: preset.id, source: "env", detail: `${preset.env} · ${keyHint(key)}` });
      }
      if (preset.local && !profiles.some((p) => p.baseURL === preset.baseURL)) {
        const listing = await this.kinds.get(preset.provider)!.list({ baseURL: preset.baseURL, apiKey: "" }, 800);
        if (listing.ok && listing.models?.length) found.push({ id: `local:${preset.id}`, preset: preset.id, source: "local", detail: listing.models.slice(0, 3).join(", ") });
      }
    }
    return found;
  }

  adopt(id: string): Promise<QuickSetupResult> {
    const [source, name] = id.split(":");
    if (source === "local") return this.quickSetup({ preset: name });
    const preset = this.presets().find((p) => p.env === name);
    if (source !== "env" || !preset) throw new Error(`Nothing detected as ${id}`);
    return this.quickSetup({ preset: preset.id, apiKey: process.env[name] ?? "" });
  }

  /**
   * One key to a working profile: the provider's listing checks the key and
   * names a model, one token checks the model, and the profile goes first so
   * every engine uses it. A profile on the same endpoint takes the new key.
   */
  async quickSetup(input: { preset: string; apiKey?: string }): Promise<QuickSetupResult> {
    const preset = this.presets().find((p) => p.id === input.preset);
    if (!preset) throw new Error(`Unknown provider ${input.preset}`);
    const kind = this.kinds.get(preset.provider)!;
    const apiKey = input.apiKey?.trim() ?? "";
    if (!preset.local && !apiKey) return { ok: false, kind: "auth", detail: "no API key" };
    const listing = await kind.list({ baseURL: preset.baseURL || undefined, apiKey });
    if (!listing.ok) return { ok: false, kind: modelErrorKind(listing.detail), detail: listing.detail };
    const model = pickModel(preset, listing.models);
    if (!model) return { ok: false, kind: "model", detail: `${preset.title} lists no model to use` };
    const models = this.models();
    const same = models.profiles.find((p) => p.provider === preset.provider && (p.baseURL || "") === preset.baseURL);
    const taken = new Set(models.profiles.map((p) => p.id));
    let id = same?.id ?? preset.id;
    for (let n = 2; !same && taken.has(id); n += 1) id = `${preset.id}-${n}`;
    const detected = kind.capabilities(model, listing.capabilities[model]);
    const media = detected ?? (same?.model === model ? {} : { inputModalities: undefined, outputModalities: undefined });
    const profile: ModelProfile = { ...same, id, title: same?.title || preset.title, provider: preset.provider, ...(preset.baseURL ? { baseURL: preset.baseURL } : {}), apiKey, model, ...media };
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

  /** A preset's own search service goes on while one of the person's profiles has its key, and off when none does. */
  private offerSearches(ctx: Context): void {
    const made = new Map<string, WebSearchProvider>();
    const on = new Map<string, () => void>();
    const sync = () => {
      const presets = this.presets();
      // a provider switched off takes its search service with it
      for (const [id, off] of on) {
        if (presets.some((p) => p.id === id && p.search)) continue;
        off();
        on.delete(id);
        made.delete(id);
      }
      for (const preset of presets) {
        if (!preset.search) continue;
        const service = made.get(preset.id) ?? preset.search(() => this.models().profiles);
        made.set(preset.id, service);
        const ready = !service.unavailable();
        if (ready && !on.has(preset.id)) on.set(preset.id, ctx.webSearch.register(service));
        if (!ready && on.has(preset.id)) {
          on.get(preset.id)!();
          on.delete(preset.id);
        }
      }
    };
    sync();
    ctx.on("settings/changed", sync);
    this.resyncSearches = sync;
    ctx.effect(() => () => (this.resyncSearches = null));
  }

  searchRoute(): SearchRoute {
    const native = this.models().profiles.filter((p) => {
      try {
        return !!this.adapterOf(p).capabilities.nativeWebSearch;
      } catch {
        return false;
      }
    });
    const web = this.ctx.get("webSearch");
    return { native: native.map((p) => p.title || p.model), service: web?.providers().find((p) => !p.unavailable())?.title ?? null };
  }

  /** Profiles a provider now serves better than the one they were saved for move to it, keys and roles kept. */
  private claimProfiles(kinds: ModelProviderSpec[]): void {
    const all = this.home.settings.get();
    const models = all.models as ModelsSettings | undefined;
    if (!models?.profiles?.length) return;
    let moved = false;
    const profiles = models.profiles.map((profile) => {
      for (const kind of kinds) {
        const claimed = kind.claims?.(profile);
        if (claimed) {
          moved = true;
          const { baseURL, ...rest } = { ...profile, ...claimed };
          return baseURL ? { ...rest, baseURL } : rest;
        }
      }
      return profile;
    });
    if (moved) this.home.settings.set({ ...all, models: { ...models, profiles } });
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
    return { ok: true, models: [], capabilities: {} };
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

  registerProvider(): () => void {
    return () => {};
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
      listing: async () => ({ ok: true, models: ["fake"], capabilities: {} }),
      lend: () => () => {},
      registerProvider: () => () => {},
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
