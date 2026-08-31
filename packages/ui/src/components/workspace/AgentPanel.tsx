import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { AgentSettings, Block, PendingView, RunView, ThreadMessage } from "@tomrade/agent";
import type { Item } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { Spacer } from "~/components/ui/atoms";
import { Menu, MenuActionItem, MenuHead, MenuRadioItem } from "~/components/ui/menu";
import { timeAgo } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useAgentEvents, useAgentThread, useAgentThreads, useAnswer, useCancelRun, useEngines, useNewThread, useRevertRun, useSend, useSetEngine, type RunProgress } from "~/lib/agent";
import { useItems, useSettings } from "~/lib/queries";

const MIN_W = 352;
const MAX_W = 616;
const STORE = { open: "tomrade.ai.open", width: "tomrade.ai.width", thread: (projectId: string) => `tomrade.agent.thread.${projectId}` };

const tokens = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The pulse that says "not stuck": what it's doing, for how long, and the tokens so far. */
function WorkingLine({ startedAt, progress, streaming }: { startedAt: number; progress: RunProgress | null; streaming: boolean }) {
  const { t } = useI18n();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const label = progress?.activity ?? (streaming ? t("agentPanel.writing") : t("agentPanel.thinking"));
  return (
    <p className="working" aria-live="off">
      <span className="w-tick" />
      <span className="num w-label">{label}</span>
      <span className="w-dots">
        <span />
        <span />
        <span />
      </span>
      <span className="num w-meta">
        {secs < 60 ? t("agentPanel.secondsShort", { n: secs }) : t("agentPanel.minSecShort", { m: Math.floor(secs / 60), s: String(secs % 60).padStart(2, "0") })}
        {progress?.usage ? ` · ↑${tokens(progress.usage.inputTokens)} ↓${tokens(progress.usage.outputTokens)} tok` : ""}
      </span>
    </p>
  );
}

const KEY_RE = /([A-Z][A-Z0-9]{1,9}-\d+)/g;

/** An item key in prose: one word wide, live title on hover, the full card one click away. */
function KeyRef({ text, item, projectId }: { text: string; item: Item | undefined; projectId: string }) {
  if (!item) return <span className="kref dead num">{text}</span>;
  return (
    <Link className="kref num" to="/p/$projectId/i/$itemId" params={{ projectId, itemId: item.key }} title={`${item.title} · ${item.status}`}>
      {text}
    </Link>
  );
}

/** Plain text with keys linked. Deliberately not a markdown renderer — the engines are told to write plainly. */
function linkify(text: string, byKey: Map<string, Item>, projectId: string): ReactNode[] {
  return text.split(KEY_RE).map((part, i) =>
    i % 2 === 1 ? <KeyRef key={i} text={part} item={byKey.get(part)} projectId={projectId} /> : <Fragment key={i}>{part}</Fragment>
  );
}

const OP_GLYPH = { created: "+", updated: "~", deleted: "–" } as const;

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

/**
 * Selecting only marks; Confirm submits. Multi-select when the asker said the
 * options combine. The block stays in the transcript after it is answered,
 * dimmed — the chosen value is the user message right below it.
 */
