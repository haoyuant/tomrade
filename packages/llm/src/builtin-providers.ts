import { AnthropicModel } from "./anthropic.js";
import { detectCapabilities, type ModelCapabilities } from "./capabilities.js";
import { bareModel, GEMINI_BASE, GeminiModel } from "./gemini.js";
import { ImagesModel } from "./images.js";
import { OpenAiCompatible } from "./openai.js";
import { deepseekKey, deepseekProvider } from "./search/deepseek.js";
import { kimiKey, kimiProvider } from "./search/kimi.js";
import type { ModelProviderSpec } from "./provider.js";
import { guessFrom, listModels, usableModels, type ProviderPreset } from "./providers.js";

// a catch-all profile without an address talks here, as profiles always have
const COMPATIBLE_BASE = "https://api.deepseek.com";

/** Chat/completions and the APIs that copy it, at any address: local servers, proxies, vendors without a provider of their own. */
export const OPENAI_COMPATIBLE: ModelProviderSpec = {
  id: "openai-compatible",
  title: { en: "OpenAI-compatible", zh: "兼容 OpenAI" },
  keyRequired: false,
  baseURL: { default: COMPATIBLE_BASE, editable: true },
  chat: true,
  presets: [
    {
      id: "ollama", title: "Ollama", baseURL: "http://127.0.0.1:11434/v1", model: "", prefer: [/qwen/, /llama/, /deepseek/], local: true,
      hint: { en: "Models running on this computer: free, no key, needs a capable machine", zh: "在这台电脑上运行模型：免费、不用 Key，需要电脑性能够" }
    }
  ],
  list: (endpoint, timeoutMs) => listModels({ provider: "openai-compatible", baseURL: endpoint.baseURL || COMPATIBLE_BASE }, endpoint.apiKey, timeoutMs),
  usable: (listed) => usableModels("openai-compatible", listed),
  defaultInput: [],
  capabilities: (model, listed) => detectCapabilities("openai-compatible", model, listed),
  build: (p) => new OpenAiCompatible({ baseURL: p.baseURL ?? COMPATIBLE_BASE, apiKey: p.apiKey, model: p.model, inputModalities: p.inputModalities, outputModalities: p.outputModalities })
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/**
 * A service on the chat/completions wire with a provider of its own: the
 * compatible adapter at its address, and the catch-all profiles saved at one
 * of its hosts, which move to it with their address kept.
 */
function compatibleService(spec: Pick<ModelProviderSpec, "id" | "title" | "presets"> & { baseURL: string; hosts: string[] }): ModelProviderSpec {
  return {
    id: spec.id,
    title: spec.title,
    keyRequired: true,
    baseURL: { default: spec.baseURL, editable: true },
    chat: true,
    presets: spec.presets,
    list: (endpoint, timeoutMs) => listModels({ provider: "openai-compatible", baseURL: endpoint.baseURL || spec.baseURL }, endpoint.apiKey, timeoutMs),
    usable: (listed) => usableModels("openai-compatible", listed),
    defaultInput: [],
    capabilities: (model, listed) => detectCapabilities("openai-compatible", model, listed),
    claims: (p) => (p.provider === "openai-compatible" && spec.hosts.includes(hostOf(p.baseURL || COMPATIBLE_BASE)) ? { ...p, provider: spec.id, baseURL: p.baseURL || COMPATIBLE_BASE } : undefined),
    build: (p) => new OpenAiCompatible({ baseURL: p.baseURL || spec.baseURL, apiKey: p.apiKey, model: p.model, inputModalities: p.inputModalities, outputModalities: p.outputModalities })
  };
}

/** DeepSeek's models, with its Responses search on the models that have it and its Search API for the rest. */
export const DEEPSEEK = compatibleService({
  id: "deepseek",
  title: { en: "DeepSeek", zh: "DeepSeek" },
  baseURL: "https://api.deepseek.com",
  hosts: ["api.deepseek.com"],
  presets: [
    {
      id: "deepseek", title: "DeepSeek", baseURL: "https://api.deepseek.com", model: "deepseek-flash", prefer: [/flash/, /^deepseek-v\d/],
      keyPage: "https://platform.deepseek.com/api_keys", env: "DEEPSEEK_API_KEY", keyShapes: [/^sk-[0-9a-f]{32}$/],
      hint: { en: "Low pay-as-you-go prices; reachable from mainland China", zh: "按量付费、价格低，国内可直连" },
      search: (profiles) => deepseekProvider({ id: "deepseek", key: () => deepseekKey(profiles()) })
    }
  ]
});

/** Moonshot's Kimi models, with Kimi's search service. */
export const KIMI = compatibleService({
  id: "kimi",
  title: { en: "Kimi", zh: "Kimi" },
  baseURL: "https://api.moonshot.cn/v1",
  hosts: ["api.moonshot.cn", "api.moonshot.ai"],
  presets: [
    {
      id: "kimi", title: "Kimi", baseURL: "https://api.moonshot.cn/v1", model: "", prefer: [/^kimi-k\d/],
      keyPage: "https://platform.moonshot.cn/console/api-keys", env: "MOONSHOT_API_KEY", keyShapes: [/^sk-[A-Za-z0-9]{40,}$/],
      hint: { en: "Moonshot's Kimi models; reachable from mainland China", zh: "月之暗面 Kimi 模型，国内可直连" },
      search: (profiles) => kimiProvider({ id: "kimi", key: () => kimiKey(profiles()) })
    }
  ]
});

/** OpenAI's GPT models, searching the web on the Responses API. */
export const OPENAI = compatibleService({
  id: "openai",
  title: { en: "OpenAI", zh: "OpenAI" },
  baseURL: "https://api.openai.com/v1",
  hosts: ["api.openai.com"],
  presets: [
    {
      id: "openai", title: "OpenAI", baseURL: "https://api.openai.com/v1", model: "", prefer: [/^gpt-\d+(\.\d+)?$/],
      keyPage: "https://platform.openai.com/api-keys", env: "OPENAI_API_KEY", keyShapes: [/^sk-(proj|svcacct|admin)-/, /^sk-[A-Za-z0-9]{40,}$/],
      hint: { en: "GPT models, from a paid OpenAI API account", zh: "GPT 模型，需要付费的 OpenAI API 账户" }
    }
  ]
});

/** One key for many vendors' models. */
export const OPENROUTER = compatibleService({
  id: "openrouter",
  title: { en: "OpenRouter", zh: "OpenRouter" },
  baseURL: "https://openrouter.ai/api/v1",
  hosts: ["openrouter.ai"],
  presets: [
    {
      id: "openrouter", title: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", model: "", prefer: [/^anthropic\/claude-sonnet-/, /^deepseek\/deepseek-chat/],
      keyPage: "https://openrouter.ai/keys", env: "OPENROUTER_API_KEY", keyShapes: [/^sk-or-/],
      hint: { en: "One key for models from many providers", zh: "一个 Key 用多家的模型" }
    }
  ]
});

/** Anthropic's Messages API, or a proxy of it. */
export const ANTHROPIC: ModelProviderSpec = {
  id: "anthropic",
  title: { en: "Anthropic", zh: "Anthropic" },
  keyRequired: true,
  baseURL: { default: "https://api.anthropic.com", editable: false },
  chat: true,
  presets: [
    {
      id: "anthropic", title: "Anthropic", baseURL: "", model: "", prefer: [/^claude-sonnet-/],
      keyPage: "https://console.anthropic.com/settings/keys", env: "ANTHROPIC_API_KEY", keyShapes: [/^sk-ant-/],
      hint: { en: "Claude models, from a paid Anthropic API account", zh: "Claude 模型，需要付费的 Anthropic API 账户" }
    }
  ],
  list: (endpoint, timeoutMs) => listModels({ provider: "anthropic", baseURL: endpoint.baseURL ?? "" }, endpoint.apiKey, timeoutMs),
  usable: (listed) => usableModels("anthropic", listed),
  defaultInput: ["image", "pdf"],
  capabilities: (model, listed) => detectCapabilities("anthropic", model, listed),
  build: (p) => new AnthropicModel({ apiKey: p.apiKey, model: p.model, baseURL: p.baseURL, inputModalities: p.inputModalities })
};

/** GPT Image and compatible Images APIs. */
export const OPENAI_IMAGES: ModelProviderSpec = {
  id: "openai-images",
  title: { en: "OpenAI Images API (generate / edit)", zh: "OpenAI 图像接口（生成 / 编辑）" },
  keyRequired: false,
  baseURL: { default: "https://api.openai.com/v1", editable: true },
  chat: false,
  presets: [],
  list: (endpoint, timeoutMs) => listModels({ provider: "openai-compatible", baseURL: endpoint.baseURL || "https://api.openai.com/v1" }, endpoint.apiKey, timeoutMs),
  usable: (listed) => usableModels("openai-images", listed),
  defaultInput: [],
  capabilities: (model, listed) => detectCapabilities("openai-images", model, listed),
  build: (p) => new ImagesModel({ baseURL: p.baseURL ?? "https://api.openai.com/v1", apiKey: p.apiKey, model: p.model })
};

const GEMINI_MEDIA: ModelCapabilities = { inputModalities: ["image", "pdf", "audio", "video"], outputModalities: [] };
// Google's OpenAI-compatible endpoint, where Gemini profiles were saved before Gemini had its own provider.
const GEMINI_COMPATIBLE = /^https?:\/\/generativelanguage\.googleapis\.com\/v1beta\/openai\/?$/i;

/** Gemini on Google's own API: Google Search beside function tools, thinking levels, its own listing. */
export const GEMINI: ModelProviderSpec = {
  id: "gemini",
  title: { en: "Google Gemini", zh: "Google Gemini" },
  keyRequired: true,
  baseURL: { default: GEMINI_BASE, editable: false },
  chat: true,
  presets: [
    {
      id: "gemini", title: "Google Gemini", baseURL: "", model: "", prefer: [/^gemini-\d+(\.\d+)?-flash$/, /^gemini-\d+(\.\d+)?-pro$/],
      keyPage: "https://aistudio.google.com/apikey", env: "GEMINI_API_KEY", keyShapes: [/^AIza[0-9A-Za-z_-]{35}$/, /^AQ\.[0-9A-Za-z_.-]{40,}$/],
      hint: { en: "Gemini models with a Google AI Studio key; a free tier to start", zh: "用 Google AI Studio 的 Key 跑 Gemini 模型，有免费额度" }
    }
  ],
  list: async (endpoint, timeoutMs) => {
    const out = await listModels({ provider: "gemini", baseURL: endpoint.baseURL || GEMINI_BASE }, endpoint.apiKey, timeoutMs);
    if (!out.ok) return out;
    return { ok: true, models: out.models?.map(bareModel) ?? null, capabilities: Object.fromEntries(Object.entries(out.capabilities).map(([id, caps]) => [bareModel(id), caps])) };
  },
  // Gemini first, newest first, then Gemma; image-making models stay with the compatible endpoint, which asks for their output
  usable: (listed) => usableModels("gemini", listed).filter((id) => !/-image(-preview)?$|banana/.test(id)).sort((a, b) => Number(b.startsWith("gemini-")) - Number(a.startsWith("gemini-")) || b.localeCompare(a, "en", { numeric: true })),
  defaultInput: GEMINI_MEDIA.inputModalities,
  capabilities: (model, listed) => listed ?? (/^gemini-/.test(bareModel(model)) ? GEMINI_MEDIA : undefined),
  // a profile that makes images stays where its image output works
  claims: (p) => (p.provider === "openai-compatible" && GEMINI_COMPATIBLE.test(p.baseURL ?? "") && !p.outputModalities?.length ? { ...p, provider: "gemini", baseURL: undefined, model: bareModel(p.model) } : undefined),
  build: (p) => new GeminiModel({ apiKey: p.apiKey, model: p.model, baseURL: p.baseURL, inputModalities: p.inputModalities })
};

/** The app's own providers, in the order the profile form lists them. */
export const BUILTIN_PROVIDERS: ModelProviderSpec[] = [OPENAI_COMPATIBLE, ANTHROPIC, GEMINI, DEEPSEEK, KIMI, OPENAI, OPENROUTER, OPENAI_IMAGES];

/** Every built-in preset with the provider that serves it. */
export const PROVIDERS: ProviderPreset[] = BUILTIN_PROVIDERS.flatMap((spec) => spec.presets.map((preset) => ({ ...preset, provider: spec.id })));

/** Which built-in presets a pasted key most likely belongs to, most likely first; empty when it could be anyone's. */
export const guessProviders = (key: string): string[] => guessFrom(PROVIDERS, key);
