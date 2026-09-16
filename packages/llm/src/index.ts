import { Context, Service } from "cordis";
import { z } from "zod";
import type { SettingsSection } from "@tomrade/settings";
import { AnthropicModel } from "./anthropic.js";
import { ImagesModel } from "./images.js";
export { ImagesModel } from "./images.js";
import { LlmError } from "./errors.js";
import { collect, userMessage, type ChatModel, type ChatRequest, type LlmRole } from "./model.js";
import { OpenAiCompatible } from "./openai.js";
import { withPromptTools } from "./prompt-tools.js";

export * from "./model.js";
export { LlmError } from "./errors.js";
export { OpenAiCompatible, type OpenAiConfig } from "./openai.js";
export { AnthropicModel, type AnthropicConfig } from "./anthropic.js";
export { withPromptTools } from "./prompt-tools.js";

export interface CompletionRequest {
  system: string;
  user: string;
  temperature?: number;
}

/** The structured seam: one JSON document matching a schema. Kept from v1; compound tools live on it. */
export interface LLMProvider {
  completeJson<T>(schema: z.ZodType<T>, request: CompletionRequest): Promise<T>;
}

export interface LlmStatus {
  ok: boolean;
  reason?: string;
  profile?: { id: string; title: string; provider: string; model: string };
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

/** ctx.llm: profiles + roles from settings, adapters cached until settings change. */
export class Llm extends Service implements LlmService {
  static provide = "llm";
  static inject = ["settings"];

  private cache = new Map<string, ChatModel>();

  constructor(ctx: Context) {
    super(ctx, "llm");
  }

  [Service.init]() {
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
    if (!profile) return { ok: false, reason: "No model profile configured — add one in Settings → Assistant" };
    // A local endpoint (Ollama, LM Studio) needs no key; Anthropic always does.
    if (profile.provider === "anthropic" && !profile.apiKey) return { ok: false, reason: `Profile "${profile.title || profile.id}" has no API key` };
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

  private adapterOf(profile: ModelProfile): ChatModel {
    const key = JSON.stringify(profile);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const base: ChatModel =
      profile.provider === "openai-images"
        ? new ImagesModel({ baseURL: profile.baseURL ?? "https://api.openai.com/v1", apiKey: profile.apiKey, model: profile.model })
        : profile.provider === "anthropic"
        ? new AnthropicModel({ apiKey: profile.apiKey, model: profile.model, baseURL: profile.baseURL, inputModalities: profile.inputModalities })
        : new OpenAiCompatible({ baseURL: profile.baseURL ?? "https://api.deepseek.com", apiKey: profile.apiKey, model: profile.model, inputModalities: profile.inputModalities, outputModalities: profile.outputModalities });
    const model = profile.promptTools && profile.provider !== "openai-images" ? withPromptTools({ capabilities: { ...base.capabilities, tools: false }, chat: (r, s) => base.chat(r, s) }) : base;
    this.cache.set(key, model);
    return model;
  }

  async completeJson<T>(schema: z.ZodType<T>, request: CompletionRequest): Promise<T> {
    const model = this.for("worker");
    const out = await collect(
      model.chat({
        system: request.system,
        messages: [userMessage(request.user)],
        json: model.capabilities.json,
        temperature: request.temperature ?? 0.2,
        maxTokens: 8000
      })
    );
    if (!out.text) throw new LlmError("LLM returned no content");
    let lastError: unknown;
    for (const candidate of parseCandidates(out.text.trim())) {
      try {
        return schema.parse(JSON.parse(candidate));
      } catch (err) {
        lastError = err;
      }
    }
    throw new LlmError("LLM output failed schema validation", lastError);
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

  profiles(): { id: string; title: string }[] {
    return [];
  }

  ready(): LlmStatus {
    return { ok: false, reason: "FakeLlm answers completeJson only" };
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
      completeJson: async <T,>(schema: z.ZodType<T>, request: CompletionRequest): Promise<T> => {
        if (!respond) throw new LlmError("fakeChat was given no completeJson responder");
        return schema.parse(respond(request.system, request.user));
      }
    };
    ctx.provide("llm", service);
  }
});

export default Llm;
