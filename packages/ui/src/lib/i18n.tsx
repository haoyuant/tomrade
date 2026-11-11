import { createContext, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { languageTag, pickLanguage, type AppSettings, type Dictionaries, type LanguagePreference } from "@tomradex/domain";
import { keys, useSaveSettings, useSettings } from "./queries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, logQuietly } from "./api";
import { interpolate, loadLocale, message, setPackMessages, useLocaleWords, type BuiltinLocale, type Locale, type MessageKey } from "./dicts";
import { intlTag, setDomainLocale } from "./domain";
import { en } from "./i18n-messages";

export { intlTag };
import { shortcut } from "./keys";
import { announceKeymap, formatChord, isCommandId, primeKeymap, resolveKeymap, type Keymap } from "./keybindings";

export type { Locale, MessageKey };

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
  return withKeys(shortcut(message(locale, path)), map);
}

let activeLocale: Locale = "en";

/** `t` for words made outside a render — an error made readable — in the language showing now. */
export const translate = (key: MessageKey, vars?: Record<string, string | number>): string => interpolate(lookup(activeLocale, key), vars);

/** A language as Settings → Language lists it: its tag and its name in itself. */
export interface LanguageOption {
  tag: Locale;
  name: string;
}

/** The languages the interface ships, each named in its own script. */
const BUILTIN_LANGUAGES: { tag: BuiltinLocale; name: string }[] = [
  { tag: "en", name: "English" },
  { tag: "zh", name: "简体中文" },
  { tag: "zh-Hant", name: "繁體中文" },
  { tag: "ja", name: "日本語" },
  { tag: "es", name: "Español" },
  { tag: "de", name: "Deutsch" },
  { tag: "fr", name: "Français" },
  { tag: "ru", name: "Русский" }
];

/** The system's language among those there are — the shipped ones and any a pack added — else English. */
function detectSystemLocale(available: readonly Locale[] = BUILTIN_LANGUAGES.map((l) => l.tag)): Locale {
  return pickLanguage((typeof navigator !== "undefined" && navigator.language) || "en", available) ?? "en";
}

// The language most windows open in, asked for while the settings are still on their way.
loadLocale(detectSystemLocale()).catch(() => {});

function resolveLocale(preference: LanguagePreference, available?: readonly Locale[]): Locale {
  return preference === "system" ? detectSystemLocale(available) : languageTag(preference);
}

/** Languages installed packs add; a pack for a shipped language keeps the shipped name. */
function useLanguages(): { options: LanguageOption[]; packs: Set<string> } {
  const packs = useQuery({ queryKey: keys.languages, queryFn: () => invoke("settings.languages"), enabled: typeof window !== "undefined" && !!window.tomrade, staleTime: Infinity }).data;
  return useMemo(() => {
    const shipped = new Set<string>(BUILTIN_LANGUAGES.map((l) => l.tag));
    const added = (packs ?? []).filter((p) => !shipped.has(p.tag)).map(({ tag, name }) => ({ tag, name }));
    return { options: [...BUILTIN_LANGUAGES, ...added], packs: new Set((packs ?? []).map((p) => p.tag)) };
  }, [packs]);
}

interface I18nContextValue {
  /** What the user chose — 'system' included. */
  preference: LanguagePreference;
  /** What is actually showing right now. */
  locale: Locale;
  /** Every language there is to choose: the shipped ones, then those packs add. */
  languages: LanguageOption[];
  setPreference: (p: LanguagePreference) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Like `t`, but vars may be React nodes — for sentences that embed a `<span>` or similar. */
  tx: (key: MessageKey, vars?: Record<string, ReactNode>) => ReactNode;
}

const fallback: I18nContextValue = {
  preference: "system",
  locale: "en",
  languages: BUILTIN_LANGUAGES,
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
  const languages = useLanguages();
  const locale = resolveLocale(preference, [...languages.options.map((l) => l.tag), ...languages.packs]);
  // A pack's words come from the main process, which read them from the plugin; English shows until they arrive.
  const packTag = languages.packs.has(locale) ? locale : null;
  const pack = useQuery({ queryKey: keys.languagePack(packTag), queryFn: () => invoke("settings.languagePack", packTag!), enabled: !!packTag, staleTime: Infinity }).data;
  setPackMessages(packTag, pack?.tag === packTag ? (pack?.ui ?? null) : null);
  // A shipped language other than English and Simplified Chinese arrives on first use: a new t once it has.
  const words = useLocaleWords(locale);
  // What a pack translates is measured against this English; the main process keeps it for plugin_check.
  useEffect(() => {
    if (typeof window !== "undefined" && window.tomrade) void invoke("settings.uiEnglish", en as Dictionaries).catch(logQuietly("settings.uiEnglish"));
  }, []);
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
  if (typeof document !== "undefined") document.documentElement.lang = intlTag(locale);

  // `pack` stands for the words setPackMessages took in: a new t once they arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const t = useCallback((key: MessageKey, vars?: Record<string, string | number>) => interpolate(lookup(locale, key, map), vars), [locale, map, pack, words]);

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
    // as with t: `pack` stands for the words setPackMessages took in
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, map, pack, words]
  );

  const setPreference = useCallback(
    (next: LanguagePreference) => {
      const current = qc.getQueryData<AppSettings>(keys.settings);
      if (!current) return;
      save.mutate({ ...current, language: next });
    },
    [qc, save]
  );

  const value = useMemo(() => ({ preference, locale, languages: languages.options, setPreference, t, tx }), [preference, locale, languages.options, setPreference, t, tx]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The app's words in one given language, for a window that reads no settings of its own (the Terminal window):
 * what calls `useI18n` under it speaks that language, with the default keys.
 */
export function LocaleWords({ locale, children }: { locale: Locale; children: ReactNode }) {
  const words = useLocaleWords(locale);
  const value = useMemo((): I18nContextValue => {
    const t = (key: MessageKey, vars?: Record<string, string | number>) => interpolate(lookup(locale, key), vars);
    return { ...fallback, locale, t, tx: (key, vars) => t(key, vars as Record<string, string | number> | undefined) };
    // `words` stands for a shipped language's words arriving: a new t once they have
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, words]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
