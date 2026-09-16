import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentSettings, Block, EnginePick, FocusRef, PendingView, RunView, ThreadMessage } from "@tomrade/agent";
import type { Item } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { PetStage } from "./PetStage";
import { AgentMedia } from "./AgentMedia";
import { AgentAttachment, readAttachment } from "./AgentAttachment";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "~/lib/api";
import { Spacer } from "~/components/ui/atoms";
import { Menu, MenuActionItem, MenuHead, MenuRadioItem } from "~/components/ui/menu";
import { timeAgo, viewIcon } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useAgentEvents, useAgentThread, useAgentThreads, useAnswer, useArchiveThread, useCancelRun, useDeleteThread, useEngines, useNewThread, useRevertRun, useSend, useSetEngine, useSetOptions, useSetPermissionMode, useSetWorkstream, useWorkdir, type RunProgress } from "~/lib/agent";
import { useAssistantAccessories, useBoards, useItems, useSaveSettings, useSettings } from "~/lib/queries";

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

/** An item key in prose: one word wide, live title on hover, the sidebar detail one click away — same as clicking the card on the board. */
function KeyRef({ text, item, onOpenIssue }: { text: string; item: Item | undefined; onOpenIssue: (id: string) => void }) {
  if (!item) return <span className="kref dead num">{text}</span>;
  return (
    <button type="button" className="kref num" title={`${item.title} · ${item.status}`} onClick={() => onOpenIssue(item.id)}>
      {text}
    </button>
  );
}

