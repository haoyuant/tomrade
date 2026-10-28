import type { RunView, TokenBreakdown } from "@tomradex/agent";
import type { useI18n } from "~/lib/i18n";

/** Token counts a person can skim: 962, 1.2k, 12k, 999k, then 1.0M — never "1000k". */
export const tokens = (n: number): string => {
  if (n < 1_000) return String(n);
  if (n < 9_950) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 999_500) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

/** A finished run's tokens, split the same way Settings → Usage adds them up. */
export const runTokensLabel = (t: Translate, run: RunView): string | null => (run.tokens ? tokensLabel(t, run.tokens) : null);

/** Tokens while they still add up: in and out, as the working line shows them. */
export const liveTokens = (k: { inputTokens: number; outputTokens: number }): string => `↑${tokens(k.inputTokens)} ↓${tokens(k.outputTokens)} tok`;

/** Tokens split the same way Settings → Usage adds them up. */
export const tokensLabel = (t: Translate, k: TokenBreakdown): string =>
  k.cacheReadTokens + k.cacheWriteTokens > 0
    ? t("agentPanel.tokensSplit", { input: tokens(k.inputTokens), uncached: tokens(k.uncachedInputTokens), read: tokens(k.cacheReadTokens), write: tokens(k.cacheWriteTokens), output: tokens(k.outputTokens) })
    : t("agentPanel.tokensNew", { input: tokens(k.inputTokens), output: tokens(k.outputTokens) });

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
