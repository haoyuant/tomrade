import { safeStorage } from "electron";
import path from "node:path";
import { Context } from "cordis";
import { CloudHub, EncryptedSessionStorage } from "@tomrade/hub-cloud";

/**
 * Public Supabase client configuration for the production desktop build.
 * These values are intentionally safe to ship: authorization is enforced by
 * Supabase Auth + Postgres RLS, never by hiding this key.
 */
export const DEFAULT_SUPABASE_URL = "https://bgaifdfgysjnzlkybzrp.supabase.co";
export const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_g7evHCehq8PNxWiqLO1z5w_hzMgMGv-";

/** Secrets stay in the main process; only account summaries cross IPC. */
export default function hubCloud(ctx: Context, config: { userData: string; url?: string; publishableKey?: string }) {
  // Accept the Vite names as well so one deployment can share its Supabase
  // public configuration with the desktop shell. Explicit plugin config and
  // TOMRADE_* still take precedence over the production defaults.
  const url = config.url ?? process.env.TOMRADE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
  const publishableKey = config.publishableKey ?? process.env.TOMRADE_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_KEY ?? DEFAULT_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new Error("Configure both TOMRADE_SUPABASE_URL and TOMRADE_SUPABASE_PUBLISHABLE_KEY.");
  const sessionStorage = new EncryptedSessionStorage(path.join(config.userData, "account.enc"), {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value)
  });
  ctx.plugin(CloudHub, { url, publishableKey, sessionStorage, cacheFile: path.join(config.userData, "hub-cloud.json"), syncMs: 30_000 });
}
