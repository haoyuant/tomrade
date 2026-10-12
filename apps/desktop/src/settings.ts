import { Context } from "cordis";
import Settings, { type SettingsConfig } from "@tomradex/settings";
import { safeCipher } from "./cipher.js";

/** Settings, with the API keys and tokens in settings.json sealed by the OS keychain. `keychain: false` keeps them as plain text. */
export default function settings(ctx: Context, config: Omit<SettingsConfig, "cipher"> & { keychain?: boolean }) {
  const { keychain = true, ...rest } = config;
  ctx.plugin(Settings, { ...rest, cipher: keychain ? safeCipher : undefined });
}
