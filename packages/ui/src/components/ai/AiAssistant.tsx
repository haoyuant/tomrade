import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { BTN, INPUT } from "~/lib/design-system";
import type { ChatTurn, ExtractCandidate, GapCandidate, ProviderConfig } from "@tomrade/core";

type Msg =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; kind: "text"; reply: string }
  | { id: number; role: "assistant"; kind: "tool"; tool: string; result: unknown; reply?: string }
  | { id: number; role: "assistant"; kind: "error"; error: string };

type Candidate = (ExtractCandidate & { key: string; reason?: string }) | (GapCandidate & { key: string });

let nextId = 1;

function ToolResult({ tool, result }: { tool: string; result: unknown }) {
  if (tool === "create_item" || tool === "update_item" || tool === "delete_item") {
    const item = result as { id?: string; title?: string; status?: string; deleted?: string } | null;
    return (
      <div className="rounded border border-emerald-800 bg-emerald-950/30 p-2 text-xs text-emerald-200">
        ✓ {tool === "create_item" ? `Created “${item?.title ?? ""}”` : tool === "delete_item" ? `Deleted ${item?.deleted ?? ""}` : `Updated → ${item?.status ?? ""}`}
      </div>
    );
  }
  if (tool === "list_items") {
    const items = Array.isArray(result) ? result : [];
    if (items.length === 0) return <div className="text-xs text-slate-400">No items found.</div>;
    return (
      <ul className="flex flex-col gap-1">
        {items.map((i) => {
          const it = i as { id: string; title: string; kind: string; status: string };
          return (
            <li key={it.id} className="rounded border border-slate-700 bg-slate-950/50 px-2 py-1 text-xs">
              <span className={cn("font-semibold uppercase", it.kind === "epic" ? "text-violet-400" : "text-sky-400")}>{it.kind}</span>
              {" "}<span className="text-slate-200">{it.title}</span>
              <span className="ml-1 text-slate-500">[{it.status}]</span>
            </li>
          );
        })}
      </ul>
    );
  }
  if (tool === "extract_tickets") {
    const items = Array.isArray(result) ? (result as ExtractCandidate[]) : [];
    return <CandidateList candidates={items.map((c, i) => ({ ...c, key: "e" + i }))} />;
  }
  if (tool === "gap_analysis") {
    const items = Array.isArray(result) ? (result as GapCandidate[]) : [];
    return <CandidateList candidates={items.map((g, i) => ({ ...g, key: "g" + i, reason: g.reason }))} />;
  }
  return <pre className="text-xs text-slate-400">{JSON.stringify(result, null, 2)}</pre>;
}

function CandidateList({ candidates }: { candidates: Candidate[] }) {
  const qc = useQueryClient();
  const [created, setCreated] = useState<Set<string>>(new Set());
  return (
    <ul className="flex flex-col gap-1.5">
      {candidates.map((c) => (
        <li key={c.key} className="rounded border border-slate-700 bg-slate-950/50 p-2">
          <div className="flex items-center gap-2">
            <span className={cn("text-[10px] font-semibold uppercase", c.kind === "epic" ? "text-violet-400" : "text-sky-400")}>{c.kind}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{c.title}</span>
            <button
              type="button"
              className="rounded bg-sky-600 px-2 py-0.5 text-[10px] text-white hover:bg-sky-500 disabled:opacity-50"
              disabled={created.has(c.key)}
              onClick={() => {
                void window.tomrade.aiCreateFromCandidate(c, null).then(() => {
                  setCreated((p) => new Set(p).add(c.key));
                  void qc.invalidateQueries({ queryKey: ["items"] });
                });
              }}
            >
              {created.has(c.key) ? "Created ✓" : "Create"}
            </button>
          </div>
          {c.reason && <p className="mt-1 text-[10px] text-emerald-400">gap: {c.reason}</p>}
        </li>
      ))}
    </ul>
  );
}

export function AiAssistant({ projectId }: { projectId?: string }) {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<ProviderConfig | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.tomrade.settingsGet().then(setSettings);
  }, []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    setInput("");
    const userMsg: Msg = { id: nextId++, role: "user", text };
    const history: ChatTurn[] = messages
      .filter((m): m is Extract<Msg, { role: "user" } | { role: "assistant" }> => true)
      .slice(-8)
      .map((m) => (m.role === "user" ? { role: "user" as const, content: m.text } : { role: "assistant" as const, content: "content" in m ? (m as { reply?: string }).reply ?? "" : "" }));
    setMessages((p) => [...p, userMsg]);
    setBusy(true);
    try {
      const res = await window.tomrade.aiChat(text, history, projectId);
      const assistantMsg: Msg =
        res.kind === "text"
          ? { id: nextId++, role: "assistant", kind: "text", reply: res.reply }
          : res.kind === "tool"
            ? { id: nextId++, role: "assistant", kind: "tool", tool: res.tool, result: res.result, reply: res.reply }
            : { id: nextId++, role: "assistant", kind: "error", error: res.error };
      setMessages((p) => [...p, assistantMsg]);
      void qc.invalidateQueries({ queryKey: ["items"] });
    } catch (e) {
      setMessages((p) => [...p, { id: nextId++, role: "assistant", kind: "error", error: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-slate-800 bg-slate-900">
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2.5">
        <h2 className="text-sm font-bold text-slate-100">✨ AI Assistant</h2>
        <details className="ml-auto text-[10px] text-slate-400">
          <summary className="cursor-pointer hover:text-slate-200">settings</summary>
          {settings && (
            <div className="absolute right-0 top-full z-10 flex w-72 flex-col gap-1.5 rounded border border-slate-700 bg-slate-900 p-2 shadow-xl">
              <input className={INPUT} value={settings.apiKey} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} placeholder="API key" />
              <input className={INPUT} value={settings.baseURL} onChange={(e) => setSettings({ ...settings, baseURL: e.target.value })} placeholder="Base URL" />
              <input className={INPUT} value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })} placeholder="Model" />
              <button type="button" className={cn(BTN.secondary, "text-xs")} onClick={() => void window.tomrade.settingsSet(settings)}>Save</button>
            </div>
          )}
        </details>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="text-xs text-slate-500">
            <p className="mb-2">I can operate Tomrade for you. Try:</p>
            <ul className="flex flex-col gap-1">
              <li>· "Show all doing tickets"</li>
              <li>· "Create a ticket: export reports as PDF"</li>
              <li>· "Move \"Export reports\" to done"</li>
              <li>· "Extract tickets from: (paste notes)"</li>
              <li>· "Find gaps for: recurring report scheduling"</li>
            </ul>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cn("max-w-[95%] rounded-lg px-3 py-2 text-sm", m.role === "user" ? "self-end bg-sky-600/80 text-white" : "self-start bg-slate-800 text-slate-200")}>
            {m.role === "user" ? m.text : m.kind === "text" ? m.reply : m.kind === "error" ? <span className="text-red-300">{m.error}</span> : (<><ToolResult tool={m.tool} result={m.result} />{m.reply && <p className="mt-1 text-xs text-slate-400">{m.reply}</p>}</>)}
          </div>
        ))}
        {busy && <div className="self-start rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-400">Thinking…</div>}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-center gap-2 border-t border-slate-800 p-3">
        <input
          className={cn(INPUT, "flex-1")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
          placeholder="Ask AI to operate Tomrade…"
        />
        <button type="button" className={BTN.primary} onClick={() => void send()} disabled={busy || !input.trim()}>Send</button>
      </div>
    </aside>
  );
}