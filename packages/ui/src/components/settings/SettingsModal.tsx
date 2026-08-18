import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BTN, INPUT } from "~/lib/design-system";
import { CloseIcon, SettingsIcon } from "~/components/ui/icons.js";
import { ThemeSelector } from "./ThemeSelector.js";
import type { AppSettings } from "@tomrade/core";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.tomrade.settingsGet().then(setSettings);
  }, []);

  const persist = async (next: AppSettings, showSaved = true) => {
    setError(null);
    try {
      await window.tomrade.settingsSet(next);
      if (showSaved) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      // refetch so the app re-applies theme immediately
      void qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const changeTheme = (t: AppSettings["theme"]) => {
    if (!settings) return;
    const next = { ...settings, theme: t };
    setSettings(next);
    void persist(next, false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="flex w-full max-w-md flex-col gap-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <SettingsIcon className="h-4 w-4 text-slate-500 dark:text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Settings</h2>
          <button type="button" onClick={onClose} className="ml-auto text-slate-400 transition-colors hover:text-slate-700 dark:hover:text-slate-200" title="Close">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Appearance</h3>
          {settings && <ThemeSelector value={settings.theme} onChange={changeTheme} />}
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">LLM</h3>
          {settings && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-400">
                API key
                <input className={INPUT} value={settings.llm.apiKey} onChange={(e) => setSettings({ ...settings, llm: { ...settings.llm, apiKey: e.target.value } })} placeholder="sk-…" type="password" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-400">
                Base URL
                <input className={INPUT} value={settings.llm.baseURL} onChange={(e) => setSettings({ ...settings, llm: { ...settings.llm, baseURL: e.target.value } })} placeholder="https://api.deepseek.com" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-400">
                Model
                <input className={INPUT} value={settings.llm.model} onChange={(e) => setSettings({ ...settings, llm: { ...settings.llm, model: e.target.value } })} placeholder="deepseek-chat" />
              </label>
              <p className="text-[10px] text-slate-500 dark:text-slate-500">OpenAI-compatible endpoints work: DeepSeek, OpenAI, OpenRouter, local (Ollama)…</p>
            </div>
          )}
        </section>

        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {saved && <span className="text-xs text-emerald-500 dark:text-emerald-400">Saved ✓</span>}
          <button type="button" className={BTN.secondary} onClick={onClose}>Close</button>
          <button type="button" className={BTN.primary} onClick={() => settings && void persist(settings)}>Save</button>
        </div>
      </div>
    </div>
  );
}