function Question({ block, pending, onAnswer, busy }: { block: Block & { type: "question" }; pending: PendingView | null; onAnswer: (id: string, value: string | string[]) => void; busy: boolean }) {
  const { t } = useI18n();
  const live = pending?.question.id === block.id;
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (option: string) =>
    setPicked((prev) => (block.multiple ? (prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option]) : prev[0] === option ? [] : [option]));
  return (
    <div className={live ? "q-ask" : "q-ask done"}>
      <span className="q-eyebrow">{live ? t(block.multiple ? "agentPanel.waitingPickAny" : "agentPanel.waitingPickOne") : t("agentPanel.asked")}</span>
      <p>{block.text}</p>
      {block.options && (
        <div className="chips">
          {block.options.map((option) => (
            <button
              key={option}
              type="button"
              className={picked.includes(option) ? "chip-opt sel" : "chip-opt"}
              aria-pressed={picked.includes(option)}
              disabled={!live || busy}
              onClick={() => toggle(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {live && block.options && (
        <div className="q-confirm">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || picked.length === 0}
            onClick={() => onAnswer(block.id, block.multiple ? picked : picked[0])}
          >
            {block.multiple && picked.length > 0 ? t("agentPanel.confirmCount", { n: picked.length }) : t("agentPanel.confirm")}
          </button>
          <span className="meta-txt">{t("agentPanel.confirmNote")}</span>
        </div>
      )}
    </div>
  );
}

function RunFoot({ block, run, byKey, projectId, onRevert, busy }: { block: Block & { type: "changes" }; run: RunView | undefined; byKey: Map<string, Item>; projectId: string; onRevert: (runId: string) => void; busy: boolean }) {
  const { t } = useI18n();
  const meta = run ? [run.engine, run.costUsd != null ? `$${run.costUsd.toFixed(3)}` : null].filter(Boolean).join(" · ") : "";
  return (
    <div className="run-wrap">
    <div className="run-foot">
      {run?.reverted ? (
        <span className="rf-note">{run.keptOnRevert > 0 ? t("agentPanel.revertedKept", { n: run.keptOnRevert }) : t("agentPanel.revertedPlain")}</span>
      ) : (
        <>
          <span className="rf-note">{t(block.count === 1 ? "agentPanel.changedOne" : "agentPanel.changedMany", { n: block.count })}</span>
          <button type="button" className="btn btn-ghost rf-btn" disabled={busy} onClick={() => onRevert(block.runId)}>
            <Icon name="i-undo" size={12} /> {t("agentPanel.revert")}
          </button>
        </>
      )}
      {meta && <span className="rf-meta num">{meta}</span>}
    </div>
    {!!block.items?.length && (
      <details className="rf-list">
        <summary>{t("agentPanel.whatChanged")}</summary>
        {block.items.map((it, i) => (
          <div className="rf-row" key={i}>
            <span className={`rf-op num op-${it.op}`}>{OP_GLYPH[it.op]}</span>
            <KeyRef text={it.key} item={byKey.get(it.key)} projectId={projectId} />
            <span className="rf-label" title={it.label}>{it.label}</span>
          </div>
        ))}
      </details>
    )}
    </div>
  );
}

function Row({ m, runs, pending, byKey, projectId, onAnswer, onRevert, busy }: { m: ThreadMessage; runs: Map<string, RunView>; pending: PendingView | null; byKey: Map<string, Item>; projectId: string; onAnswer: (id: string, value: string | string[]) => void; onRevert: (runId: string) => void; busy: boolean }) {
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
      b.text.split(/\n{2,}/).map((para, i) => <p key={i}>{linkify(para, byKey, projectId)}</p>)
    ) : b.type === "trace" ? (
      <Trace block={b} />
    ) : b.type === "question" ? (
      <Question block={b} pending={pending} onAnswer={onAnswer} busy={busy} />
    ) : b.type === "card" ? (
      <CardBlock block={b} />
    ) : b.type === "changes" ? (
      <RunFoot block={b} run={runs.get(b.runId)} byKey={byKey} projectId={projectId} onRevert={onRevert} busy={busy} />
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
  const { t } = useI18n();
  const threads = useAgentThreads(projectId);
  const settings = useSettings();
  const itemsQ = useItems(projectId);
  const [chosenThread, setChosenThread] = useState<string | null>(() => localStorage.getItem(STORE.thread(projectId)));
  const threadId = (chosenThread && threads.data?.some((th) => th.id === chosenThread) ? chosenThread : null) ?? threads.data?.[0]?.id ?? null;
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
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);

  const onDelta = useCallback((runId: string, text: string | null) => {
    setLive((prev) => (text === null ? null : prev && prev.runId === runId ? { runId, text: prev.text + text } : { runId, text }));
  }, []);
  const onProgress = useCallback((next: RunProgress | null) => {
    setProgress((prev) => (next === null ? null : { runId: next.runId, activity: next.activity ?? prev?.activity ?? null, usage: next.usage ?? prev?.usage ?? null }));
  }, []);
  useAgentEvents(projectId, threadId, onDelta, onProgress);

  const runningRun = detail.data?.runs.find((r) => r.status === "running");
  const busy = !!runningRun || send.isPending || answer.isPending;
  const pending = detail.data?.pending ?? null;
  const runs = new Map((detail.data?.runs ?? []).map((r) => [r.id, r]));
  const byKey = new Map((itemsQ.data ?? []).map((i) => [i.key, i]));
  // No thread yet: the chip shows what a new thread WOULD get, and picking an
  // engine creates the thread right there instead of doing silently nothing.
  const defaultEngine = (settings.data?.agent as AgentSettings | undefined)?.defaultEngine ?? "loop";
  const currentEngineId = detail.data?.thread.engine ?? defaultEngine;
  const engine = engines.data?.find((e) => e.id === currentEngineId);
  const noEngineReady = engines.data ? !engines.data.some((e) => e.ok) : false;

  useEffect(() => {
    const saved = localStorage.getItem(STORE.width);
    if (saved && panel.current) panel.current.style.width = `${saved}px`;
  }, [open]);

  // After layout, so a working line or question that just mounted is inside scrollHeight.
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [detail.data?.messages.length, live?.text, runningRun?.id, pending?.question.id]);

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

  const doAnswer = (questionId: string, value: string | string[]) => {
    if (!threadId || busy) return;
    answer.mutate({ threadId, questionId, value });
  };

  if (!open) {
    return (
      <div className="rail ai-rail">
        <button type="button" className="btn btn-icon" title={t("agentPanel.expandAssistant")} aria-label={t("agentPanel.expandAssistantAria")} onClick={() => onToggle(true)}>
          <Icon name="i-panel" size={15} />
        </button>
        <span className="rail-label">{t("agentPanel.assistantLabel")}</span>
      </div>
    );
  }

  return (
    <aside className="ai" ref={panel}>
      <div className="ai-resize" title={t("agentPanel.dragToResize")} onMouseDown={startResize} />
      <div className="ai-head">
        <h2 style={{ fontSize: "var(--text-base)" }}>{t("agentPanel.assistantLabel")}</h2>
        <Menu
          label={t("agentPanel.engineLabel")}
          trigger={
            <button type="button" className="tag chip-btn" title={t("agentPanel.whoConducts")}>
              {engine?.title ?? currentEngineId}
              {engine && !engine.ok && <Icon name="i-warn" size={11} />}
            </button>
          }
        >
          <MenuHead title={t("agentPanel.whoDoesWork")} />
          {(engines.data ?? []).map((e) => (
            <MenuRadioItem
              key={e.id}
              checked={e.id === currentEngineId}
              name={e.title}
              sub={e.ok ? undefined : e.reason}
              onSelect={() => {
                if (busy || e.id === currentEngineId) return;
                if (threadId) setEngine.mutate({ threadId, engineId: e.id });
                else void newThread.mutateAsync(e.id).then((th) => pickThread(th.id));
              }}
            />
          ))}
          <MenuActionItem icon={<Icon name="i-gear" size={13} />} name={t("agentPanel.manageModelsEngines")} onSelect={onOpenSettings} />
        </Menu>
        <Spacer />
        <Menu
          label={t("agentPanel.threadsLabel")}
          align="end"
          trigger={
            <button type="button" className="btn btn-icon" title={t("agentPanel.threadsLabel")} aria-label={t("agentPanel.threadsLabel")}>
              <Icon name="i-stack" size={14} />
            </button>
          }
        >
          <MenuHead title={t("agentPanel.threadsLabel")} />
          {(threads.data ?? []).slice(0, 12).map((th) => (
            <MenuRadioItem key={th.id} checked={th.id === threadId} name={th.title || t("agentPanel.newThread")} sub={timeAgo(th.updatedAt)} onSelect={() => pickThread(th.id)} />
          ))}
          <MenuActionItem
            icon={<Icon name="i-plus" size={13} />}
            name={t("agentPanel.newThread")}
            onSelect={() => void newThread.mutateAsync(undefined).then((th) => pickThread(th.id))}
          />
        </Menu>
        <button type="button" className="btn btn-icon" title={t("agentPanel.collapsePanel")} aria-label={t("agentPanel.collapseAssistantAria")} onClick={() => onToggle(false)}>
          <Icon name="i-panel" size={15} />
        </button>
      </div>

      <div className="ai-scroll" ref={scroll} role="log" aria-live="polite" aria-busy={busy}>
        {noEngineReady && (
          <div className="agent-empty">
            <p>{t("agentPanel.giveABrain")}</p>
            <button type="button" className="btn btn-secondary" onClick={onOpenSettings}>
              {t("agentPanel.connectModelApi")}
            </button>
            <ul className="dash">
              {(engines.data ?? []).filter((e) => !e.ok).map((e) => (
                <li key={e.id}>{t("agentPanel.engineReasonLine", { title: e.title, reason: e.reason ?? "" })}</li>
              ))}
            </ul>
          </div>
        )}
        {!detail.data?.messages.length && !noEngineReady && (
          <div className="turn turn-ai">
            <div className="turn-mark">
              <span className="prov-tick" style={{ height: 12 }} />
            </div>
            <div className="turn-body">
              <p>{t("agentPanel.introMessage")}</p>
            </div>
          </div>
        )}
        {(detail.data?.messages ?? []).map((m) => (
          <Row key={m.id} m={m} runs={runs} pending={pending} byKey={byKey} projectId={projectId} onAnswer={doAnswer} onRevert={(runId) => revert.mutate(runId)} busy={busy} />
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
        {runningRun && <WorkingLine startedAt={runningRun.startedAt} progress={progress} streaming={!!live} />}
      </div>

      <div className="ai-foot">
        <input
          ref={composer}
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={pending ? t("agentPanel.answerPlaceholder") : t("agentPanel.messagePlaceholder")}
          aria-label={t("agentPanel.messageAria")}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doSend();
          }}
        />
        {runningRun ? (
          <button type="button" className="btn btn-secondary" onClick={() => cancel.mutate(runningRun.id)}>
            {t("agentPanel.stop")}
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" disabled={busy || !draft.trim()} onClick={() => void doSend()}>
            {t("agentPanel.send")}
          </button>
        )}
      </div>
    </aside>
  );
}

export const aiOpenKey = STORE.open;
