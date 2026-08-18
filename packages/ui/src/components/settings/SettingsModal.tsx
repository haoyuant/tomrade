import { useEffect, useState } from "react";
import { BTN, INPUT } from "~/lib/design-system";
import type { AppSettings, ThemePreference } from "@tomrade/core";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.tomrade.settingsGet().then(setSettings);
  }, []);

  const save = async () => {
    if (!settings) return;
    setError(null);
    try {
      await window.tomrade.settingsSet(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Settings</h2>
          <button type="button" onClick={onClose} className="ml-auto text-slate-500 dark:text-slate-400 hover:text-slate-200">✕</button>
        </div>

        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-500">Appearance</h3>
        {settings && (
          <div className="flex flex-col gap-1">
            {(["system", "dark", "light"] as ThemePreference[]).map((t) => (
              <label key={t} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="radio"
                  name="theme"
                  checked={settings.theme === t}
                  onChange={() => setSettings({ ...settings, theme: t })}
                />
                {t === "system" ? "Follow system" : t === "dark" ? "Dark" : "Light"}
              </label>
            ))}
          </div>
        )}

        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-500">LLM</h3>
        {settings && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              API key
              <input className={INPUT} value={settings.llm.apiKey} onChange={(e) => setSettings({ ...settings, llm: { ...settings.llm, apiKey: e.target.value } })} placeholder="sk-…" type="password" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              Base URL
              <input className={INPUT} value={settings.llm.baseURL} onChange={(e) => setSettings({ ...settings, llm: { ...settings.llm, baseURL: e.target.value } })} placeholder="https://api.deepseek.com" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              Model
              <input className={INPUT} value={settings.llm.model} onChange={(e) => setSettings({ ...settings, llm: { ...settings.llm, model: e.target.value } })} placeholder="deepseek-chat" />
            </label>
            <p className="text-[10px] text-slate-600 dark:text-slate-600">OpenAI-compatible endpoints work: DeepSeek, OpenAI, OpenRouter, local (Ollama)…</p>
          </div>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {saved && <span className="text-xs text-emerald-400">Saved ✓</span>}
          <button type="button" className={BTN.secondary} onClick={onClose}>Close</button>
          <button type="button" className={BTN.primary} onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  );
}