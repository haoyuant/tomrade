import { useCallback, useEffect, useRef, useState } from "react";
import type { Block, PendingView, RunView, ThreadMessage } from "@tomrade/agent";
import { Icon } from "~/components/icons";
import { Spacer } from "~/components/ui/atoms";
import { Menu, MenuActionItem, MenuHead, MenuRadioItem } from "~/components/ui/menu";
import { useAgentEvents, useAgentThread, useAgentThreads, useAnswer, useCancelRun, useEngines, useNewThread, useRevertRun, useSend, useSetEngine } from "~/lib/agent";

const MIN_W = 352;
const MAX_W = 616;
const STORE = { open: "tomrade.ai.open", width: "tomrade.ai.width", thread: (projectId: string) => `tomrade.agent.thread.${projectId}` };

const ago = (at: number): string => {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

function Trace({ block }: { block: Block & { type: "trace" } }) {
  return (
    <details className="trace-row">
      <summary>
        <Icon name={block.ok ? "i-check" : "i-warn"} size={11} />
        <span className="t-tool num">{block.tool}</span>
        <span className="t-sum">{block.summary}</span>
        {block.ms > 0 && <span className="t-ms num">{block.ms < 1000 ? `${block.ms}ms` : `${(block.ms / 1000).toFixed(1)}s`}</span>}
      </summary>
      <pre>{JSON.stringify(block.args, null, 2)}</pre>
    </details>
  );
}

function CardBlock({ block }: { block: Block & { type: "card" } }) {
  const data = block.data;
  const rows: [string, string][] =
    data && typeof data === "object" && !Array.isArray(data)
      ? Object.entries(data as Record<string, unknown>)
          .filter(([, v]) => v !== "" && v != null && !(Array.isArray(v) && v.length === 0))
          .map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" · ") : String(v)])
      : [["value", JSON.stringify(data)]];
  return (
    <div className="tool-card">
      <div className="tool-head">
        <Icon name="i-stack" size={12} />
        {block.title}
      </div>
      {rows.slice(0, 12).map(([k, v]) => (
        <div className="tool-row" key={k}>
          <span className="card-id">{k}</span>
          <span className="t-title" title={v}>
            {v.length > 160 ? v.slice(0, 160) + "…" : v}
          </span>
        </div>
      ))}
    </div>
  );
}

