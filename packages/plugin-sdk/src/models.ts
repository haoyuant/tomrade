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

/**
 * SDK 0.2.28. The wire a provider's chat endpoint speaks, when it is a plain one
 * another client can drive too. The built-in agent speaks these three.
 */
export type ModelWire = "openai-completions" | "anthropic-messages" | "google-generative-ai";

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
  /**
   * SDK 0.2.28. The plain wire its chat endpoint speaks: then Tomrade's built-in
   * agent (pi) runs this provider's profiles too — on `baseURL.default`, with the
   * key only in that process's environment. Leave it out when requests need
   * headers or a body of your own, or the endpoint is not plain OpenAI, Anthropic
   * or Gemini; only Tomrade's own adapters reach it then.
   */
  wire?: ModelWire;
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

/** A model on the app's own OpenAI-compatible adapter. */
export interface CompatibleModelOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  inputModalities?: ModelInput[];
  outputModalities?: ModelOutput[];
  /**
   * The model searches the web on its own when a request asks: `"chat"` on chat/completions, with
   * the vendor's own flag set by `body`; `"responses"` on the Responses API. Absent, it does not.
   */
  webSearch?: "chat" | "responses";
  /** The last word on each chat/completions body (a copy of the request beside it): a vendor's own fields. Throw to fail the request. */
  body?(json: Record<string, unknown>, request: ModelChatRequest): Record<string, unknown>;
  /** The last word on each Responses body, where a searching request goes with `webSearch: "responses"`: the vendor's effort scale, its limits. Throw to fail the request. */
  responses?(json: Record<string, unknown>, request: ModelChatRequest): Record<string, unknown>;
  /**
   * The headers of each request in place of `Authorization: Bearer <apiKey>`: a vendor's own key
   * header, a token that expires, a signature over `url` and the exact `body` sent. Asked again
   * before every try, retries included. Throw to fail the request.
   */
  headers?(request: { url: string; body: string }): Maybe<Record<string, string>>;
}

export interface ModelsApi {
  /** Serves the profiles naming `provider.id` and offers its presets until disposed or the plugin unloads. */
  registerProvider(provider: ModelProviderSpec): Promise<Disposer>;
  /**
   * Synchronous, like `build`: a model on the app's own OpenAI-compatible adapter — streaming, tool
   * calls, retries, media, the token-field quirks — for a vendor that serves chat/completions.
   */
  compatible(options: CompatibleModelOptions): ModelChat;
  /**
   * The app's own listing of a chat/completions endpoint (`GET /models`), media read from it; one
   * without a listing answers `models: null`. `headers` go in place of the bearer key.
   */
  listCompatible(endpoint: { baseURL: string; apiKey: string; headers?: Record<string, string> }, signal?: AbortSignal): Promise<ModelListing>;
}
