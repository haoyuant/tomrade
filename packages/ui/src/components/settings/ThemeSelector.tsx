import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { MonitorIcon, MoonIcon, SunIcon } from "~/components/ui/icons.js";
import type { ThemePreference } from "@tomrade/core";

const OPTIONS: { value: ThemePreference; label: string; Icon: (p: { className?: string }) => ReactNode }[] = [
  { value: "system", label: "System", Icon: MonitorIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "light", label: "Light", Icon: SunIcon },
];

/**
 * Three-segment theme switcher. Clicking a segment applies the theme immediately
 * (persists via settingsSet; the app's settings query refetches and re-applies).
 */
export function ThemeSelector({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (t: ThemePreference) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-200/70 p-1 dark:bg-slate-800/70">
      {OPTIONS.map(({ value: v, label, Icon }) => {
        const active = value === v;
        return (
          <button
            key={v}
            type="button"
            title={label}
            onClick={() => onChange(v)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all",
              active
                ? "bg-white text-slate-900 shadow-sm dark:bg-slate-600 dark:text-white"
                : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}