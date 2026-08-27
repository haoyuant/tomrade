import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatTurn, Item } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { Spacer } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { invalidateWorkspace } from "~/lib/queries";
import { useQueryClient } from "@tanstack/react-query";

const MIN_W = 352;
const MAX_W = 616;
const STORE = { open: "tomrade.ai.open", width: "tomrade.ai.width" };

interface Turn {
  role: "user" | "assistant";
  content: string;
  /** The tool call resolves before the answer does, so it is what a pending turn shows. */
  trace?: string;
  tool?: { name: string; rows: { title: string; key?: string }[] };
  error?: string;
  pending?: boolean;
}

function ToolCard({ tool }: { tool: NonNullable<Turn["tool"]> }) {
  return (
    <div className="tool-card">
      <div className="tool-head">
        <Icon name="i-search" size={12} />
        {tool.name}
      </div>
      {tool.rows.map((r, i) => (
        <div className="tool-row" key={i}>
          <span className="t-title">{r.title}</span>
          {r.key && <span className="card-id">{r.key}</span>}
        </div>
      ))}
    </div>
  );
}

function toRows(result: unknown): { title: string; key?: string }[] {
  if (!Array.isArray(result)) return [];
  return result.slice(0, 6).map((r) => {
    const row = r as Partial<Item>;
    return { title: row.title ?? String(r), key: row.key };
  });
}

export interface AiScope {
  projectId: string;
  /** What the assistant can see, printed on the context chip. */
  label: string;
  /** The tool call a question resolves through, printed on the pending turn. */
  trace: string;
  placeholder: string;
}

export function AiPanel({ open, onToggle, scope }: { open: boolean; onToggle: (open: boolean) => void; scope: AiScope }) {
  const qc = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([
    {
      role: "assistant",
      content:
        "I can read this board and write to it over the same path your CLI agents use. Every write I make is recorded as ai:mcp in the oplog and stays undoable."
    }
  ]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem(STORE.width);
    if (saved && panel.current) panel.current.style.width = `${saved}px`;
  }, [open]);

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [turns]);

  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = panel.current?.offsetWidth ?? MIN_W;
    document.body.style.userSelect = "none";
    const onMove = (e: MouseEvent) => {
      const width = Math.min(MAX_W, Math.max(MIN_W, startW + (startX - e.clientX)));
      if (panel.current) panel.current.style.width = `${width}px`;
      localStorage.setItem(STORE.width, String(width));
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const send = async () => {
    const text = draft.trim();
    if (!text || pending) return;
    const history: ChatTurn[] = turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content }));
    const trace = scope.trace;
    setTurns((all) => [...all, { role: "user", content: text }, { role: "assistant", content: "", trace, pending: true }]);
    setDraft("");
    setPending(true);
    try {
      const result = await invoke("assistant.chat", text, history, scope.projectId);
      setTurns((all) => {
        const next = [...all];
        const last = next.length - 1;
        if (result.kind === "text") next[last] = { role: "assistant", content: result.reply };
        else if (result.kind === "tool")
          next[last] = { role: "assistant", content: result.reply ?? "", trace: result.tool, tool: { name: `tomrade.${result.tool}`, rows: toRows(result.result) } };
        else next[last] = { role: "assistant", content: "", trace: result.tool, error: result.error };
        return next;
      });
      if (result.kind === "tool") invalidateWorkspace(qc, scope.projectId);
    } catch (err) {
      setTurns((all) => {
        const next = [...all];
        next[next.length - 1] = { role: "assistant", content: "", error: err instanceof Error ? err.message : String(err) };
        return next;
      });
    } finally {
      setPending(false);
      // the composer was disabled mid-turn, which dropped focus to <body>
      composer.current?.focus();
    }
  };

  if (!open) {
    return (
      <div className="ai-rail">
        <button
          type="button"
          className="btn btn-icon"
          title="Expand assistant — ⌘J"
          aria-label="Expand assistant panel"
          onClick={() => onToggle(true)}
        >
          <Icon name="i-panel" size={15} />
        </button>
        <span className="ai-rail-label">Assistant</span>
      </div>
    );
  }

  return (
    <aside className="ai" ref={panel}>
      <div className="ai-resize" title="Drag to resize" onMouseDown={startResize} />
      <div className="ai-head">
        <h2 style={{ fontSize: "var(--text-base)" }}>Assistant</h2>
        <span className="tag faint" title="What the assistant can see">
          {scope.label}
        </span>
        <Spacer />
        <button
          type="button"
          className="btn btn-icon"
          title="Collapse panel — ⌘J"
          aria-label="Collapse assistant panel"
          onClick={() => onToggle(false)}
        >
          <Icon name="i-panel" size={15} />
        </button>
      </div>

      <div className="ai-scroll" ref={scroll} role="log" aria-live="polite" aria-busy={pending}>
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div className="turn turn-user" key={i}>
              <span className="turn-rule" />
              <p>{turn.content}</p>
            </div>
          ) : (
            <div className="turn turn-ai" key={i}>
              <div className="turn-mark">
                <span className="prov-tick" style={{ height: 12 }} />
              </div>
              <div className="turn-body">
                {turn.trace && <p className="turn-think">{turn.trace}</p>}
                {turn.pending && <p className="ai-pending" style={{ marginTop: 6 }}>Reading the board…</p>}
                {turn.error && <p className="ai-error" style={{ marginTop: 6 }}>{turn.error}</p>}
                {turn.tool && <ToolCard tool={turn.tool} />}
                {turn.content && <p style={{ marginTop: turn.trace || turn.tool ? "var(--space-3)" : 0 }}>{turn.content}</p>}
              </div>
            </div>
          )
        )}
      </div>

      {/* held, not frozen: the composer stays readable and says why it is busy */}
      <div className="ai-foot">
        <input
          ref={composer}
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={scope.placeholder}
          aria-label="Message the assistant"
          value={draft}
          disabled={pending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => void send()}>
          Send
        </button>
      </div>
    </aside>
  );
}

export const aiOpenDefault = () => localStorage.getItem(STORE.open) !== "0";
export const persistAiOpen = (open: boolean) => localStorage.setItem(STORE.open, open ? "1" : "0");
