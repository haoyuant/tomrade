import { createContext, Fragment, useCallback, useContext, useLayoutEffect, useMemo, type ReactNode } from "react";
import type { AppSettings, LanguagePreference } from "@tomradex/domain";
import { keys, useSaveSettings, useSettings } from "./queries";
import { useQueryClient } from "@tanstack/react-query";
import { en, zh, type PartialMessages } from "./i18n-messages";
import { de, es, fr, ja, zhHant } from "./i18n-messages/locales";
import { INTL_TAG, setDomainLocale } from "./domain";

export { INTL_TAG };
import { shortcut } from "./keys";
import { announceKeymap, formatChord, isCommandId, primeKeymap, resolveKeymap, type Keymap } from "./keybindings";

export type Locale = "en" | "zh" | "zh-Hant" | "ja" | "es" | "de" | "fr";

type Messages = typeof en;

/** One level of nesting only — `t("namespace.key")`. Keeps lookup and the key type simple. */
export type MessageKey = {
  [N in keyof Messages]: `${N & string}.${keyof Messages[N] & string}`;
}[keyof Messages];

/** English and Simplified Chinese are complete; the rest may miss a string, which then shows in English. */
const DICTS: Record<Locale, PartialMessages> = { en, zh, "zh-Hant": zhHant, ja, es, de, fr };

function lookupIn(dict: PartialMessages, path: string): string | undefined {
  const [ns, key] = path.split(".");
  const value = (dict as Record<string, Record<string, unknown>>)[ns]?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * A message names a command's keys as [[cmd:<id>]], filled from the person's
 * keymap; a command they unbound drops out, with the " — " that introduced it.
 */
function withKeys(text: string, map: Keymap): string {
  return text.replace(/( — )?\[\[cmd:(\w+)\]\]/g, (whole, lead: string | undefined, id: string) => {
    const chord = isCommandId(id) ? map[id][0] : undefined;
    return chord ? `${lead ?? ""}${formatChord(chord)}` : lead ? "" : "—";
  });
}

const DEFAULT_KEYMAP = resolveKeymap(undefined);

/** A key missing from the active locale falls back to English before falling back to the raw key. Shortcuts are written for this platform. */
function lookup(locale: Locale, path: string, map: Keymap = DEFAULT_KEYMAP): string {
  return withKeys(shortcut(lookupIn(DICTS[locale], path) ?? lookupIn(DICTS.en, path) ?? path), map);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(vars[name] ?? ""));
}

let activeLocale: Locale = "en";

/** `t` for words made outside a render — an error made readable — in the language showing now. */
export const translate = (key: MessageKey, vars?: Record<string, string | number>): string => interpolate(lookup(activeLocale, key), vars);

export function detectSystemLocale(): Locale {
  const tag = ((typeof navigator !== "undefined" && navigator.language) || "en").toLowerCase();
  if (tag.startsWith("zh")) return /^zh-(hant|tw|hk|mo)/.test(tag) ? "zh-Hant" : "zh";
  const base = tag.split("-")[0];
  return base === "ja" || base === "es" || base === "de" || base === "fr" ? base : "en";
}

export function resolveLocale(preference: LanguagePreference): Locale {
  return preference === "system" ? detectSystemLocale() : preference;
}

export const LANGUAGE_OPTIONS: { value: LanguagePreference; labelKey?: MessageKey; literal?: string }[] = [
  { value: "system", labelKey: "common.system" },
  { value: "en", literal: "English" },
  { value: "zh", literal: "简体中文" },
  { value: "zh-Hant", literal: "繁體中文" },
  { value: "ja", literal: "日本語" },
  { value: "es", literal: "Español" },
  { value: "de", literal: "Deutsch" },
  { value: "fr", literal: "Français" }
];

interface I18nContextValue {
  /** What the user chose — 'system' included. */
  preference: LanguagePreference;
  /** What is actually showing right now. */
  locale: Locale;
  setPreference: (p: LanguagePreference) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Like `t`, but vars may be React nodes — for sentences that embed a `<span>` or similar. */
  tx: (key: MessageKey, vars?: Record<string, ReactNode>) => ReactNode;
}

const fallback: I18nContextValue = {
  preference: "system",
  locale: "en",
  setPreference: () => {},
  t: (key, vars) => interpolate(lookup("en", key), vars),
  tx: (key, vars) => interpolate(lookup("en", key), vars as Record<string, string | number> | undefined)
};

const Ctx = createContext<I18nContextValue>(fallback);

export function I18nProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const preference = settings.data?.language ?? "system";
  const locale = resolveLocale(preference);
  // The keymap rides on the settings this provider already reads: every label naming a key follows a rebinding.
  const overrides = (settings.data?.keybindings as { overrides?: Record<string, string[]> } | undefined)?.overrides;
  const overridesKey = JSON.stringify(overrides ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const map = useMemo(() => resolveKeymap(overrides), [overridesKey]);
  primeKeymap(map);
  useLayoutEffect(announceKeymap, [map]);

  // Keeps ~/lib/domain's mutable label tables (status, priority, group, provenance, relative
  // time…) in step with the active locale before children read them this render — cheaper
  // than threading a locale prop through every call site that formats one of those strings.
  setDomainLocale(locale);
  activeLocale = locale;
  if (typeof document !== "undefined") document.documentElement.lang = INTL_TAG[locale];

  const t = useCallback((key: MessageKey, vars?: Record<string, string | number>) => interpolate(lookup(locale, key, map), vars), [locale, map]);

  const tx = useCallback(
    (key: MessageKey, vars?: Record<string, ReactNode>): ReactNode => {
      const template = lookup(locale, key, map);
      if (!vars) return template;
      const parts = template.split(/(\{\{\s*\w+\s*\}\})/g);
      return parts.map((part, i) => {
        const m = /^\{\{\s*(\w+)\s*\}\}$/.exec(part);
        if (m) return <Fragment key={i}>{vars[m[1]] ?? ""}</Fragment>;
        return part ? <Fragment key={i}>{part}</Fragment> : null;
      });
    },
    [locale, map]
  );

  const setPreference = useCallback(
    (next: LanguagePreference) => {
      const current = qc.getQueryData<AppSettings>(keys.settings);
      if (!current) return;
      save.mutate({ ...current, language: next });
    },
    [qc, save]
  );

  const value = useMemo(() => ({ preference, locale, setPreference, t, tx }), [preference, locale, setPreference, t, tx]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
