import { safeStorage } from "electron";
import path from "node:path";
import { Context } from "cordis";
import { CloudHub, EncryptedSessionStorage, type Cipher, type LocalAccounts } from "@tomradex/hub-cloud";
import { AccountFolders, machineRoots, restart } from "./accounts.js";

/**
 * Public Supabase client configuration for the production desktop build.
 * These values are intentionally safe to ship: authorization is enforced by
 * Supabase Auth + Postgres RLS, never by hiding this key.
 */
export const DEFAULT_SUPABASE_URL = "https://bgaifdfgysjnzlkybzrp.supabase.co";
export const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_g7evHCehq8PNxWiqLO1z5w_hzMgMGv-";
/** Hosts the pages that account emails link to; Supabase's Redirect URLs must allow them. */
export const DEFAULT_SITE = "https://tomrade.com";

/** Secrets stay in the main process; only account summaries cross IPC. */
export default function hubCloud(ctx: Context, config: { userData: string; url?: string; publishableKey?: string; site?: string }) {
  // Accept the Vite names as well so one deployment can share its Supabase
  // public configuration with the desktop shell. Explicit plugin config and
  // TOMRADE_* still take precedence over the production defaults.
  const url = config.url ?? process.env.TOMRADE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
  const publishableKey = config.publishableKey ?? process.env.TOMRADE_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_KEY ?? DEFAULT_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new Error("Configure both TOMRADE_SUPABASE_URL and TOMRADE_SUPABASE_PUBLISHABLE_KEY.");
  const cipher: Cipher = {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value)
  };
  const sessionStorage = new EncryptedSessionStorage(path.join(config.userData, "account.enc"), cipher);
  ctx.plugin(CloudHub, { url, publishableKey, sessionStorage, cacheFile: path.join(config.userData, "hub-cloud.json"), syncMs: 30_000, site: config.site ?? DEFAULT_SITE, accounts: accountsAt(config.userData, cipher) });
}

/** Another account signs in here by restarting into its own folders. A directory outside them keeps one account. */
function accountsAt(userData: string, cipher: Cipher): LocalAccounts | undefined {
  const folders = new AccountFolders(machineRoots());
  const here = folders.folderAt(userData);
  if (here === undefined) return undefined;
  return {
    elsewhere: id => folders.elsewhere(id, here),
    claim: user => folders.claim(user, here),
    open: async (user, session) => {
      const folder = folders.folderFor(user);
      new EncryptedSessionStorage(path.join(folders.dirs(folder).userData, "account.enc"), cipher).setItem(session.key, session.value);
      folders.activate(user, folder);
      // Let the reply reach the window before it closes.
      setTimeout(restart, 100);
    }
  };
}
