import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppSettings, ThemePreference } from "@tomrade/domain";
import { keys, useSaveSettings, useSettings } from "./queries";
import { useQueryClient } from "@tanstack/react-query";

export type ResolvedTheme = "light" | "dark" | "matcha";

interface ThemeContext {
  /** What the user chose — 'system' included. */
  preference: ThemePreference;
  /** What is on screen right now. */
  theme: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
}

const Ctx = createContext<ThemeContext>({ preference: "system", theme: "light", setPreference: () => {} });

const mq = () => window.matchMedia("(prefers-color-scheme: dark)");
const resolve = (p: ThemePreference): ResolvedTheme => (p === "system" ? (mq().matches ? "dark" : "light") : p);

/** Paper is the only light mode; Ink and Matcha are both dark. */
export const THEME_OPTIONS: { value: ThemePreference; label: string; icon: "i-monitor" | "i-sun" | "i-moon" | "i-leaf" }[] = [
  { value: "system", label: "System", icon: "i-monitor" },
  { value: "light", label: "Paper", icon: "i-sun" },
  { value: "dark", label: "Ink", icon: "i-moon" },
  { value: "matcha", label: "Matcha", icon: "i-leaf" }
];

function paint(next: ResolvedTheme, animate: boolean): void {
  const root = document.documentElement;
  if (root.classList.contains(next) || (next === "light" && !root.classList.contains("dark") && !root.classList.contains("matcha"))) {
    animate = false;
  }
  if (animate) root.classList.add("theme-transition");
  root.classList.remove("dark", "matcha");
  if (next !== "light") root.classList.add(next);
  if (animate) window.setTimeout(() => root.classList.remove("theme-transition"), 650);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const preference = settings.data?.theme ?? "system";
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolve(preference));

  // Repaint on preference change, and follow the OS while the preference is 'system'.
  useEffect(() => {
    const apply = (animate: boolean) => {
      const next = resolve(preference);
      setTheme(next);
      paint(next, animate);
    };
    apply(true);
    if (preference !== "system") return;
    const listener = () => apply(true);
    const media = mq();
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [preference]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      const current = qc.getQueryData<AppSettings>(keys.settings);
      if (!current) return;
      save.mutate({ ...current, theme: next });
    },
    [qc, save]
  );

  const value = useMemo(() => ({ preference, theme, setPreference }), [preference, theme, setPreference]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
