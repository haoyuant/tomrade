import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { RETIRED_THEMES, THEME_TYPOGRAPHY_NAMES, THEME_TOKEN_NAMES, type AppSettings, type BuiltInTheme, type CustomTheme, type ThemeAutomation, type ThemePreference } from "@tomradex/domain";
import { useQueryClient } from "@tanstack/react-query";
import { keys, useSaveSettings, useSettings } from "./queries";
import { useI18n, type MessageKey } from "./i18n";
import { sendSurfaceLook } from "./surface-look";
import { backdropFills } from "@tomradex/theme-image/colors";
import { useThemeImageUrl } from "./theme-image";
import { useFrosted } from "./frost";

export type ResolvedTheme = BuiltInTheme;
export const BUILT_IN_THEME_OPTIONS: { value: BuiltInTheme; labelKey: MessageKey; icon: "i-sun" | "i-moon" | "i-leaf" | "i-stack" | "i-monitor" }[] = [
  { value: "sunrise", labelKey: "theme.sunrise", icon: "i-sun" }, { value: "daybreak", labelKey: "theme.daybreak", icon: "i-moon" }, { value: "glass", labelKey: "theme.glass", icon: "i-stack" },
  { value: "sakura", labelKey: "theme.sakura", icon: "i-leaf" },
  { value: "dawn", labelKey: "theme.dawn", icon: "i-sun" },
  { value: "light", labelKey: "theme.paper", icon: "i-sun" }, { value: "dark", labelKey: "theme.ink", icon: "i-moon" }, { value: "matcha", labelKey: "theme.matcha", icon: "i-leaf" }
];
/** Built-ins offered by the command palette; automatic switching lives in Appearance settings. */
export const THEME_OPTIONS = BUILT_IN_THEME_OPTIONS;
const AUTOMATION_DEFAULT: ThemeAutomation = { mode: "none", defaultTheme: "sunrise", schedule: [], shuffleMinutes: 60 };

interface ThemeContext {
  preference: ThemePreference;
  theme: ResolvedTheme;
  customThemes: CustomTheme[];
  automation: ThemeAutomation;
  setPreference: (p: Exclude<ThemePreference, "system">) => void;
  setAutomation: (next: ThemeAutomation) => void;
  createCustomTheme: (onCreated?: (theme: CustomTheme) => void) => void;
  /** Deletes the theme and returns the way back: the theme at its place, with the preference and automation that named it. */
  deleteCustomTheme: (id: string) => () => void;
}
const Ctx = createContext<ThemeContext>({ preference: "sunrise", theme: "sunrise", customThemes: [], automation: AUTOMATION_DEFAULT, setPreference: () => {}, setAutomation: () => {}, createCustomTheme: () => {}, deleteCustomTheme: () => () => {} });
const mq = () => window.matchMedia("(prefers-color-scheme: dark)");

export function cssColorToHex(value: string): string {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d"); if (!context) return "#000000";
  context.fillStyle = value; context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}
