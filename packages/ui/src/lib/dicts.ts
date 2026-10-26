import { useEffect, useState } from "react";
import { usableWords, type Dictionaries } from "@tomradex/domain";
import { en, zh, type PartialMessages } from "./i18n-messages";

/** The languages the interface ships. */
export type BuiltinLocale = "en" | "zh" | "zh-Hant" | "ja" | "es" | "de" | "fr" | "ru";

/** A language tag: one the interface ships, or one an installed language pack adds. */
export type Locale = string;

type Messages = typeof en;

/** One level of nesting only — `t("namespace.key")`. Keeps lookup and the key type simple. */
export type MessageKey = {
  [N in keyof Messages]: `${N & string}.${keyof Messages[N] & string}`;
}[keyof Messages];

/**
 * The other shipped languages, loaded the first time one shows: together they weigh as much as the interface's own
 * code, and a window carries only the language it speaks. Until it arrives, English.
 */
const LATER: Record<Exclude<BuiltinLocale, "en" | "zh">, () => Promise<PartialMessages>> = {
  "zh-Hant": () => import("./i18n-messages/locales/zhHant").then((m) => m.zhHant),
  ja: () => import("./i18n-messages/locales/ja").then((m) => m.ja),
  es: () => import("./i18n-messages/locales/es").then((m) => m.es),
  de: () => import("./i18n-messages/locales/de").then((m) => m.de),
  fr: () => import("./i18n-messages/locales/fr").then((m) => m.fr),
  ru: () => import("./i18n-messages/locales/ru").then((m) => m.ru)
};

/** English and Simplified Chinese are complete and always here; the rest may miss a string, which then shows in English. */
const DICTS: Partial<Record<BuiltinLocale, PartialMessages>> = { en, zh };
const loading = new Map<string, Promise<void>>();

export const isBuiltinLocale = (locale: string): locale is BuiltinLocale => Object.hasOwn(DICTS, locale) || Object.hasOwn(LATER, locale);

/** Whether a language's shipped words are here; true for a tag the app does not ship, which has none to wait for. */
export const localeLoaded = (locale: Locale): boolean => !Object.hasOwn(LATER, locale) || !!DICTS[locale as BuiltinLocale];

/** Brings a shipped language's words; resolves at once when they are here or there are none to bring. */
export function loadLocale(locale: Locale): Promise<void> {
  if (localeLoaded(locale)) return Promise.resolve();
  let pending = loading.get(locale);
  if (!pending) {
    const tag = locale as keyof typeof LATER;
    pending = LATER[tag]().then((words) => void (DICTS[tag] = words));
    // A failed load is tried again the next time the language is asked for.
    pending.catch(() => loading.delete(locale));
    loading.set(locale, pending);
  }
  return pending;
}

/** Renders again once the language's words have arrived: the number moves when they do. */
export function useLocaleWords(locale: Locale): number {
  const [arrived, setArrived] = useState(0);
  const here = localeLoaded(locale);
  useEffect(() => {
    if (here) return;
    let live = true;
    loadLocale(locale).then(
      () => live && setArrived((n) => n + 1),
      () => {}
    );
    return () => {
      live = false;
    };
  }, [locale, here]);
  return arrived;
}

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
