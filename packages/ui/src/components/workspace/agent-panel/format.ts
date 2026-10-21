import type { RunView } from "@tomradex/agent";
import type { useI18n } from "~/lib/i18n";

export const tokens = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** A finished run's tokens, split the same way Settings → Usage adds them up. */
export const runTokensLabel = (t: Translate, run: RunView): string | null => {
  const k = run.tokens;
  if (!k) return null;
  return k.cacheReadTokens + k.cacheWriteTokens > 0
    ? t("agentPanel.tokensSplit", { input: tokens(k.inputTokens), uncached: tokens(k.uncachedInputTokens), read: tokens(k.cacheReadTokens), write: tokens(k.cacheWriteTokens), output: tokens(k.outputTokens) })
    : t("agentPanel.tokensNew", { input: tokens(k.inputTokens), output: tokens(k.outputTokens) });
};

export type Translate = ReturnType<typeof useI18n>["t"];

export const duration = (t: Translate, ms: number) => {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? t("agentPanel.secondsShort", { n: secs }) : t("agentPanel.minSecShort", { m: Math.floor(secs / 60), s: String(secs % 60).padStart(2, "0") });
};

/** Engines say why a request failed in English; the common causes read in the person's language. */
export const retryReason = (t: Translate, reason: string) => {
  if (reason === "connection dropped") return t("agentPanel.reasonDropped");
  const silent = /^no response in (\d+)s$/.exec(reason);
  return silent ? t("agentPanel.reasonNoResponse", { s: silent[1] }) : reason;
};
