import { usableWords, type Dictionaries } from "@tomradex/domain";
import { en, zh, type PartialMessages } from "./i18n-messages";
import { de, es, fr, ja, ru, zhHant } from "./i18n-messages/locales";

/** The languages the interface ships. */
export type BuiltinLocale = "en" | "zh" | "zh-Hant" | "ja" | "es" | "de" | "fr" | "ru";

/** A language tag: one the interface ships, or one an installed language pack adds. */
export type Locale = string;

type Messages = typeof en;

/** One level of nesting only — `t("namespace.key")`. Keeps lookup and the key type simple. */
export type MessageKey = {
  [N in keyof Messages]: `${N & string}.${keyof Messages[N] & string}`;
}[keyof Messages];

/** English and Simplified Chinese are complete; the rest may miss a string, which then shows in English. */
const DICTS: Record<BuiltinLocale, PartialMessages> = { en, zh, "zh-Hant": zhHant, ja, es, de, fr, ru };

export const isBuiltinLocale = (locale: string): locale is BuiltinLocale => Object.hasOwn(DICTS, locale);

/** The showing language's pack, if it has one: only entries English has, asking for the values its template does. */
let pack: { tag: string; ui: Dictionaries; messages: PartialMessages } | null = null;

/** The words a language pack brings for the interface, or none. A pack speaks before the language's own built-in words. */
export function setPackMessages(tag: string | null, ui: Dictionaries | null): void {
  if (pack?.tag === tag && pack.ui === ui) return;
  pack = tag && ui ? { tag, ui, messages: usableWords(en as Dictionaries, ui) as PartialMessages } : null;
}

function lookupIn(dict: PartialMessages | undefined, path: string): string | undefined {
  const [ns, key] = path.split(".");
  const value = (dict as Record<string, Record<string, unknown>> | undefined)?.[ns]?.[key];
  return typeof value === "string" ? value : undefined;
}

/** A key missing from the locale falls back to English before falling back to the raw key. */
export const message = (locale: Locale, path: string): string =>
  (pack?.tag === locale ? lookupIn(pack.messages, path) : undefined) ?? (isBuiltinLocale(locale) ? lookupIn(DICTS[locale], path) : undefined) ?? lookupIn(DICTS.en, path) ?? path;

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(vars[name] ?? ""));
}

/** `t` without React: words for a given locale, as the dictionaries hold them. */
export const say = (locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string => interpolate(message(locale, key), vars);
