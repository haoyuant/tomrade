import type { ModelErrorKind } from "@tomradex/domain";

/**
 * Well-known model providers: where their keys come from, what a key looks
 * like, and which of the listed models to start with. The UI draws the quick
 * setup from this and knows no provider itself.
 */
export interface ProviderPreset {
  id: string;
  title: string;
  provider: "openai-compatible" | "anthropic";
  baseURL: string;
  /** Tried first; otherwise the newest listed model matching `prefer`, then the first listed. */
  model: string;
  prefer: RegExp[];
  keyPage?: string;
  /** The variable people export it as, which detection looks for. */
  env?: string;
  /** Runs on this computer and needs no key. */
  local?: boolean;
  hint: { en: string; zh: string };
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "deepseek", title: "DeepSeek", provider: "openai-compatible", baseURL: "https://api.deepseek.com", model: "deepseek-chat", prefer: [/flash/, /^deepseek-v\d/],
    keyPage: "https://platform.deepseek.com/api_keys", env: "DEEPSEEK_API_KEY",
    hint: { en: "Low pay-as-you-go prices; reachable from mainland China", zh: "按量付费、价格低，国内可直连" }
  },
  {
    id: "kimi", title: "Kimi", provider: "openai-compatible", baseURL: "https://api.moonshot.cn/v1", model: "", prefer: [/^kimi-k\d/],
    keyPage: "https://platform.moonshot.cn/console/api-keys", env: "MOONSHOT_API_KEY",
    hint: { en: "Moonshot's Kimi models; reachable from mainland China", zh: "月之暗面 Kimi 模型，国内可直连" }
  },
  {
    id: "anthropic", title: "Anthropic", provider: "anthropic", baseURL: "", model: "", prefer: [/^claude-sonnet-/],
    keyPage: "https://console.anthropic.com/settings/keys", env: "ANTHROPIC_API_KEY",
    hint: { en: "Claude models, from a paid Anthropic API account", zh: "Claude 模型，需要付费的 Anthropic API 账户" }
  },
  {
    id: "openai", title: "OpenAI", provider: "openai-compatible", baseURL: "https://api.openai.com/v1", model: "", prefer: [/^gpt-\d+(\.\d+)?$/],
    keyPage: "https://platform.openai.com/api-keys", env: "OPENAI_API_KEY",
    hint: { en: "GPT models, from a paid OpenAI API account", zh: "GPT 模型，需要付费的 OpenAI API 账户" }
  },
  {
    id: "openrouter", title: "OpenRouter", provider: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", model: "", prefer: [/^anthropic\/claude-sonnet-/, /^deepseek\/deepseek-chat/],
    keyPage: "https://openrouter.ai/keys", env: "OPENROUTER_API_KEY",
    hint: { en: "One key for models from many providers", zh: "一个 Key 用多家的模型" }
  },
  {
    id: "ollama", title: "Ollama", provider: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1", model: "", prefer: [/qwen/, /llama/, /deepseek/], local: true,
    hint: { en: "Models running on this computer: free, no key, needs a capable machine", zh: "在这台电脑上运行模型：免费、不用 Key，需要电脑性能够" }
  }
];

/** Which providers a pasted key most likely belongs to, most likely first; empty when it could be anyone's. */
export function guessProviders(key: string): string[] {
  const k = key.trim();
  if (/^sk-ant-/.test(k)) return ["anthropic"];
  if (/^sk-or-/.test(k)) return ["openrouter"];
  if (/^sk-(proj|svcacct|admin)-/.test(k)) return ["openai"];
  if (/^sk-[0-9a-f]{32}$/.test(k)) return ["deepseek"];
  if (/^sk-[A-Za-z0-9]{40,}$/.test(k)) return ["kimi", "openai"];
  return [];
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
export async function listModels(preset: Pick<ProviderPreset, "provider" | "baseURL">, apiKey: string, timeoutMs = 15_000): Promise<{ ok: true; models: string[] | null } | { ok: false; status?: number; detail: string }> {
  const anthropic = preset.provider === "anthropic";
  const base = (anthropic ? preset.baseURL || "https://api.anthropic.com/v1" : preset.baseURL).replace(/\/$/, "");
  const headers: Record<string, string> = anthropic ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  try {
    const res = await fetch(`${base}/models${anthropic ? "?limit=100" : ""}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    // Some compatible endpoints answer chat but have no listing; the chat probe decides then.
    if (res.status === 404 || res.status === 405) return { ok: true, models: null };
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, detail: `${res.status} ${text.slice(0, 300)}` };
    const body = JSON.parse(text) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    return { ok: true, models: ids.length ? ids : null };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? `${err.name === "TimeoutError" ? "timed out" : ""} ${err.message}`.trim() : String(err) };
  }
}

export type QuickSetupResult =
  | { ok: true; profile: { id: string; title: string; model: string } }
  | { ok: false; kind: ModelErrorKind; detail: string };