function Question({ block, pending, onAnswer, busy }: { block: Block & { type: "question" }; pending: PendingView | null; onAnswer: (id: string, value: string) => void; busy: boolean }) {
  const live = pending?.question.id === block.id;
  return (
    <div className="q-block">
      <p>{block.text}</p>
      {block.options && (
        <div className="chips">
          {block.options.map((option) => (
            <button key={option} type="button" className="chip-opt" disabled={!live || busy} onClick={() => onAnswer(block.id, option)}>
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RunFoot({ block, run, onRevert, busy }: { block: Block & { type: "changes" }; run: RunView | undefined; onRevert: (runId: string) => void; busy: boolean }) {
  const meta = run ? [run.engine, run.costUsd != null ? `$${run.costUsd.toFixed(3)}` : null].filter(Boolean).join(" · ") : "";
  return (
    <div className="run-foot">
      {run?.reverted ? (
        <span className="rf-note">
          Reverted{run.keptOnRevert > 0 ? ` · kept ${run.keptOnRevert}` : ""}
        </span>
      ) : (
        <>
          <span className="rf-note">
            Changed <span className="num">{block.count}</span> item{block.count === 1 ? "" : "s"}
          </span>
          <button type="button" className="btn btn-ghost rf-btn" disabled={busy} onClick={() => onRevert(block.runId)}>
            <Icon name="i-undo" size={12} /> Revert
          </button>
        </>
      )}
      {meta && <span className="rf-meta num">{meta}</span>}
    </div>
  );
}

function Row({ m, runs, pending, onAnswer, onRevert, busy }: { m: ThreadMessage; runs: Map<string, RunView>; pending: PendingView | null; onAnswer: (id: string, value: string) => void; onRevert: (runId: string) => void; busy: boolean }) {
  const b = m.block;
  if (m.role === "user") {
    return (
      <div className="turn turn-user">
        <span className="turn-rule" />
        <p>{b.type === "text" ? b.text : ""}</p>
      </div>
    );
  }
  if (b.type === "note") return <p className="agent-note">{b.text}</p>;
  const body =
    b.type === "text" ? (
      b.text.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)
    ) : b.type === "trace" ? (
      <Trace block={b} />
    ) : b.type === "question" ? (
      <Question block={b} pending={pending} onAnswer={onAnswer} busy={busy} />
    ) : b.type === "card" ? (
      <CardBlock block={b} />
    ) : b.type === "changes" ? (
      <RunFoot block={b} run={runs.get(b.runId)} onRevert={onRevert} busy={busy} />
    ) : b.type === "error" ? (
      <p className="ai-error">{b.text}</p>
    ) : b.type === "status" ? (
      <p className="ai-pending">{b.text}</p>
    ) : null;
  return (
    <div className="turn turn-ai">
      <div className="turn-mark">
        <span className="prov-tick" style={{ height: 12 }} />
      </div>
      <div className="turn-body">{body}</div>
    </div>
  );
}

export function AgentPanel({ open, onToggle, projectId, onOpenSettings }: { open: boolean; onToggle: (open: boolean) => void; projectId: string; onOpenSettings: () => void }) {
  const threads = useAgentThreads(projectId);
  const [chosenThread, setChosenThread] = useState<string | null>(() => localStorage.getItem(STORE.thread(projectId)));
  const threadId = (chosenThread && threads.data?.some((t) => t.id === chosenThread) ? chosenThread : null) ?? threads.data?.[0]?.id ?? null;
  const detail = useAgentThread(threadId);
  const engines = useEngines();
  const newThread = useNewThread(projectId);
  const setEngine = useSetEngine(projectId);
  const send = useSend();
  const answer = useAnswer();
  const cancel = useCancelRun();
  const revert = useRevertRun(projectId, threadId);

  const [draft, setDraft] = useState("");
  const [live, setLive] = useState<{ runId: string; text: string } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);

  const onDelta = useCallback((runId: string, text: string | null) => {
    setLive((prev) => (text === null ? null : prev && prev.runId === runId ? { runId, text: prev.text + text } : { runId, text }));
  }, []);
  useAgentEvents(projectId, threadId, onDelta);

  const runningRun = detail.data?.runs.find((r) => r.status === "running");
  const busy = !!runningRun || send.isPending || answer.isPending;
  const pending = detail.data?.pending ?? null;
  const runs = new Map((detail.data?.runs ?? []).map((r) => [r.id, r]));
  const engine = engines.data?.find((e) => e.id === detail.data?.thread.engine);
  const noEngineReady = engines.data ? !engines.data.some((e) => e.ok) : false;

  useEffect(() => {
    const saved = localStorage.getItem(STORE.width);
    if (saved && panel.current) panel.current.style.width = `${saved}px`;
  }, [open]);

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [detail.data?.messages.length, live?.text]);

  useEffect(() => {
    if (!busy) composer.current?.focus();
  }, [busy]);

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

  const pickThread = (id: string) => {
    setChosenThread(id);
    localStorage.setItem(STORE.thread(projectId), id);
  };

  const doSend = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    let target = threadId;
    if (!target) target = (await newThread.mutateAsync(undefined)).id;
    pickThread(target);
    send.mutate({ threadId: target, text });
  };

  const doAnswer = (questionId: string, value: string) => {
    if (!threadId || busy) return;
    answer.mutate({ threadId, questionId, value });
  };

  if (!open) {
    return (
      <div className="rail ai-rail">
        <button type="button" className="btn btn-icon" title="Expand assistant — ⌘J" aria-label="Expand assistant panel" onClick={() => onToggle(true)}>
          <Icon name="i-panel" size={15} />
        </button>
        <span className="rail-label">Assistant</span>
      </div>
    );
  }

  return (
    <aside className="ai" ref={panel}>
      <div className="ai-resize" title="Drag to resize" onMouseDown={startResize} />
      <div className="ai-head">
        <h2 style={{ fontSize: "var(--text-base)" }}>Assistant</h2>
        <Menu
          label="Engine"
          trigger={
            <button type="button" className="tag chip-btn" title="Who conducts this thread">
              {engine ? engine.title : "Engine"}
              {engine && !engine.ok && <Icon name="i-warn" size={11} />}
            </button>
          }
        >
          <MenuHead title="Who does the work" />
          {(engines.data ?? []).map((e) => (
            <MenuRadioItem
              key={e.id}
              checked={e.id === detail.data?.thread.engine}
              name={e.title}
              sub={e.ok ? undefined : e.reason}
              onSelect={() => threadId && !busy && setEngine.mutate({ threadId, engineId: e.id })}
            />
          ))}
          <MenuActionItem icon={<Icon name="i-gear" size={13} />} name="Manage models & engines…" onSelect={onOpenSettings} />
        </Menu>
        <Spacer />
        <Menu
          label="Threads"
          align="end"
          trigger={
            <button type="button" className="btn btn-icon" title="Threads" aria-label="Threads">
              <Icon name="i-stack" size={14} />
            </button>
          }
        >
          <MenuHead title="Threads" />
          {(threads.data ?? []).slice(0, 12).map((t) => (
            <MenuRadioItem key={t.id} checked={t.id === threadId} name={t.title || "New thread"} sub={ago(t.updatedAt)} onSelect={() => pickThread(t.id)} />
          ))}
          <MenuActionItem
            icon={<Icon name="i-plus" size={13} />}
            name="New thread"
            onSelect={() => void newThread.mutateAsync(undefined).then((t) => pickThread(t.id))}
          />
        </Menu>
        <button type="button" className="btn btn-icon" title="Collapse panel — ⌘J" aria-label="Collapse assistant panel" onClick={() => onToggle(false)}>
          <Icon name="i-panel" size={15} />
        </button>
      </div>

      <div className="ai-scroll" ref={scroll} role="log" aria-live="polite" aria-busy={busy}>
        {noEngineReady && (
          <div className="agent-empty">
            <p>To start, give the assistant a brain:</p>
            <button type="button" className="btn btn-secondary" onClick={onOpenSettings}>
              Connect a model API
            </button>
            <ul className="dash">{(engines.data ?? []).filter((e) => !e.ok).map((e) => <li key={e.id}>{e.title}: {e.reason}</li>)}</ul>
          </div>
        )}
        {!detail.data?.messages.length && !noEngineReady && (
          <div className="turn turn-ai">
            <div className="turn-mark">
              <span className="prov-tick" style={{ height: 12 }} />
            </div>
            <div className="turn-body">
              <p>I can read this board and write to it. Every write I make is attributed, grouped by run, and revertible in one click.</p>
            </div>
          </div>
        )}
        {(detail.data?.messages ?? []).map((m) => (
          <Row key={m.id} m={m} runs={runs} pending={pending} onAnswer={doAnswer} onRevert={(runId) => revert.mutate(runId)} busy={busy} />
        ))}
        {live?.text && (
          <div className="turn turn-ai">
            <div className="turn-mark">
              <span className="prov-tick" style={{ height: 12 }} />
            </div>
            <div className="turn-body">
              <p>{live.text}</p>
            </div>
          </div>
        )}
        {busy && !live && <p className="ai-pending" style={{ marginLeft: 22 }}>Working…</p>}
      </div>

      <div className="ai-foot">
        <input
          ref={composer}
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={pending ? "Answer, or pick an option above…" : "Message the assistant…"}
          aria-label="Message the assistant"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doSend();
          }}
        />
        {runningRun ? (
          <button type="button" className="btn btn-secondary" onClick={() => cancel.mutate(runningRun.id)}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" disabled={busy || !draft.trim()} onClick={() => void doSend()}>
            Send
          </button>
        )}
      </div>
    </aside>
  );
}

export const aiOpenKey = STORE.open;
