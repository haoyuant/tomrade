import type { Disposer, Localized, ModelMessage, ModelTool } from "./contract.js";

type Maybe<T> = T | Promise<T>;

/** What a model reads besides text. */
export type ModelInput = "image" | "audio" | "video" | "pdf";
/** What a model can answer with besides text. */
export type ModelOutput = "image" | "audio";

/** SDK 0.2.16. One assistant turn a profile on the provider is asked for. */
export interface ModelChatRequest {
  system: string;
  messages: ModelMessage[];
  tools?: ModelTool[];
  toolChoice?: "auto" | "none" | { name: string };
  maxTokens?: number;
  temperature?: number;
  /** Reasoning effort ("low", "medium", "high"…) where the model has the knob; ignore it otherwise. */
  effort?: string;
  /** Answer with a single JSON document. */
  json?: boolean;
  /** Search the web yourself; asked only of a model whose capabilities say `nativeWebSearch`. */
  webSearch?: boolean;
  /** Media the reply should carry; asked only of a model whose capabilities list it in `mediaOutput`. */
  mediaOutput?: ModelOutput[];
}

/** What a turn streams, in order, ending with `stop`. A `native` block comes back in later requests as the provider's own record (server-side tool calls, signatures). */
export type ModelChatEvent =
  | { type: "text"; delta: string }
  | { type: "media"; media: { mime: string; base64: string; name: string } }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "native"; provider: string; data: unknown }
  /** `inputTokens` counts every prompt token read, cached ones included. */
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  /** The request failed before anything streamed and is sent again after `delayMs`. */
  | { type: "retry"; attempt: number; max: number; reason: string; delayMs: number }
  | { type: "stop"; reason: "end" | "tool_use" | "max_tokens" | "refusal" };

export interface ModelChatCapabilities {
  /** MIME types it reads (`image/png`, `application/pdf`…). */
  mediaInput?: string[];
  mediaOutput?: string[];
  tools: boolean;
  streaming: boolean;
  json: boolean;
  /** It searches the web on its own when a request sets `webSearch`. */
  nativeWebSearch?: boolean;
}

/** One model as Tomrade's conversations, worker and tools talk to it. Throw with what the provider said when a request fails. */
export interface ModelChat {
  capabilities: ModelChatCapabilities;
  chat(request: ModelChatRequest, signal?: AbortSignal): AsyncIterable<ModelChatEvent>;
}

/** A saved model profile naming the provider. */
export interface ModelProfileInfo {
  id: string;
  title: string;
  provider: string;
  /** Absent: the provider's default address. */
  baseURL?: string;
  apiKey: string;
  model: string;
  inputModalities?: ModelInput[];
  outputModalities?: ModelOutput[];
}

/** A well-known service the provider serves, offered in the model setup. */
export interface ModelPresetSpec {
  /** Namespaced like every id a plugin registers. */
  id: string;
  title: string;
  /** Absent: the provider's own address. */
  baseURL?: string;
  /** The model to start with; otherwise the newest listed one matching `prefer`, then the first listed. */
  model?: string;
  prefer?: RegExp[];
  /** Where people get a key. */
  keyPage?: string;
  /** The variable people export the key as, which Tomrade looks for on this computer. */
  env?: string;
  /** What its keys look like, so a pasted key picks this preset. */
  keyShapes?: RegExp[];
  /** Runs on this computer and needs no key. */
  local?: boolean;
  /** One line under the preset in the setup. */
  hint?: Localized;
}

export interface ModelMedia {
  inputModalities: ModelInput[];
  outputModalities: ModelOutput[];
}

/** The models an endpoint lists (null: it has no listing), or why the key or address does not work. */
export type ModelListing = { ok: true; models: string[] | null; capabilities?: Record<string, ModelMedia> } | { ok: false; status?: number; detail: string };

/**
 * A sign-in the provider allows third-party apps instead of pasting a key: an
 * OAuth flow that ends in a key (OpenRouter's PKCE), or credentials already on
 * this computer. Never a consumer subscription its terms keep to the vendor's own apps.
 */
export interface ModelSignIn {
  /** The button, such as "Sign in with OpenRouter". */
  title: Localized;
  /** Runs the sign-in; `open` shows a page in the person's browser. What it answers is kept as the profile's key. */
  run(helpers: { open(url: string): void; signal: AbortSignal }): Promise<{ apiKey: string }>;
}

/** SDK 0.2.16. One way to talk to models, as the app's own providers are: what a profile's `provider` names. */
export interface ModelProviderSpec {
  /** Namespaced like every id a plugin registers; profiles store it. */
  id: string;
  title: Localized;
  /** False for an endpoint that works without a key, such as a local one. Default true. */
  keyRequired?: boolean;
  /** Where a profile without its own address talks; `editable: false` leaves the address out of the form. */
  baseURL: { default: string; editable?: boolean };
  /** False for an endpoint that only makes images. Default true. */
  chat?: boolean;
  presets?: ModelPresetSpec[];
  /** Doubles as the key check when a profile is saved. */
  list(endpoint: { baseURL?: string; apiKey: string }, signal: AbortSignal): Maybe<ModelListing>;
  /** Of what the endpoint lists, the models a profile can use, best first. Default: all of them, as listed. */
  usable?(listed: string[]): string[];
  /** What its models read besides text when a profile stores nothing. */
  defaultInput?: ModelInput[];
  /** A model's media: what its listing entry says, else what the provider knows; undefined keeps a profile's stored values. */
  capabilities?(model: string, listed?: ModelMedia): ModelMedia | undefined;
  signIn?: ModelSignIn;
  /** Called synchronously when a profile on it is first used, and again once the profile changes. */
  build(profile: ModelProfileInfo): ModelChat;
}

export interface ModelsApi {
  /** Serves the profiles naming `provider.id` and offers its presets until disposed or the plugin unloads. */
  registerProvider(provider: ModelProviderSpec): Promise<Disposer>;
}
