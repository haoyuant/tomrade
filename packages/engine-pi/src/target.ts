import type { ModelProfile } from "@tomradex/llm";

/** Endpoints pi has a provider for, and the variable that provider reads its key from. */
const KNOWN: Record<string, { provider: string; env: string }> = {
  "api.anthropic.com": { provider: "anthropic", env: "ANTHROPIC_API_KEY" },
  "api.deepseek.com": { provider: "deepseek", env: "DEEPSEEK_API_KEY" },
  "api.openai.com": { provider: "openai", env: "OPENAI_API_KEY" },
  "openrouter.ai": { provider: "openrouter", env: "OPENROUTER_API_KEY" },
  "api.moonshot.ai": { provider: "moonshotai", env: "MOONSHOT_API_KEY" },
  "api.moonshot.cn": { provider: "moonshotai-cn", env: "MOONSHOT_API_KEY" },
  "generativelanguage.googleapis.com": { provider: "google", env: "GEMINI_API_KEY" }
};

// Where a profile without its own address talks, by its provider.
const DEFAULT_BASE: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  kimi: "https://api.moonshot.cn/v1",
  openrouter: "https://openrouter.ai/api/v1"
};
// pi's API for each provider it can drive. Any other (a plugin's) talks a wire of its own, and its key must not go to an address pi guesses.
const PI_API: Record<string, string> = {
  "openai-compatible": "openai-completions",
  openai: "openai-completions",
  deepseek: "openai-completions",
  kimi: "openai-completions",
  openrouter: "openai-completions",
  anthropic: "anthropic-messages",
  gemini: "google-generative-ai"
};

/** Whether pi has an API for the profile's provider. */
export const piSpeaks = (provider: string): boolean => Object.hasOwn(PI_API, provider);

/** Every known provider's variable, so one listing shows the whole catalog. */
export const CATALOG_ENV: Record<string, string> = Object.fromEntries(Object.values(KNOWN).map(({ env }) => [env, "catalog"]));

/** What pi is started with for one profile: the `--model` id and the key, which only ever travels in the environment. */
export interface PiTarget {
  model: string;
  env: Record<string, string>;
}

function hostOf(profile: ModelProfile): string {
  try {
    return new URL(profile.baseURL || DEFAULT_BASE[profile.provider] || "https://api.deepseek.com").host;
  } catch {
    return "";
  }
}

const customProvider = (profile: ModelProfile): string => `tomrade-${profile.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
const keyVariable = (profile: ModelProfile): string => `TOMRADE_KEY_${profile.id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;

/**
 * Profiles pi can talk to: a chat endpoint it has an API for, and a model that calls tools itself —
 * pi has no way to render tools into the prompt, which the loop does for `promptTools`.
 */
export const usableProfile = (profile: ModelProfile): boolean =>
  piSpeaks(profile.provider) && (profile.provider !== "anthropic" || !!profile.apiKey) && !profile.promptTools;

/**
 * A known endpoint whose model pi's catalog lists runs as that provider, so pi
 * keeps what it knows about the model (context, thinking, images); anything
 * else runs as a provider of its own from models.json.
 */
export function piTarget(profile: ModelProfile, catalog: ReadonlySet<string>): PiTarget {
  const known = KNOWN[hostOf(profile)];
  if (known && catalog.has(`${known.provider}/${profile.model}`)) {
    return { model: `${known.provider}/${profile.model}`, env: profile.apiKey ? { [known.env]: profile.apiKey } : {} };
  }
  return { model: `${customProvider(profile)}/${profile.model}`, env: profile.apiKey ? { [keyVariable(profile)]: profile.apiKey } : {} };
}

/**
 * pi's models.json: one provider per profile, its key named by variable so it
 * is never written to disk. A local endpoint gets a stand-in key, which pi
 * needs before it lists a model.
 */
export function modelsFile(profiles: ModelProfile[]): { providers: Record<string, unknown> } {
  const providers: Record<string, unknown> = {};
  for (const profile of profiles.filter(usableProfile)) {
    const images = profile.inputModalities?.includes("image") ?? profile.provider === "anthropic";
    providers[customProvider(profile)] = {
      baseUrl: profile.baseURL || DEFAULT_BASE[profile.provider] || "https://api.deepseek.com",
      api: PI_API[profile.provider],
      apiKey: profile.apiKey ? `$${keyVariable(profile)}` : "none",
      models: [{ id: profile.model, name: profile.title || profile.model, input: images ? ["text", "image"] : ["text"] }]
    };
  }
  return { providers };
}
