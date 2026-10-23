import type { ModelCapabilities } from "./capabilities.js";
import type { ChatModel, InputModality, OutputModality } from "./model.js";
import type { ProviderPreset } from "./providers.js";

/** What a profile names its provider and endpoint with; the rest of the profile is the provider's to read. */
export interface ProviderProfile {
  id: string;
  title: string;
  provider: string;
  baseURL?: string;
  apiKey: string;
  model: string;
  inputModalities?: InputModality[];
  outputModalities?: OutputModality[];
}

/** `capabilities`: what the listing itself says of a model's media, by id. */
export type ModelListResult = { ok: true; models: string[] | null; capabilities: Record<string, ModelCapabilities> } | { ok: false; status?: number; detail: string };

/**
 * The wire a provider's chat endpoint speaks, when it is a plain one another
 * client can drive too. The built-in agent (pi) speaks these three; a provider
 * that says which it speaks lets its profiles run there as well.
 */
export type ModelWire = "openai-completions" | "anthropic-messages" | "google-generative-ai";

/**
 * One way to talk to models: what a profile's `provider` names. Core builds,
 * lists and checks a profile only through its provider, so adding one needs
 * nothing from core. A provider applies its own default address.
 */
export interface ModelProviderSpec {
  id: string;
  title: { en: string; zh: string };
  /** A sign-in the provider allows third-party apps besides pasting a key; it ends in the key the profile keeps. */
  signIn?: ProviderSignIn;
  /** A profile without a key cannot work; a local endpoint can do without one. */
  keyRequired: boolean;
  /** Where a profile without its own address talks; not `editable`, the form leaves the address out. */
  baseURL: { default: string; editable: boolean };
  /** False for an endpoint that only makes images: no conversation check on save, no prompt tools, no media detection. */
  chat: boolean;
  /**
   * The wire its chat endpoint speaks, when it is a plain OpenAI, Anthropic or
   * Gemini one: then the built-in agent may run this provider's profiles too,
   * from `baseURL.default` with the key only in its environment. Absent: only
   * Tomrade's own adapters reach it.
   */
  wire?: ModelWire;
  /** The well-known services it serves, for quick setup and the profile form. */
  presets: Omit<ProviderPreset, "provider">[];
  /** The models the endpoint lists (null: it has no listing); doubles as the key check. */
  list(endpoint: { baseURL?: string; apiKey: string }, timeoutMs?: number): Promise<ModelListResult>;
  /** Of what the endpoint lists, the models a profile can use, newest-looking first. */
  usable(listed: string[]): string[];
  /** What its adapter reads besides text when a profile stores nothing. */
  defaultInput: InputModality[];
  /** A model's media: what its listing entry says, else what the provider knows; undefined keeps a profile's stored values. */
  capabilities(model: string, listed?: ModelCapabilities): ModelCapabilities | undefined;
  /** A profile saved for another provider that this one now serves, rewritten for it; read once at start-up. */
  claims?(profile: ProviderProfile): ProviderProfile | undefined;
  build(profile: ProviderProfile): ChatModel;
}

export interface ProviderSignIn {
  title: { en: string; zh: string };
  run(helpers: { open(url: string): void; signal: AbortSignal }): Promise<{ apiKey: string }>;
}

/** A provider as the profile form draws it. */
export interface ModelProviderView {
  id: string;
  title: string;
  keyRequired: boolean;
  baseURL: { default: string; editable: boolean };
  chat: boolean;
  defaultInput: InputModality[];
  /** The plain wire its endpoint speaks, for the built-in agent; absent when it speaks an API of its own. */
  wire?: ModelWire;
  /** The sign-in button's words, when it has one. */
  signIn?: string;
}
