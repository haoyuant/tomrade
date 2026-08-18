import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { BTN, INPUT } from "~/lib/design-system";
import type { ExtractCandidate, GapCandidate, ProviderConfig } from "@tomrade/core";

type Mode = "extract" | "gap";
type Candidate = ExtractCandidate & { reason?: string; isDuplicate?: boolean; dupReason?: string } & { key: string };

export function AiPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("extract");
  const [text, setText] = useState("");
  const [settings, setSettings] = useState<ProviderConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [created, setCreated] = useState<Set<string>>(new Set());
  const [parentId, setParentId] = useState("");
  const [epics, setEpics] = useState<{ id: string; title: string }[]>([]);

  useEffect(() => {
    void window.tomrade.settingsGet().then(setSettings);
  }, []);

  const run = async () => {
    if (!text.trim()) return;
    setRunning(true);
    setError(null);
    setCandidates([]);
    try {
      if (mode === "extract") {
        const res = await window.tomrade.aiExtract(text);
        const all = await window.tomrade.list();
        setEpics(all.filter((i) => i.kind === "epic").map((e) => ({ id: e.id, title: e.title })));
        setCandidates(res.candidates.map((c, i) => {
          const d = res.dedup[i];
          return {
            ...c,
            key: "c" + i,
            isDuplicate: d?.isDuplicate,
            dupReason: d?.duplicates?.map((x) => x.reason).join("; ")
          };
        }));
      } else {
        const gaps = await window.tomrade.aiGap(text);
        setCandidates(gaps.map((g, i) => ({ ...g, key: "g" + i })));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const createOne = async (c: Candidate) => {
    await window.tomrade.aiCreateFromCandidate(c, parentId || null);
    setCreated((prev) => new Set(prev).add(c.key));
    void qc.invalidateQueries({ queryKey: ["items"] });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-100">✨ AI Backlog Assistant</h2>
          <div className="flex gap-1">
            {([["extract", "Extract tickets"], ["gap", "Find gaps"]] as [Mode, string][]).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "rounded px-2 py-1 text-xs",
                  mode === m ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-200">✕</button>
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto p-5">
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-400 hover:text-slate-200">LLM settings</summary>
            {settings && (
              <div className="mt-2 grid grid-cols-1 gap-2">
                <input className={INPUT} value={settings.apiKey} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} placeholder="API key" />
                <div className="grid grid-cols-2 gap-2">
                  <input className={INPUT} value={settings.baseURL} onChange={(e) => setSettings({ ...settings, baseURL: e.target.value })} placeholder="Base URL (e.g. https://api.deepseek.com)" />
                  <input className={INPUT} value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })} placeholder="Model (e.g. deepseek-chat)" />
                </div>
                <button type="button" className={cn(BTN.secondary, "w-fit")} onClick={() => window.tomrade.settingsSet(settings)}>Save settings</button>
              </div>
            )}
          </details>

          <textarea
            className={cn(INPUT, "min-h-32 font-mono text-xs")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={mode === "extract" ? "Paste a conversation or requirement notes…" : "State the requirement to check gaps against the backlog…"}
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button type="button" className={cn(BTN.primary, "w-fit")} onClick={() => void run()} disabled={running || !text.trim()}>
            {running ? "Analyzing…" : "Analyze"}
          </button>

          {candidates.length > 0 && (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Parent epic (for created items)
                <select className={INPUT} value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">(none)</option>
                  {epics.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
                </select>
              </label>
              {candidates.map((c) => (
                <div key={c.key} className="rounded border border-slate-700 bg-slate-950/50 p-3">
                  <div className="flex items-center gap-2">
                    <span className={cn("text-[10px] font-semibold uppercase", c.kind === "epic" ? "text-violet-400" : "text-sky-400")}>{c.kind}</span>
                    <span className="text-sm text-slate-200">{c.title}</span>
                    {c.isDuplicate && <span className="text-[10px] text-amber-400">⚠ dup: {c.dupReason}</span>}
                    <button
                      type="button"
                      className={cn(BTN.primary, "ml-auto !px-2 !py-1 text-xs")}
                      disabled={created.has(c.key)}
                      onClick={() => void createOne(c)}
                    >
                      {created.has(c.key) ? "Created ✓" : "Create"}
                    </button>
                  </div>
                  {c.body && <p className="mt-1 text-xs text-slate-400">{c.body}</p>}
                  {c.reason && <p className="mt-1 text-[10px] text-emerald-400">gap: {c.reason}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}