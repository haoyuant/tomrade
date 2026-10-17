import { en, zh, type PartialMessages } from "./i18n-messages";
import { de, es, fr, ja, zhHant } from "./i18n-messages/locales";

export type Locale = "en" | "zh" | "zh-Hant" | "ja" | "es" | "de" | "fr";

type Messages = typeof en;

/** One level of nesting only — `t("namespace.key")`. Keeps lookup and the key type simple. */
export type MessageKey = {
  [N in keyof Messages]: `${N & string}.${keyof Messages[N] & string}`;
}[keyof Messages];

/** English and Simplified Chinese are complete; the rest may miss a string, which then shows in English. */
export const DICTS: Record<Locale, PartialMessages> = { en, zh, "zh-Hant": zhHant, ja, es, de, fr };

export const isLocale = (locale: string): locale is Locale => locale in DICTS;

function lookupIn(dict: PartialMessages, path: string): string | undefined {
  const [ns, key] = path.split(".");
  const value = (dict as Record<string, Record<string, unknown>>)[ns]?.[key];
  return typeof value === "string" ? value : undefined;
}

/** A key missing from the locale falls back to English before falling back to the raw key. */
export const message = (locale: Locale, path: string): string => lookupIn(DICTS[locale], path) ?? lookupIn(DICTS.en, path) ?? path;

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(vars[name] ?? ""));
}

/** `t` without React: words for a given locale, as the dictionaries hold them. */
export const say = (locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string => interpolate(message(locale, key), vars);
