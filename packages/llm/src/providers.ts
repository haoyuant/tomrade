import type { ModelErrorKind } from "@tomradex/domain";
import { listedCapabilities, type ListedModel, type ModelCapabilities } from "./capabilities.js";

/**
 * A well-known service a model provider serves: where its keys come from, what
 * a key looks like, and which of the listed models to start with. The UI draws
 * the quick setup from these and knows no provider itself.
 */
export interface ProviderPreset {
  id: string;
  title: string;
  /** The model provider that serves it (a profile's `provider`). */
  provider: string;
  baseURL: string;
  /** Tried first; otherwise the newest listed model matching `prefer`, then the first listed. */
  model: string;
  prefer: RegExp[];
  keyPage?: string;
  /** The variable people export it as, which detection looks for. */
  env?: string;
  /** What its keys look like, to tell a pasted key's provider. */
  keyShapes?: RegExp[];
  /** Runs on this computer and needs no key. */
  local?: boolean;
  hint: { en: string; zh: string };
}

/** Which presets a pasted key most likely belongs to, in their order; empty when it could be anyone's. */
export function guessFrom(presets: ProviderPreset[], key: string): string[] {
  const k = key.trim();
  return presets.filter((p) => p.keyShapes?.some((shape) => shape.test(k))).map((p) => p.id);
}

/** The model to start with from what the endpoint lists (null: it lists nothing). */
export function pickModel(preset: Pick<ProviderPreset, "model" | "prefer">, listed: string[] | null): string {
  if (!listed?.length) return preset.model;
  if (preset.model && listed.includes(preset.model)) return preset.model;
  for (const pattern of preset.prefer) {
    const hits = listed.filter((id) => pattern.test(id)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    if (hits.length) return hits[0];
  }
  return listed[0];
}

/** `sk-…1a2b`: enough to recognise a key without showing it. */
export const keyHint = (key: string): string => (key.length > 10 ? `${key.slice(0, 3)}…${key.slice(-4)}` : "…");

/** A provider's models, or why the key or address does not work. Listing doubles as the key check. */
export async function listModels(preset: Pick<ProviderPreset, "provider" | "baseURL">, apiKey: string, timeoutMs = 15_000): Promise<{ ok: true; models: string[] | null; capabilities: Record<string, ModelCapabilities> } | { ok: false; status?: number; detail: string }> {
  const anthropic = preset.provider === "anthropic";
  const base = (anthropic ? preset.baseURL || "https://api.anthropic.com/v1" : preset.baseURL).replace(/\/$/, "");
  const headers: Record<string, string> = anthropic ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  try {
    const res = await fetch(`${base}/models${anthropic ? "?limit=100" : ""}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    // Some compatible endpoints answer chat but have no listing; the chat probe decides then.
    if (res.status === 404 || res.status === 405) return { ok: true, models: null, capabilities: {} };
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, detail: `${res.status} ${text.slice(0, 300)}` };
    const body = JSON.parse(text) as { data?: ListedModel[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    const capabilities: Record<string, ModelCapabilities> = {};
    for (const entry of body.data ?? []) {
      const listed = entry.id ? listedCapabilities(entry) : null;
      if (entry.id && listed) capabilities[entry.id] = listed;
    }
    return { ok: true, models: ids.length ? ids : null, capabilities };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? `${err.name === "TimeoutError" ? "timed out" : ""} ${err.message}`.trim() : String(err) };
  }
}

/**
 * The listed models a profile of this kind can use, newest-looking first. An
 * OpenAI-style listing mixes in embeddings, speech and moderation models.
 */
export function usableModels(provider: string, listed: string[]): string[] {
  const images = /image|dall-e/i;
  const notChat = /embed|whisper|tts|transcribe|moderation|rerank|dall-e|gpt-image|davinci|babbage/i;
  const kept = provider === "openai-images" ? listed.filter((id) => images.test(id)) : listed.filter((id) => !notChat.test(id));
  return [...new Set(kept)].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}

/** `capabilities` holds the models whose media Tomrade could detect, by id. */
export type ModelListing = { ok: true; models: string[]; capabilities: Record<string, ModelCapabilities> } | { ok: false; kind: ModelErrorKind; detail: string };

export type QuickSetupResult =
  | { ok: true; profile: { id: string; title: string; model: string } }
  | { ok: false; kind: ModelErrorKind; detail: string };
