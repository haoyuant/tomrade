import fs from "node:fs";
import path from "node:path";
import { geminiDir } from "./lend.js";

/** What gets Gemini CLI going for an individual since Google ended personal Google sign-in for it. */
export const GEMINI_SIGN_IN = "run `gemini`, enter /auth and choose Use Gemini API Key (or Vertex AI) — or connect a Gemini API key as a model under Settings → Assistant";

const readJson = (file: string): Record<string, any> | null => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>; } catch { return null; }
};
const hasKey = (file: string): boolean => {
  try { return /^\s*GEMINI_API_KEY\s*=\s*\S/m.test(fs.readFileSync(file, "utf8")); } catch { return false; }
};

/**
 * Whether Gemini CLI can sign in, from its own settings: a personal Google
 * sign-in (`oauth-personal` without a Cloud project) is refused by Google
 * ("no longer supported for Gemini Code Assist for individuals"); an API key
 * choice needs the key. null: nothing that says no (Vertex AI, a Cloud project).
 */
export function geminiCanSignIn(env: NodeJS.ProcessEnv = process.env, dir = geminiDir(env)): boolean | null {
  const type = readJson(path.join(dir, "settings.json"))?.security?.auth?.selectedType as string | undefined;
  const key = !!env.GEMINI_API_KEY?.trim() || hasKey(path.join(dir, ".env"));
  if (type === "oauth-personal") return env.GOOGLE_CLOUD_PROJECT?.trim() || env.GOOGLE_CLOUD_PROJECT_ID?.trim() ? null : false;
  if (type === "gemini-api-key") return key;
  if (!type) return key ? null : false;
  return null;
}