/** Plain text with keys linked. Deliberately not a markdown renderer — the engines are told to write plainly. */
function linkify(text: string, byKey: Map<string, Item>, onOpenIssue: (id: string) => void): ReactNode[] {
  return text.split(KEY_RE).map((part, i) =>
    i % 2 === 1 ? <KeyRef key={i} text={part} item={byKey.get(part)} onOpenIssue={onOpenIssue} /> : <Fragment key={i}>{part}</Fragment>
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
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{block.text}</p>
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

function RunFoot({ block, run, byKey, onOpenIssue, onRevert, busy }: { block: Block & { type: "changes" }; run: RunView | undefined; byKey: Map<string, Item>; onOpenIssue: (id: string) => void; onRevert: (runId: string) => void; busy: boolean }) {
  const { t } = useI18n();
  const meta = run ? [run.engine, run.costUsd != null ? `$${run.costUsd.toFixed(3)}` : null,
    run.endedAt != null ? `${Math.round((run.endedAt - run.startedAt) / 1000)}s` : null,
    run.usage ? `↑${tokens(run.usage.inputTokens)} ↓${tokens(run.usage.outputTokens)}` : null,
    run.metrics?.readyMs != null ? `init ${Math.round(run.metrics.readyMs / 1000)}s` : null,
    run.metrics?.firstTokenMs != null ? `first ${Math.round(run.metrics.firstTokenMs / 1000)}s` : null].filter(Boolean).join(" · ") : "";
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
    </div>
    {!!block.items?.length && (
      <details className="rf-list">
        <summary>{t("agentPanel.whatChanged")}</summary>
        {block.items.map((it, i) => (
          <div className="rf-row" key={i}>
            <span className={`rf-op num op-${it.op}`}>{OP_GLYPH[it.op]}</span>
            <KeyRef text={it.key} item={byKey.get(it.key)} onOpenIssue={onOpenIssue} />
            <span className="rf-label" title={it.label}>{it.label}</span>
          </div>
        ))}
      </details>
    )}
    {meta && <div className="rf-meta run-metrics num">{meta}</div>}
    </div>
  );
}

function RunMetrics({ run }: { run: RunView | undefined }) {
  if (!run || run.endedAt == null) return null;
  const elapsed = `${Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000))}s`;
  const usage = run.usage ? `↑${tokens(run.usage.inputTokens)} ↓${tokens(run.usage.outputTokens)}` : null;
  const timings = [run.metrics?.readyMs != null ? `init ${Math.round(run.metrics.readyMs / 1000)}s` : null,
    run.metrics?.firstTokenMs != null ? `first ${Math.round(run.metrics.firstTokenMs / 1000)}s` : null].filter(Boolean).join(" · ");
  return <p className="meta-txt num" style={{ margin: "8px 0 0 22px" }}>{elapsed}{usage ? ` · ${usage}` : ""}{timings ? ` · ${timings}` : ""}</p>;
}

function Row({ projectId, m, runs, pending, byKey, onOpenIssue, onAnswer, onRevert, busy }: { projectId: string; m: ThreadMessage; runs: Map<string, RunView>; pending: PendingView | null; byKey: Map<string, Item>; onOpenIssue: (id: string) => void; onAnswer: (id: string, value: string | string[]) => void; onRevert: (runId: string) => void; busy: boolean }) {
  const b = m.block;
  if (m.role === "user") {
    const focus = b.type === "text" ? b.focus : undefined;
    return (
      <div className="turn turn-user">
        <span className="turn-rule" />
        <p>{b.type === "text" ? b.text : ""}</p>
        {b.type === "text" && b.attachments?.map(media => <AgentMedia key={media.id} projectId={projectId} threadId={m.threadId} media={media} />)}
        {!!focus?.length && (
          <span className="turn-ctx num" title={focus.map((r) => r.title).join(" · ")}>
            {focus.map((r) => r.key ?? r.title).join(" · ")}
          </span>
        )}
      </div>
    );
  }
  if (b.type === "note") return <p className="agent-note">{b.text}</p>;
  const body =
    b.type === "text" ? (
      <>
        {b.text.split(/\n{2,}/).map((para, i) => <p key={i}>{linkify(para, byKey, onOpenIssue)}</p>)}
        {m.role === "agent" && m.runId && (runs.get(m.runId)?.changes ?? 0) === 0 && <RunMetrics run={runs.get(m.runId)} />}
      </>
    ) : b.type === "media" ? (
      <AgentMedia projectId={projectId} threadId={m.threadId} media={b.media} caption={b.caption} />
    ) : b.type === "trace" ? (
      <Trace block={b} />
    ) : b.type === "question" ? (
      <Question block={b} pending={pending} onAnswer={onAnswer} busy={busy && pending?.kind !== "permission"} />
    ) : b.type === "card" ? (
      <CardBlock block={b} />
    ) : b.type === "changes" ? (
      <RunFoot block={b} run={runs.get(b.runId)} byKey={byKey} onOpenIssue={onOpenIssue} onRevert={onRevert} busy={busy} />
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

export function AgentPanel({
  open,
  onToggle,
  projectId,
  boardId = null,
  requestedThread = null,
  focus,
  onOpenSettings,
  onOpenRepositories,
  onOpenIssue
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  projectId: string;
  /** The workstream page the panel is open on, if any: a new thread starts there. */
  boardId?: string | null;
  /** A thread a screen asked to see (a ticket's Start); `at` makes a repeat request for the same id visible. */
  requestedThread?: { id: string; at: number } | null;
  focus: FocusRef[];
  onOpenSettings: () => void;
  /** Where a workstream's repository is placed on this machine — the way out of "no local checkout". */
  onOpenRepositories?: () => void;
  onOpenIssue: (id: string) => void;
}) {
  const { t } = useI18n();
  const threads = useAgentThreads(projectId);
  const settings = useSettings();
  const itemsQ = useItems(projectId);
  const boardsQ = useBoards(projectId);
  const accessories = useAssistantAccessories();
  const [chosenThread, setChosenThread] = useState<string | null>(() => localStorage.getItem(STORE.thread(projectId)));
  const threadId = (chosenThread && threads.data?.some((th) => th.id === chosenThread) ? chosenThread : null) ?? threads.data?.[0]?.id ?? null;
  const detail = useAgentThread(projectId, threadId);
  const engines = useEngines();
  const newThread = useNewThread(projectId);
  const archiveThread = useArchiveThread(projectId);
  const deleteThread = useDeleteThread(projectId);
  const setEngine = useSetEngine(projectId);
  const setPermissionMode = useSetPermissionMode(projectId);
  const send = useSend(projectId);
  const answer = useAnswer(projectId);
  const cancel = useCancelRun();
  const revert = useRevertRun(projectId, threadId);
  const setWorkstream = useSetWorkstream(projectId);
  // The thread's workstream names its repository; the workdir says whether this machine can run there.
  const threadBoardId = detail.data?.thread.boardId ?? null;
  const pickedBoardId = threadBoardId ?? (threadId ? null : (boardId ?? null));
  const pickedBoard = pickedBoardId ? (boardsQ.data ?? []).find((b) => b.id === pickedBoardId) : undefined;
  const chooseBoard = (next: string | null) => {
    if (busy || next === pickedBoardId) return;
    if (threadId) setWorkstream.mutate({ threadId, boardId: next });
    else void newThread.mutateAsync({ boardId: next }).then((th) => pickThread(th.id));
  };
  const workdir = useWorkdir(projectId, threadId, !!threadBoardId);
  const workdirProblem = threadBoardId ? (workdir.data?.problem ?? null) : null;

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  // What rides along as "(viewing: …)": follow tracks the screen, pinned holds
  // a snapshot across navigation, off sends nothing. Session state on purpose —
  // the panel never unmounts inside a project, so it survives navigation.
  const [ctxMode, setCtxMode] = useState<"follow" | "pinned" | "off">("follow");
  const [pinnedFocus, setPinnedFocus] = useState<FocusRef[]>([]);
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
  const busy = !!runningRun || send.isPending || answer.isPending || uploading;
  const blocked = !!workdirProblem;
  const pending = detail.data?.pending ?? null;
  const runs = new Map((detail.data?.runs ?? []).map((r) => [r.id, r]));
  const byKey = new Map((itemsQ.data ?? []).map((i) => [i.key, i]));
  // No thread yet: the chip shows what a new thread WOULD get, and picking an
  // engine creates the thread right there instead of doing silently nothing.
  const agentSettings = settings.data?.agent as AgentSettings | undefined;
  const defaultEngine = agentSettings?.defaultEngine ?? "loop";
  const currentEngineId = detail.data?.thread.engine ?? defaultEngine;
  const engine = engines.data?.find((e) => e.id === currentEngineId);
  const permissionModes = detail.data?.thread.itemId ? engine?.permissionModes : undefined;
  const selectedPermissionMode = detail.data?.thread.permissionMode ?? permissionModes?.default;
  const activePermissionMode = runningRun ? detail.data?.activePermissionMode : undefined;
  const permissionLabel = (value?: string) => permissionModes?.choices.find((choice) => choice.value === value)?.label ?? value;
  const noEngineReady = engines.data ? !engines.data.some((e) => e.ok) : false;

  // Quick picks: with a thread they are that thread's overrides (what Start chose), layered over the engine's
  // global options — the same knobs settings edits; without one they edit the global options a new thread would get.
  const saveSettings = useSaveSettings();
  const setOptions = useSetOptions(projectId);
  const globalOptions = (agentSettings?.engines?.[currentEngineId] ?? {}) as Record<string, unknown>;
  const threadOptions = (detail.data?.thread.engine === currentEngineId ? detail.data.thread.options : null) ?? {};
  const engineOptions = { ...globalOptions, ...threadOptions };
  const mediaCapabilities = useQuery({
    queryKey: ["agent-media-capabilities", currentEngineId, engineOptions, settings.data?.models],
    queryFn: () => invoke("agent.mediaCapabilities", currentEngineId, engineOptions),
    retry: false
  });
  const acceptedMedia = mediaCapabilities.data?.input ?? [];
  const addAttachments = (files: File[]) => {
    if (busy) return;
    if (attachments.length + files.length > 8) { setAttachmentError(t("agentPanel.tooManyAttachments")); return; }
    if (files.some(file => !acceptedMedia.includes(file.type))) { setAttachmentError(t("agentPanel.unsupportedAttachment")); return; }
    if (files.some(file => !file.size || file.size > 32 * 1024 * 1024)) { setAttachmentError(t("agentPanel.attachmentSize")); return; }
    setAttachmentError(null);
    setAttachments(previous => [...previous, ...files]);
  };
  const picks = engine?.picks ?? [];
  const pickValue = (key: string) => (typeof engineOptions[key] === "string" && engineOptions[key] ? (engineOptions[key] as string) : null);
  const setPick = (key: string, value: string | null) => {
    if (threadId) {
      const next = { ...threadOptions } as Record<string, unknown>;
      if (value) next[key] = value;
      else delete next[key];
      setOptions.mutate({ threadId, options: Object.keys(next).length ? next : null });
      return;
    }
    if (!settings.data || !agentSettings) return;
    const next = { ...globalOptions };
    if (value) next[key] = value;
    else delete next[key];
    saveSettings.mutate({ ...settings.data, agent: { ...agentSettings, engines: { ...agentSettings.engines, [currentEngineId]: next } } });
  };
  const pickTitle = (pick: EnginePick) =>
    pick.key === "model" || pick.key === "profile" ? t("agentPanel.modelHead") : pick.key === "effort" ? t("agentPanel.effortHead") : pick.title;

  useEffect(() => {
    const saved = localStorage.getItem(STORE.width);
    if (panel.current) panel.current.style.width = `${saved ? Math.min(MAX_W, Math.max(MIN_W, Number(saved))) : MAX_W}px`;
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
    if (threadId && id !== threadId) { setAttachments([]); setAttachmentError(null); }
    setChosenThread(id);
    localStorage.setItem(STORE.thread(projectId), id);
  };
  useEffect(() => {
    if (!requestedThread) return;
    setAttachments([]);
    setAttachmentError(null);
    setChosenThread(requestedThread.id);
    localStorage.setItem(STORE.thread(projectId), requestedThread.id);
  }, [requestedThread, projectId]);

  // Snapshotted at send time: navigating away mid-run can't change what "this" meant.
  const sendFocus = ctxMode === "off" ? [] : ctxMode === "pinned" ? pinnedFocus : focus;

  const doSend = async () => {
    const text = draft.trim();
    if ((!text && !attachments.length) || busy || blocked || sending.current) return;
    if (attachments.some(file => !acceptedMedia.includes(file.type))) { setAttachmentError(t("agentPanel.unsupportedAttachment")); return; }
    sending.current = true; setUploading(true); setAttachmentError(null);
    try {
      let target = threadId;
      if (!target) target = (await newThread.mutateAsync({ boardId })).id;
      pickThread(target);
      const refs = await Promise.all(attachments.map(async file => invoke("agent.media.upload", projectId, target!, {
        name: file.name, mime: file.type, base64: await readAttachment(file)
      })));
      await send.mutateAsync({ threadId: target, text, focus: sendFocus.length ? sendFocus : undefined, attachments: refs.length ? refs : undefined });
      setDraft(""); setAttachments([]);
    } catch (error) { setAttachmentError(error instanceof Error ? error.message : String(error)); }
    finally { sending.current = false; setUploading(false); }
  };

  const doAnswer = (questionId: string, value: string | string[]) => {
    if (!threadId || answer.isPending || (busy && pending?.kind !== "permission")) return;
    answer.mutate({ threadId, questionId, value });
  };

  const archiveThreadById = (id: string) => {
    if (busy) return;
    archiveThread.mutate(id, { onSuccess: () => { if (id === threadId) setChosenThread(null); } });
  };
  const deleteThreadById = (id: string) => {
    if (busy || !window.confirm(t("agentPanel.deleteThreadConfirm"))) return;
    deleteThread.mutate(id, { onSuccess: () => { if (id === threadId) setChosenThread(null); } });
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
          <MenuHead
            title={t("agentPanel.threadsLabel")}
            aside={
              <button
                type="button"
                className="btn btn-icon"
                title={t("agentPanel.newThread")}
                aria-label={t("agentPanel.newThread")}
                onClick={() => void newThread.mutateAsync({ boardId }).then((th) => pickThread(th.id))}
              >
                <Icon name="i-plus" size={13} />
              </button>
            }
          />
          {(threads.data ?? []).slice(0, 12).map((th) => (
            <MenuRadioItem
              key={th.id}
              checked={th.id === threadId}
              name={th.title || t("agentPanel.newThread")}
              sub={timeAgo(th.updatedAt)}
              onSelect={() => pickThread(th.id)}
              actions={
                <>
                  <button type="button" className="btn btn-icon" title={t("agentPanel.archiveThread")} aria-label={t("agentPanel.archiveThread")} onClick={() => archiveThreadById(th.id)}>
                    <Icon name="i-archive" size={12} />
                  </button>
                  <button type="button" className="btn btn-icon" title={t("agentPanel.deleteThread")} aria-label={t("agentPanel.deleteThread")} onClick={() => deleteThreadById(th.id)}>
                    <Icon name="i-trash" size={12} />
                  </button>
                </>
              }
            />
          ))}
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
          <Row key={m.id} projectId={projectId} m={m} runs={runs} pending={pending} byKey={byKey} onOpenIssue={onOpenIssue} onAnswer={doAnswer} onRevert={(runId) => revert.mutate(runId)} busy={busy} />
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

      <div className="ai-foot" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => {
        if (event.dataTransfer.files.length) { event.preventDefault(); addAttachments(Array.from(event.dataTransfer.files)); }
      }}>
        {(accessories.data ?? []).map((accessory) => (
          <PetStage key={accessory.id} accessory={accessory} threadId={threadId} />
        ))}
        <div className="ai-composer">
          <input ref={fileInput} type="file" multiple accept={acceptedMedia.join(",")} style={{ display: "none" }} onChange={event => {
            addAttachments(Array.from(event.target.files ?? [])); event.target.value = "";
          }} />
          <button type="button" className="btn btn-icon" aria-label={t("agentPanel.attachMedia")} title={t(acceptedMedia.length ? "agentPanel.attachMedia" : "agentPanel.unsupportedAttachment")} disabled={busy || !acceptedMedia.length} onClick={() => fileInput.current?.click()}>+</button>
          <input
            ref={composer}
            className="ai-input"
            placeholder={pending ? t("agentPanel.answerPlaceholder") : t("agentPanel.messagePlaceholder")}
            aria-label={t("agentPanel.messageAria")}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); addAttachments(Array.from(event.clipboardData.files)); } }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void doSend();
            }}
          />
          {runningRun ? (
            <button type="button" className="btn btn-icon ai-send" title={t("agentPanel.stop")} aria-label={t("agentPanel.stop")} onClick={() => cancel.mutate(runningRun.id)}>
              <Icon name="i-stop" size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-icon ai-send"
              title={workdirProblem ?? t("agentPanel.send")}
              aria-label={t("agentPanel.send")}
              disabled={busy || blocked || (!draft.trim() && !attachments.length)}
              onClick={() => void doSend()}
            >
              <Icon name="i-send" size={14} />
            </button>
          )}
        </div>
        {!!attachments.length && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {attachments.map((file, index) => <AgentAttachment key={`${file.name}-${index}`} file={file} disabled={busy} remove={() => setAttachments(previous => previous.filter((_, i) => i !== index))} />)}
        </div>}
        {attachmentError && <p className="ai-error" role="alert">{attachmentError}</p>}
        {threadBoardId && (
          <p className={workdirProblem ? "ai-workdir is-problem meta-txt dense" : "ai-workdir meta-txt dense num"} style={{ margin: "6px 0 0", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {workdirProblem ? (
              <>
                <Icon name="i-warn" size={12} style={{ color: "var(--danger)", flexShrink: 0 }} />
                <span style={{ color: "var(--danger)" }}>{t(workdir.data?.code === "no-checkout" ? "agentPanel.noCheckout" : "agentPanel.workdirError")}</span>
                <span title={workdirProblem} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
                  {workdirProblem}
                </span>
                {onOpenRepositories && (
                  <button type="button" className="btn btn-ghost ai-repos-link" style={{ padding: "0 6px" }} onClick={onOpenRepositories}>
                    {t("agentPanel.repositoriesLink")}
                  </button>
                )}
              </>
            ) : workdir.data?.cwd ? (
              <span title={workdir.data.cwd} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t("agentPanel.runsIn", { path: workdir.data.cwd })}
              </span>
            ) : null}
          </p>
        )}
        <div className="ai-knobs">
          {/* The workstream is one more knob beside the engine's, not a form field: a chip that opens a menu. */}
          <Menu
            label={t("agentPanel.workstreamLabel")}
            align="start"
            trigger={
              <button
                type="button"
                className={`tag chip-btn ai-ws${pickedBoardId ? "" : " is-quiet"}`}
                title={t("agentPanel.workstreamLabel")}
                aria-label={t("agentPanel.workstreamAria")}
                data-board={pickedBoardId ?? ""}
                disabled={busy}
              >
                <Icon name={pickedBoard ? viewIcon(pickedBoard.icon) : "i-stack"} size={11} />
                {pickedBoard?.name ?? t("agentPanel.wholeProject")}
                <Icon name="i-chevdown" size={9} />
              </button>
            }
          >
            <MenuHead title={t("agentPanel.workstreamLabel")} />
            <MenuRadioItem checked={!pickedBoardId} name={t("agentPanel.wholeProject")} onSelect={() => chooseBoard(null)} />
            {(boardsQ.data ?? []).map((b) => (
              <MenuRadioItem key={b.id} checked={b.id === pickedBoardId} name={b.name} onSelect={() => chooseBoard(b.id)} />
            ))}
          </Menu>
          <Menu
            label={t("agentPanel.contextHead")}
            trigger={
              <button type="button" className={`tag chip-btn ctx-chip${ctxMode === "off" || !sendFocus.length ? " is-quiet" : ""}`} title={t("agentPanel.contextChipTitle")}>
                <Icon name="i-monitor" size={11} />
                <span className="ctx-chip-label">
                  {ctxMode === "off" ? t("agentPanel.contextOff") : sendFocus.length ? sendFocus.map((r) => r.key ?? r.title).join(" · ") : t("agentPanel.contextFollow")}
                </span>
                <Icon name="i-chevdown" size={9} />
              </button>
            }
          >
            <MenuHead title={t("agentPanel.contextHead")} />
            <MenuRadioItem
              checked={ctxMode === "follow"}
              name={t("agentPanel.contextFollow")}
              sub={focus.map((r) => r.key ?? r.title).join(" · ") || undefined}
              onSelect={() => setCtxMode("follow")}
            />
            <MenuRadioItem
              checked={ctxMode === "pinned"}
              name={t("agentPanel.contextPin")}
              sub={(ctxMode === "pinned" ? pinnedFocus : focus).map((r) => r.key ?? r.title).join(" · ") || undefined}
              onSelect={() => {
                if (!focus.length && !pinnedFocus.length) return;
                if (focus.length) setPinnedFocus(focus);
                setCtxMode("pinned");
              }}
            />
            <MenuRadioItem checked={ctxMode === "off"} name={t("agentPanel.contextOff")} onSelect={() => setCtxMode("off")} />
          </Menu>
          <Menu
            label={t("agentPanel.engineLabel")}
            align="end"
            trigger={
              <button type="button" className="tag chip-btn" title={t("agentPanel.whoConducts")}>
                {engine?.title ?? currentEngineId}
                {engine && !engine.ok && <Icon name="i-warn" size={11} />}
                <Icon name="i-chevdown" size={9} />
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
                  else void newThread.mutateAsync({ engine: e.id, boardId }).then((th) => pickThread(th.id));
                }}
              />
            ))}
            <MenuActionItem icon={<Icon name="i-gear" size={13} />} name={t("agentPanel.manageModelsEngines")} onSelect={onOpenSettings} />
          </Menu>
          {permissionModes && (
            <Menu label={t("agentPanel.permissions")} align="end" trigger={
              <button type="button" className="tag chip-btn" aria-label={t("agentPanel.permissions")} disabled={setPermissionMode.isPending}>
                {permissionLabel(activePermissionMode ?? selectedPermissionMode)}
                <Icon name="i-chevdown" size={9} />
              </button>
            }>
              <MenuHead title={t("agentPanel.permissions")} />
              {permissionModes.choices.map((choice) => (
                <MenuRadioItem key={choice.value} checked={choice.value === selectedPermissionMode} name={choice.label}
                  sub={runningRun ? t("agentPanel.modeNextTurn") : undefined}
                  onSelect={() => { if (threadId) setPermissionMode.mutate({ threadId, mode: choice.value }); }} />
              ))}
            </Menu>
          )}
          {activePermissionMode && activePermissionMode !== selectedPermissionMode && (
            <span className="meta-txt">{t("agentPanel.modeQueued", { mode: permissionLabel(selectedPermissionMode) ?? "" })}</span>
          )}
          {picks.map((pick) => {
            const current = pickValue(pick.key);
            const shown = current ? (pick.choices.find((c) => c.value === current)?.label ?? current) : pickTitle(pick);
            return (
              <Menu
                key={pick.key}
                label={pickTitle(pick)}
                align="end"
                trigger={
                  <button type="button" className={`tag chip-btn${current ? "" : " is-quiet"}`} title={pickTitle(pick)}>
                    {shown}
                    <Icon name="i-chevdown" size={9} />
                  </button>
                }
              >
                <MenuHead title={pickTitle(pick)} />
                <MenuRadioItem checked={!current} name={t("agentPanel.pickDefault")} onSelect={() => setPick(pick.key, null)} />
                {pick.choices.map((c) => (
                  <MenuRadioItem key={c.value} checked={c.value === current} name={c.label ?? c.value} onSelect={() => setPick(pick.key, c.value)} />
                ))}
                {/* a value typed by hand in settings still shows as what's in charge */}
                {current && !pick.choices.some((c) => c.value === current) && <MenuRadioItem checked name={current} onSelect={() => {}} />}
              </Menu>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

export const aiOpenKey = STORE.open;