const choices = (themes: CustomTheme[]): Exclude<ThemePreference, "system">[] => ["sunrise", "daybreak", "glass", "sakura", "dawn", "light", "dark", "matcha", ...themes.map(theme => theme.id)];
function activePreference(manual: ThemePreference, automation: ThemeAutomation, themes: CustomTheme[], now = new Date()): Exclude<ThemePreference, "system"> {
  const fallback = choices(themes).includes(automation.defaultTheme) ? automation.defaultTheme : "sunrise";
  if (automation.mode === "none") return manual === "system" ? fallback : manual;
  if (automation.mode === "system") return mq().matches ? "dark" : "light";
  if (automation.mode === "schedule") {
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    return automation.schedule.find(rule => {
      const end = rule.end ?? "23:59";
      return rule.start < end ? time >= rule.start && time < end : time >= rule.start || time < end;
    })?.theme ?? fallback;
  }
  const interval = automation.shuffleMinutes * 60_000;
  const bucket = Math.floor(now.getTime() / interval);
  const pool = choices(themes);
  return pool[Math.abs((bucket * 1103515245 + 12345) | 0) % pool.length] ?? fallback;
}
function resolve(preference: Exclude<ThemePreference, "system">, customThemes: CustomTheme[]): { base: BuiltInTheme; custom?: CustomTheme } {
  // A retired built-in still named by a setting saved before it went paints as the one closest to it.
  const builtIn = (name: string) => RETIRED_THEMES[name] ?? name as BuiltInTheme;
  if (preference.startsWith("custom:")) { const custom = customThemes.find(theme => theme.id === preference); return custom ? { base: builtIn(custom.base), custom } : { base: "sunrise" }; }
  return { base: builtIn(preference) };
}
const BACKDROP_VARS = ["backdrop-image", "backdrop-shell", "backdrop-pane", "backdrop-tile", "backdrop-float"];
function paint(base: BuiltInTheme, custom: CustomTheme | undefined, animate: boolean, picture: string | null): void {
  const root = document.documentElement, id = custom?.id ?? base;
  if (animate && root.dataset.themeId !== id) root.classList.add("theme-transition");
  root.classList.remove("dark", "matcha", "dawn", "sunrise", "daybreak", "glass", "sakura", "backdrop"); if (base !== "light") root.classList.add(base);
  for (const name of [...THEME_TOKEN_NAMES, ...THEME_TYPOGRAPHY_NAMES, ...BACKDROP_VARS]) root.style.removeProperty(`--${name}`);
  if (custom) for (const [name, value] of Object.entries({ ...custom.tokens, ...custom.fonts })) root.style.setProperty(`--${name}`, value);
  // Without its picture on this machine, the theme is its colours on solid panes.
  if (custom?.backdrop && picture) {
    root.classList.add("backdrop");
    root.style.setProperty("--backdrop-image", `url("${picture}")`);
    for (const [name, value] of Object.entries(backdropFills(custom.tokens, custom.backdrop.veil))) root.style.setProperty(`--${name}`, value);
  }
  root.dataset.themeId = id; if (animate) window.setTimeout(() => root.classList.remove("theme-transition"), 650);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const settings = useSettings(), save = useSaveSettings(), qc = useQueryClient();
  const preference = settings.data?.theme ?? "sunrise";
  const customThemes = useMemo(() => (settings.data?.customThemes ?? []) as CustomTheme[], [settings.data?.customThemes]);
  const automation = useMemo(() => ({ ...AUTOMATION_DEFAULT, ...((settings.data?.themeAutomation ?? {}) as Partial<ThemeAutomation>) }), [settings.data?.themeAutomation]);
  const performanceMode = settings.data?.performanceMode === true;
  // Decorative motion reads this off <html>; the stylesheets stop it.
  useEffect(() => { document.documentElement.toggleAttribute("data-performance", performanceMode); }, [performanceMode]);
  const unifiedSky = settings.data?.unifiedSky === true;
  useEffect(() => { document.documentElement.toggleAttribute("data-unified-sky", unifiedSky); }, [unifiedSky]);
  const [clock, setClock] = useState(0);
  const active = activePreference(preference, automation, customThemes);
  const resolved = resolve(active, customThemes);
  const [theme, setTheme] = useState<ResolvedTheme>(resolved.base);
  const { locale, t } = useI18n();
  const picture = useFrosted(useThemeImageUrl(resolved.custom?.backdrop ? resolved.custom.id : null), resolved.custom?.backdrop?.frost ?? 0);
  useEffect(() => {
    const apply = () => { const next = resolve(activePreference(preference, automation, customThemes), customThemes); setTheme(next.base); paint(next.base, next.custom, true, picture); };
    apply();
  }, [preference, customThemes, automation, active, picture]);
  // Plugin windows match the app: told after each paint, and when the language changes.
  const backdrop = resolved.custom?.backdrop;
  useEffect(() => sendSurfaceLook(document.documentElement.dataset.themeId ?? theme, locale, theme === "glass", backdrop && { veil: backdrop.veil, frost: backdrop.frost ?? 0, terminalVeil: backdrop.terminalVeil }),
    [active, customThemes, locale, theme, backdrop]);
  useEffect(() => {
    if (automation.mode === "none") return;
    const refresh = () => setClock(value => value + 1);
    const media = mq();
    media.addEventListener("change", refresh);
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 1000);
    return () => {
      window.clearInterval(timer);
      media.removeEventListener("change", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [automation.mode]);
  const mutate = useCallback((patch: Partial<AppSettings>) => { const current = qc.getQueryData<AppSettings>(keys.settings); if (current) save.mutate({ ...current, ...patch }); }, [qc, save]);
  const setPreference = useCallback((next: Exclude<ThemePreference, "system">) => mutate({ theme: next, themeAutomation: { ...automation, mode: "none" } }), [mutate, automation]);
  const setAutomation = useCallback((next: ThemeAutomation) => mutate({ themeAutomation: next }), [mutate]);
  const createCustomTheme = useCallback((onCreated?: (theme: CustomTheme) => void) => {
    const styles = getComputedStyle(document.documentElement), id = `custom:${crypto.randomUUID()}` as const;
    const tokens = Object.fromEntries(THEME_TOKEN_NAMES.map(name => [name, cssColorToHex(styles.getPropertyValue(`--${name}`).trim())]));
    const fonts = Object.fromEntries(THEME_TYPOGRAPHY_NAMES.map(name => [name, styles.getPropertyValue(`--${name}`).trim()]));
    const created = { id, name: t("settingsDialog.customThemeName", { n: customThemes.length + 1 }), base: resolved.base, icon: "i-sliders", tokens, fonts } as CustomTheme;
    const current = qc.getQueryData<AppSettings>(keys.settings);
    if (current) save.mutate({ ...current, theme: id, themeAutomation: { ...automation, mode: "none" }, customThemes: [...customThemes, created] }, { onSuccess: () => onCreated?.(created) });
  }, [customThemes, qc, save, resolved.base, automation, t]);
  const deleteCustomTheme = useCallback((id: string) => {
    const fallback = automation.defaultTheme === id ? "sunrise" : automation.defaultTheme;
    const schedule = automation.schedule.filter(rule => rule.theme !== id);
    mutate({ customThemes: customThemes.filter(theme => theme.id !== id), theme: preference === id ? fallback : preference, themeAutomation: { ...automation, defaultTheme: fallback, schedule } });
    const index = customThemes.findIndex(theme => theme.id === id), deleted = customThemes[index];
    return () => {
      if (!deleted) return;
      // Themes made since the delete stay; only the deleted one returns to its place.
      const rest = ((qc.getQueryData<AppSettings>(keys.settings)?.customThemes ?? []) as CustomTheme[]).filter(theme => theme.id !== id);
      mutate({ customThemes: [...rest.slice(0, index), deleted, ...rest.slice(index)], theme: preference, themeAutomation: automation });
    };
  }, [automation, customThemes, mutate, preference, qc]);
  const value = useMemo(() => ({ preference: active, theme, customThemes, automation, setPreference, setAutomation, createCustomTheme, deleteCustomTheme }), [active, theme, customThemes, automation, setPreference, setAutomation, createCustomTheme, deleteCustomTheme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useTheme = () => useContext(Ctx);
