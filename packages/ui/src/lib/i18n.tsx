import { createContext, Fragment, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { AppSettings, LanguagePreference } from "@tomradex/domain";
import { keys, useSaveSettings, useSettings } from "./queries";
import { useQueryClient } from "@tanstack/react-query";
import { en, zh } from "./i18n-messages";
import { setDomainLocale } from "./domain";

export type Locale = "en" | "zh";

type Messages = typeof en;

/** One level of nesting only — `t("namespace.key")`. Keeps lookup and the key type simple. */
export type MessageKey = {
  [N in keyof Messages]: `${N & string}.${keyof Messages[N] & string}`;
}[keyof Messages];

const DICTS: Record<Locale, Messages> = { en, zh };

function lookupIn(dict: Messages, path: string): string | undefined {
  const [ns, key] = path.split(".");
  const value = (dict as Record<string, Record<string, unknown>>)[ns]?.[key];
  return typeof value === "string" ? value : undefined;
}

/** A key missing from the active locale falls back to English before falling back to the raw key. */
function lookup(locale: Locale, path: string): string {
  return lookupIn(DICTS[locale], path) ?? lookupIn(DICTS.en, path) ?? path;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(vars[name] ?? ""));
}

export function detectSystemLocale(): Locale {
  const tag = (typeof navigator !== "undefined" && navigator.language) || "en";
  return tag.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function resolveLocale(preference: LanguagePreference): Locale {
  return preference === "system" ? detectSystemLocale() : preference;
}

export const LANGUAGE_OPTIONS: { value: LanguagePreference; labelKey?: MessageKey; literal?: string }[] = [
  { value: "system", labelKey: "common.system" },
  { value: "en", literal: "English" },
  { value: "zh", literal: "中文" }
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

  // Keeps ~/lib/domain's mutable label tables (status, priority, group, provenance, relative
  // time…) in step with the active locale before children read them this render — cheaper
  // than threading a locale prop through every call site that formats one of those strings.
  setDomainLocale(locale);
  if (typeof document !== "undefined") document.documentElement.lang = locale;

  const t = useCallback((key: MessageKey, vars?: Record<string, string | number>) => interpolate(lookup(locale, key), vars), [locale]);

  const tx = useCallback(
    (key: MessageKey, vars?: Record<string, ReactNode>): ReactNode => {
      const template = lookup(locale, key);
      if (!vars) return template;
      const parts = template.split(/(\{\{\s*\w+\s*\}\})/g);
      return parts.map((part, i) => {
        const m = /^\{\{\s*(\w+)\s*\}\}$/.exec(part);
        if (m) return <Fragment key={i}>{vars[m[1]] ?? ""}</Fragment>;
        return part ? <Fragment key={i}>{part}</Fragment> : null;
      });
    },
    [locale]
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
