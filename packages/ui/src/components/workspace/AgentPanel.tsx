import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentSettings, Block, CardAction, CardView, ChecklistCard, EnginePick, EngineView, FindingCard, FocusRef, PendingView, RunView, ThreadMessage } from "@tomradex/agent";
import { modelErrorKind, type Item } from "@tomradex/domain";
import { Icon, type IconId } from "~/components/icons";
import { Hint } from "~/components/ui/hint";
import { PetStage } from "./PetStage";
import { SetupCard } from "./SetupCard";
import { AgentMedia } from "./AgentMedia";
import { AgentAttachment, readAttachment } from "./AgentAttachment";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "~/lib/api";
import { Spacer } from "~/components/ui/atoms";
import { Menu, MenuActionItem, MenuHead, MenuRadioItem } from "~/components/ui/menu";
import { clockLabel, timeAgo, viewIcon } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { foldSteps, traceState } from "~/lib/steps";
import { conducts, useAgentEvents, useAgentThread, useAgentThreads, useArchivedThreads, useAnswer, useArchiveThread, useCancelRun, useDeleteThread, useEngines, useNewThread, useRevertRun, useSend, useSetEngine, useSetOptions, useSetPermissionMode, useSetWorkstream, useUnarchiveThread, useWorkdir, type RunProgress } from "~/lib/agent";
import { useAssistantAccessories, useBoards, useItems, useSaveSettings, useSettings } from "~/lib/queries";
import { useAttention, type AttentionEntry } from "~/lib/attention";
import { permissionLabel as permissionName } from "~/lib/codeLink";
import { engineStateLabel } from "~/lib/localCli";
import { useSetupInTerminal } from "~/lib/setup";
import { useErrorToast, useToast } from "~/lib/toast";
import { ReportDialog } from "~/components/dialogs/ReportDialog";
import { ChecklistBlock, FindingBlock } from "./DoctorCards";

const MIN_W = 352;
const MAX_W = 616;
/** Until someone drags it: room for a conversation without taking the board's second column at 1440px. */
const DEFAULT_W = 440;
const STORE = { open: "tomrade.ai.open", width: "tomrade.ai.width", thread: (projectId: string) => `tomrade.agent.thread.${projectId}` };

const tokens = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** A finished run's tokens, split the same way Settings → Usage adds them up. */
const runTokensLabel = (t: Translate, run: RunView): string | null => {
  const k = run.tokens;
  if (!k) return null;
  return k.cacheReadTokens + k.cacheWriteTokens > 0
    ? t("agentPanel.tokensSplit", { input: tokens(k.inputTokens), uncached: tokens(k.uncachedInputTokens), read: tokens(k.cacheReadTokens), write: tokens(k.cacheWriteTokens), output: tokens(k.outputTokens) })
    : t("agentPanel.tokensNew", { input: tokens(k.inputTokens), output: tokens(k.outputTokens) });
};

/** `fill` puts the prompt in the composer to finish; otherwise the prompt is sent as is. */
type Starter = { label: MessageKey; prompt?: MessageKey; icon: IconId; fill?: boolean };

/**
 * What a fresh thread can do — hints, not a route. Static on purpose so they appear with
 * the panel, no model call. Shaping an idea into a backlog is only offered to a project
 * with no tickets yet.
 */
const STARTERS: { fresh: Starter[]; backlog: Starter[] } = {
  fresh: [
    { label: "agentPanel.starterIdea", prompt: "agentPanel.starterIdeaPrompt", icon: "i-leaf", fill: true },
    { label: "agentPanel.starterTicket", prompt: "agentPanel.starterTicketPrompt", icon: "i-plus", fill: true },
    { label: "agentPanel.starterDoc", prompt: "agentPanel.starterDocPrompt", icon: "i-pen", fill: true },
    { label: "agentPanel.starterHelp", icon: "i-search" }
  ],
  backlog: [
    { label: "agentPanel.starterNext", prompt: "agentPanel.starterNextPrompt", icon: "i-chev" },
    { label: "agentPanel.starterGroom", prompt: "agentPanel.starterGroomPrompt", icon: "i-filter" },
    { label: "agentPanel.starterTicket", prompt: "agentPanel.starterTicketPrompt", icon: "i-plus", fill: true },
    { label: "agentPanel.starterDoc", prompt: "agentPanel.starterDocPrompt", icon: "i-pen", fill: true }
  ]
};

type Translate = ReturnType<typeof useI18n>["t"];

const duration = (t: Translate, ms: number) => {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? t("agentPanel.secondsShort", { n: secs }) : t("agentPanel.minSecShort", { m: Math.floor(secs / 60), s: String(secs % 60).padStart(2, "0") });
};

/** Engines say why a request failed in English; the common causes read in the person's language. */
const retryReason = (t: Translate, reason: string) => {
  if (reason === "connection dropped") return t("agentPanel.reasonDropped");
  const silent = /^no response in (\d+)s$/.exec(reason);
  return silent ? t("agentPanel.reasonNoResponse", { s: silent[1] }) : reason;
};

/** The pulse that says "not stuck": what it's doing, for how long, and the tokens so far — or, loudly, that requests are failing. */
function WorkingLine({ startedAt, progress, streaming }: { startedAt: number; progress: RunProgress | null; streaming: boolean }) {
  const { t } = useI18n();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const retry = progress?.retry ?? null;
  const label = retry
    ? retry.max ? t("agentPanel.retrying", { n: retry.attempt, max: retry.max }) : t("agentPanel.retryingOpen", { n: retry.attempt })
    : progress?.activity ?? (streaming ? t("agentPanel.writing") : t("agentPanel.thinking"));
  const left = retry?.delayMs !== undefined ? retry.since + retry.delayMs - Date.now() : 0;
  return (
    <p className={`working${retry ? " retrying" : ""}`} aria-live={retry ? "polite" : "off"}>
      <span className="w-tick" />
      {retry && <Icon name="i-warn" size={11} />}
      <span className="num w-label">{label}</span>
      {retry ? (
        <span className="w-why">
          {retryReason(t, retry.reason)} · {left > 0 ? t("agentPanel.retryNextIn", { s: Math.ceil(left / 1000) }) : t("agentPanel.retryWaiting")}
        </span>
      ) : (
        <span className="w-dots">
          <span />
          <span />
          <span />
        </span>
      )}
      <span className="num w-meta">
        {duration(t, Date.now() - startedAt)}
        {progress?.usage ? ` · ↑${tokens(progress.usage.inputTokens)} ↓${tokens(progress.usage.outputTokens)} tok` : ""}
      </span>
    </p>
  );
}

/** A stretch of failed model requests, kept in the transcript once it is over. Never folded. */
function RetryRow({ block }: { block: Block & { type: "retry" } }) {
  const { t } = useI18n();
  return (
    <p className={`retry-row${block.recovered ? "" : " failed"}`}>
      <Icon name="i-warn" size={11} />
      <span>{t(block.recovered ? "agentPanel.retryRecovered" : "agentPanel.retryGaveUp", { n: block.attempts, reason: retryReason(t, block.reason), time: duration(t, block.ms) })}</span>
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
  const { t } = useI18n();
  const state = traceState(block);
  const result = block.commandResult;
  // the arguments are printed once someone opens the row, not for every folded one
  const [open, setOpen] = useState(false);
  return (
    <details className={`trace-row${state.failed ? " failed" : ""}`} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Icon name={state.icon} size={11} />
        <span className="t-tool num">{block.tool}</span>
        <span className="t-sum">{block.summary}</span>
        {state.label && <span>{t(state.label)}</span>}
        {block.ms > 0 && <span className="t-ms num">{block.ms < 1000 ? `${block.ms}ms` : `${(block.ms / 1000).toFixed(1)}s`}</span>}
      </summary>
      {open && <>
        <pre>{JSON.stringify(block.args, null, 2)}</pre>
        {result && <pre>{t("agentPanel.commandExitCode", { code: result.exitCode ?? t("agentPanel.commandExitUnknown") })}{"\n"}{result.output.trim() ? result.output : t("agentPanel.commandNoOutput")}</pre>}
      </>}
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

function RunFoot({ block, run, byKey, onOpenIssue, onRevert, busy, hint }: { block: Block & { type: "changes" }; run: RunView | undefined; byKey: Map<string, Item>; onOpenIssue: (id: string) => void; onRevert: (runId: string) => void; busy: boolean; hint?: boolean }) {
  const { t } = useI18n();
  const meta = run ? [run.engine, run.costUsd != null ? `$${run.costUsd.toFixed(3)}` : null,
    run.endedAt != null ? `${Math.round((run.endedAt - run.startedAt) / 1000)}s` : null,
    runTokensLabel(t, run),
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
    {hint && !run?.reverted && <Hint id="hint.revert">{t("onboarding.revertHint")}</Hint>}
    </div>
  );
}

function RunMetrics({ run }: { run: RunView | undefined }) {
  const { t } = useI18n();
  if (!run || run.endedAt == null) return null;
  const elapsed = `${Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000))}s`;
  const usage = runTokensLabel(t, run);
  const timings = [run.metrics?.readyMs != null ? `init ${Math.round(run.metrics.readyMs / 1000)}s` : null,
    run.metrics?.firstTokenMs != null ? `first ${Math.round(run.metrics.firstTokenMs / 1000)}s` : null].filter(Boolean).join(" · ");
  return <p className="meta-txt num" style={{ margin: "8px 0 0 22px" }}>{elapsed}{usage ? ` · ${usage}` : ""}{timings ? ` · ${timings}` : ""}</p>;
}

/**
 * A run that failed says what the person can do about it — the key, the
 * model's name, a moment's wait — and keeps the raw message and whatever the
 * engine knew besides under Details: folded, so a trace never floods the
 * thread, and one click from a bug report. The fix follows the engine that
 * failed: model settings for one that runs on Tomrade's models, its own sign-in
 * or settings for an agent with an account of its own. Meanwhile another ready
 * agent can take the same message, so a broken one never leaves the person stuck.
 */
function ErrorBlock({ text, details, engine, others, onOpenSettings, onRetry, onRetryWith, onTroubleshoot }: {
  text: string;
  details?: string;
  /** The engine whose turn failed, when the run says. */
  engine?: EngineView;
  /** Ready agents that could take the last message instead. */
  others: EngineView[];
  onOpenSettings: (engineId?: string) => void;
  onRetry?: () => void;
  onRetryWith?: (engineId: string) => void;
  /** Opens a troubleshooting thread about this failure. */
  onTroubleshoot?: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const signIn = useSetupInTerminal();
  const kind = modelErrorKind(text);
  const own = !!engine && !engine.usesModels;
  const head = kind === "other" ? null : own ? t(`agentPanel.errorAgent_${kind}` as MessageKey, { name: engine.title }) : t(`agentPanel.error_${kind}` as MessageKey);
  const fixable = kind === "auth" || kind === "model" || kind === "quota";
  const canSignIn = own && kind === "auth" && !!engine.setup?.signIn;
  const folded = [head ? text : null, details].filter(Boolean).join("\n\n");
  const copy = () => void navigator.clipboard?.writeText([text, details].filter(Boolean).join("\n\n")).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  });
  const retryWith = onRetryWith && others.length > 0;
  return (
    <div className="ai-error" role="alert">
      <p>{head ?? text}</p>
      {folded && (
        <details className="ai-error-details">
          <summary>{t("agentPanel.errorDetails")}</summary>
          <pre>{folded}</pre>
          <button type="button" className="btn btn-ghost btn-xs" onClick={copy}>
            <Icon name="i-copy" size={11} /> {copied ? t("agentPanel.errorCopied") : t("agentPanel.errorCopy")}
          </button>
        </details>
      )}
      {(fixable || onRetry || retryWith || onTroubleshoot) && (
        <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          {onTroubleshoot && (
            <button type="button" className="btn btn-ghost" onClick={onTroubleshoot}>
              <Icon name="i-bug" size={12} /> {t("agentPanel.troubleshoot")}
            </button>
          )}
          {fixable && !own && (
            <button type="button" className="btn btn-ghost" onClick={() => onOpenSettings()}>
              {t("agentPanel.openModelSettings")}
            </button>
          )}
          {canSignIn && (
            <button type="button" className="btn btn-ghost" disabled={signIn.isPending} onClick={() => signIn.mutate({ engineId: engine.id, step: "signIn" })}>
              {t("agentPanel.signInAgain", { name: engine.title })}
            </button>
          )}
          {fixable && own && !canSignIn && (
            <button type="button" className="btn btn-ghost" onClick={() => onOpenSettings(engine.id)}>
              {t("agentPanel.engineSettings", { name: engine.title })}
            </button>
          )}
          {onRetry && (
            <button type="button" className="btn btn-ghost" onClick={onRetry}>
              {t("agentPanel.retry")}
            </button>
          )}
          {retryWith && (
            <Menu label={t("agentPanel.retryWith")} trigger={
              <button type="button" className="btn btn-ghost">
                {t("agentPanel.retryWith")} <Icon name="i-chevdown" size={9} />
              </button>
            }>
              <MenuHead title={t("agentPanel.retryWithHead")} />
              {others.map((e) => (
                <MenuActionItem key={e.id} icon={<Icon name="i-send" size={13} />} name={e.title} onSelect={() => onRetryWith(e.id)} />
              ))}
            </Menu>
          )}
        </div>
      )}
      {signIn.data?.launched && <p className="meta-txt" style={{ marginTop: 6 }}>{t("agentPanel.signInStarted", { name: engine?.title ?? "" })}</p>}
      {signIn.data && !signIn.data.launched && <p className="meta-txt" style={{ marginTop: 6 }}>{t("agentPanel.signInManual", { command: signIn.data.command })}</p>}
    </div>
  );
}

const TranscriptRow = memo(Row);

function Row({ projectId, m, runs, cards, engines, retryEngines, pending, byKey, onOpenIssue, onAnswer, onRevert, onOpenSettings, onRetry, onRetryWith, onTroubleshoot, onCardAction, busy, hint }: { projectId: string; m: ThreadMessage; runs: Map<string, RunView>; cards: Map<string, CardView>; engines?: EngineView[]; retryEngines: EngineView[]; pending: PendingView | null; byKey: Map<string, Item>; onOpenIssue: (id: string) => void; onAnswer: (id: string, value: string | string[]) => void; onRevert: (runId: string) => void; onOpenSettings: (engineId?: string) => void; onRetry?: () => void; onRetryWith?: (engineId: string) => void; onTroubleshoot?: () => void; onCardAction: (action: CardAction, threadId: string, engineId?: string) => void; busy: boolean; hint?: boolean }) {
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
  const failedEngine = b.type === "error" && m.runId ? engines?.find((e) => e.id === runs.get(m.runId!)?.engine) : undefined;
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
    ) : b.type === "card" && b.schema === "checklist" ? (
      // the stream holds the card as it was first posted; the live one ticks as checks finish
      <ChecklistBlock title={b.title} card={(cards.get(b.id)?.data ?? b.data) as ChecklistCard} />
    ) : b.type === "card" && b.schema === "finding" ? (
      <FindingBlock card={b.data as FindingCard} engines={retryEngines} allEngines={engines ?? []} onAction={(action, engineId) => onCardAction(action, m.threadId, engineId)} />
    ) : b.type === "card" ? (
      <CardBlock block={b} />
    ) : b.type === "changes" ? (
      <RunFoot block={b} run={runs.get(b.runId)} byKey={byKey} onOpenIssue={onOpenIssue} onRevert={onRevert} busy={busy} hint={hint} />
    ) : b.type === "error" ? (
      <ErrorBlock
        text={b.text}
        details={b.details}
        engine={failedEngine}
        others={retryEngines.filter((e) => e.id !== failedEngine?.id)}
        onOpenSettings={onOpenSettings}
        onRetry={onRetry}
        onRetryWith={onRetryWith}
        onTroubleshoot={onTroubleshoot}
      />
    ) : b.type === "status" ? (
      <p className="ai-pending">{b.text}</p>
    ) : b.type === "retry" ? (
      <RetryRow block={b} />
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
  onOpenSettings: (engineId?: string) => void;
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
  // A conversation archived while on screen (its ticket finished) stays until the person opens another or the app restarts.
  const shown = useRef<string | null>(null);
  const listed = chosenThread && threads.data?.some((th) => th.id === chosenThread) ? chosenThread : null;
  const lingering = !listed && chosenThread && shown.current === chosenThread ? chosenThread : null;
  const threadId = listed ?? lingering ?? threads.data?.[0]?.id ?? null;
  shown.current = threadId;
  // Whatever follows the conversation on screen — the desktop pet — is told which one this is.
  useEffect(() => {
    if (threadId) void invoke("agent.showing", threadId).catch(() => {});
  }, [threadId]);
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
  const workdir = useWorkdir(projectId, threadId, !!threadBoardId);
  // "finished" is answered by reopening the ticket at send time, not by blocking the composer.
  const workdirProblem = threadBoardId && workdir.data?.code !== "finished" ? (workdir.data?.problem ?? null) : null;

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
  // what agents in this project wait on the person for: a count on the rail, a word in the thread list
  const attention = useAttention().filter((e) => e.projectId === projectId);
  const attentionOf = new Map(attention.flatMap((e) => (e.threadId ? [[e.threadId, e] as const] : [])));
  const attentionLabel = (e: AttentionEntry) => t(`agentPanel.attention_${e.kind}` as MessageKey);
  // the list: searchable once it is long, with what is running or waiting said beside each, and the archive a click away
  const [threadQuery, setThreadQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const archived = useArchivedThreads(projectId, showArchived);
  const unarchive = useUnarchiveThread(projectId);
  const threadTerm = threadQuery.trim().toLowerCase();
  const matchingThreads = (threads.data ?? []).filter((th) => !threadTerm || (th.title || "").toLowerCase().includes(threadTerm));
  const composer = useRef<HTMLTextAreaElement>(null);
  /** Whether the transcript follows new lines: true until the person scrolls up to read, again once they come back down. */
  const following = useRef(true);
  const panel = useRef<HTMLElement>(null);

  const onDelta = useCallback((runId: string, text: string | null) => {
    setLive((prev) => (text === null ? null : prev && prev.runId === runId ? { runId, text: prev.text + text } : { runId, text }));
  }, []);
  const onProgress = useCallback((next: RunProgress | null) => {
    setProgress((prev) => {
      if (next === null) return null;
      const same = prev?.runId === next.runId ? prev : null;
      // null clears (the tool ended, the retry went through); only an absent field keeps what was there
      return { runId: next.runId, activity: next.activity !== undefined ? next.activity : same?.activity ?? null, retry: next.retry !== undefined ? next.retry : same?.retry ?? null, usage: next.usage ?? same?.usage ?? null };
    });
  }, []);
  useAgentEvents(projectId, threadId, onDelta, onProgress);

  const runningRun = detail.data?.runs.find((r) => r.status === "running");
  const busy = !!runningRun || send.isPending || answer.isPending || uploading;
  const archivedNow = !!detail.data?.thread.archived;
  // A done ticket's conversation, brought back by hand: its next message first reopens the ticket.
  const doneTicket = !archivedNow && !detail.data?.thread.execution && detail.data?.thread.itemId ? (itemsQ.data ?? []).find((i) => i.id === detail.data!.thread.itemId && i.status === "done") ?? null : null;
  const [askReopen, setAskReopen] = useState(false);
  const [reopening, setReopening] = useState(false);
  const blocked = !!workdirProblem || archivedNow;
  const pending = detail.data?.pending ?? null;
  // Stable between renders, so a streamed reply re-renders its own line and not every row above it.
  const runs = useMemo(() => new Map((detail.data?.runs ?? []).map((r) => [r.id, r])), [detail.data?.runs]);
  const cards = useMemo(() => new Map((detail.data?.cards ?? []).map((c) => [c.id, c])), [detail.data?.cards]);
  // A troubleshooting thread runs on the troubleshooter's own engine; a new thread from it goes back to the default.
  const doctorThread = detail.data?.thread.surface === "doctor";
  const investigator = doctorThread ? ((detail.data?.thread.options as { investigator?: string } | null | undefined)?.investigator ?? null) : null;
  const [reportFor, setReportFor] = useState<string | null>(null);
  const byKey = useMemo(() => new Map((itemsQ.data ?? []).map((i) => [i.key, i])), [itemsQ.data]);
  // No thread yet: the chip shows what a new thread WOULD get, and picking an
  // engine creates the thread right there instead of doing silently nothing.
  const agentSettings = settings.data?.agent as AgentSettings | undefined;
  const usable = (id: string) => !!engines.data?.some((e) => e.id === id && e.ok);
  // The settings' engine may not run here yet — no model, say — while another does: a new thread takes the one that can answer.
  const configuredEngine = agentSettings?.defaultEngine ?? "loop";
  const defaultEngine = !engines.data || usable(configuredEngine) ? configuredEngine : (engines.data.find((e) => e.ok && !e.terminalOnly && e.capabilities.includes("backlog"))?.id ?? configuredEngine);
  const currentEngineId = detail.data?.thread.engine ?? defaultEngine;
  const engine = engines.data?.find((e) => e.id === currentEngineId);
  const permissionModes = detail.data?.thread.itemId ? engine?.permissionModes : undefined;
  const selectedPermissionMode = detail.data?.thread.permissionMode ?? permissionModes?.default;
  const activePermissionMode = runningRun ? detail.data?.activePermissionMode : undefined;
  const permissionLabel = (value?: string) => {
    const choice = permissionModes?.choices.find((c) => c.value === value);
    return choice ? permissionName(t, choice) : value;
  };
  const noEngineReady = engines.data ? !engines.data.some((e) => e.ok && !e.terminalOnly && conducts(e)) : false;

  // Quick picks: with a thread they are that thread's overrides (what Start chose), layered over the engine's
  // global options — the same knobs settings edits; without one they edit the global options a new thread would get.
  const saveSettings = useSaveSettings();
  const setOptions = useSetOptions(projectId);
  const globalOptions = (agentSettings?.engines?.[currentEngineId] ?? {}) as Record<string, unknown>;
  const threadOptions = (detail.data?.thread.engine === currentEngineId ? detail.data.thread.options : null) ?? {};
  const engineOptions = { ...globalOptions, ...threadOptions };

  // A thread opens on what the panel is showing — the same engine, the same knobs — rather than
  // resetting to the settings default. With no thread there is nothing to carry, so the chips' own
  // value (the default engine) is what the thread gets.
  const openThread = (args: { engine?: string; boardId?: string | null } = {}) =>
    newThread.mutateAsync({ engine: args.engine ?? (doctorThread ? defaultEngine : currentEngineId), boardId: args.boardId === undefined ? boardId : args.boardId, options: doctorThread ? {} : threadOptions });
  const chooseBoard = (next: string | null) => {
    if (busy || next === pickedBoardId) return;
    if (threadId) setWorkstream.mutate({ threadId, boardId: next });
    else void openThread({ boardId: next }).then((th) => pickThread(th.id));
  };
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
    if (panel.current) panel.current.style.width = `${saved ? Math.min(MAX_W, Math.max(MIN_W, Number(saved))) : DEFAULT_W}px`;
  }, [open]);

  // After layout, so a working line or question that just mounted is inside scrollHeight.
  useEffect(() => {
    const el = scroll.current;
    if (!el || !following.current) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [detail.data?.messages.length, live?.text, runningRun?.id, pending?.question.id]);

  // another thread opens at its newest line
  useEffect(() => {
    following.current = true;
  }, [threadId]);

  // A finished run hands the keyboard back to the composer only when it was the panel's to begin with.
  useEffect(() => {
    if (busy) return;
    const active = document.activeElement;
    if (!active || active === document.body || panel.current?.contains(active)) composer.current?.focus();
  }, [busy]);

  // the composer grows with what is typed, up to a few lines, then scrolls
  useLayoutEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);

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
    if (threadId && id !== threadId) { setAttachments([]); setAttachmentError(null); setAskReopen(false); }
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

  const doSend = async (text = draft.trim()) => {
    if ((!text && !attachments.length) || busy || blocked || sending.current) return;
    if (doneTicket) { setAskReopen(true); return; }
    if (attachments.some(file => !acceptedMedia.includes(file.type))) { setAttachmentError(t("agentPanel.unsupportedAttachment")); return; }
    sending.current = true; setUploading(true); setAttachmentError(null);
    try {
      let target = threadId;
      if (!target) target = (await openThread({ boardId })).id;
      else if (detail.data?.messages.length === 0 && !usable(currentEngineId) && usable(defaultEngine)) await setEngine.mutateAsync({ threadId: target, engineId: defaultEngine });
      pickThread(target);
      const refs = await Promise.all(attachments.map(async file => invoke("agent.media.upload", projectId, target!, {
        name: file.name, mime: file.type, base64: await readAttachment(file)
      })));
      following.current = true;
      await send.mutateAsync({ threadId: target, text, focus: sendFocus.length ? sendFocus : undefined, attachments: refs.length ? refs : undefined });
      setDraft(""); setAttachments([]);
    } catch (error) { setAttachmentError(error instanceof Error ? error.message : String(error)); }
    finally { sending.current = false; setUploading(false); }
  };

  const reopenAndSend = async () => {
    if (!doneTicket || !threadId || reopening) return;
    setReopening(true); setAttachmentError(null);
    try {
      await invoke("items.update", projectId, doneTicket.id, { status: "doing" }, doneTicket.version);
      const result = await invoke("codeLink.start", projectId, doneTicket.id, { mode: "run", engine: detail.data?.thread.engine, threadId, message: draft.trim() });
      if (!result.ok) { setAttachmentError(result.message); return; }
      following.current = true;
      setDraft(""); setAskReopen(false);
      pickThread(result.threadId);
    } catch (error) { setAttachmentError(error instanceof Error ? error.message : String(error)); }
    finally { setReopening(false); }
  };

  // Hidden once anything is typed or attached, so a click never overwrites the user's own words.
  const empty = threadId ? detail.data?.messages.length === 0 : true;
  // The hint about undoing rides on the newest set of changes only.
  const lastChangesId = [...(detail.data?.messages ?? [])].reverse().find((m) => m.block.type === "changes")?.id ?? null;
  const newestLast = [...(detail.data?.messages ?? [])].reverse();
  const folded = useMemo(() => foldSteps(detail.data?.messages ?? []), [detail.data?.messages]);
  const lastErrorId = newestLast[0]?.block.type === "error" ? newestLast[0].id : null;
  const lastAskedBlock = newestLast.find((m) => m.role === "user" && m.block.type === "text")?.block;
  const lastAsked = lastAskedBlock?.type === "text" ? lastAskedBlock.text : null;
  const starters =
    empty && itemsQ.data && !detail.data?.thread.itemId && !busy && !draft && !attachments.length
      ? STARTERS[itemsQ.data.length ? "backlog" : "fresh"]
      : [];
  const pickStarter = (starter: Starter) => {
    const text = t(starter.prompt ?? starter.label);
    if (!starter.fill) return void doSend(text);
    setDraft(text);
    requestAnimationFrame(() => {
      composer.current?.focus();
      composer.current?.setSelectionRange(text.length, text.length);
    });
  };

  const doAnswer = (questionId: string, value: string | string[]) => {
    if (!threadId || answer.isPending || (busy && pending?.kind !== "permission")) return;
    answer.mutate({ threadId, questionId, value });
  };
  // rows take callbacks that keep their identity; each reads the latest render's handlers
  const latest = useRef({ doAnswer, revert: revert.mutate, onOpenSettings });
  latest.current = { doAnswer, revert: revert.mutate, onOpenSettings };
  const answerRow = useCallback((questionId: string, value: string | string[]) => latest.current.doAnswer(questionId, value), []);
  const revertRow = useCallback((runId: string) => latest.current.revert(runId), []);
  const settingsRow = useCallback((engineId?: string) => latest.current.onOpenSettings(engineId), []);
  const reportError = useErrorToast();
  const toast = useToast();
  const setupInTerminal = useSetupInTerminal();
  // Only with the troubleshooter plugin on; it opens its own thread about the failure.
  const canTroubleshoot = !!engines.data?.some((e) => e.id === "doctor") && !doctorThread;
  const troubleshoot = (failedThread: string, runId: string | null) =>
    void invoke("doctor.start", projectId, { threadId: failedThread, ...(runId ? { runId } : {}) }).then(({ threadId: id }) => pickThread(id), reportError);
  // What a finding's buttons do: the backend worded them, the verbs are the panel's.
  const cardAction = async (action: CardAction, inThread: string, engineId?: string) => {
    try {
      if (action.kind === "install" || action.kind === "sign-in") {
        const started = await setupInTerminal.mutateAsync({ engineId: action.engineId, step: action.kind === "install" ? "install" : "signIn" });
        toast({ body: started.launched ? t("doctor.inTerminal") : t("agentPanel.signInManual", { command: started.command }) });
      } else if (action.kind === "settings") onOpenSettings(action.engineId);
      else if (action.kind === "report") setReportFor(inThread);
      else if (action.kind === "investigate" && engineId) await invoke("doctor.investigate", projectId, inThread, engineId);
      else if (action.kind === "say") { if (!busy) await send.mutateAsync({ threadId: inThread, text: action.text }); }
      else if (action.kind === "retry-with" && engineId) {
        const target = await invoke("agent.thread", projectId, action.threadId);
        const asked = [...target.messages].reverse().find((m) => m.role === "user" && m.block.type === "text")?.block;
        await setEngine.mutateAsync({ threadId: action.threadId, engineId });
        pickThread(action.threadId);
        if (asked?.type === "text") await send.mutateAsync({ threadId: action.threadId, text: asked.text });
      }
    } catch (error) {
      reportError(error);
    }
  };
  const actions = useRef({ cardAction, troubleshoot });
  actions.current = { cardAction, troubleshoot };
  const cardActionRow = useCallback((action: CardAction, inThread: string, engineId?: string) => void actions.current.cardAction(action, inThread, engineId), []);
  // Another agent takes the failed message: the thread moves to it, then the message goes again.
  const retryWith = async (engineId: string) => {
    if (!threadId || !lastAsked || busy) return;
    await setEngine.mutateAsync({ threadId, engineId });
    await doSend(lastAsked);
  };
  // A ticket's coding thread stays with agents that can code.
  const needsCode = !!detail.data?.thread.itemId && !!engine?.capabilities.includes("code");
  const retryEngines = useMemo(
    () => (engines.data ?? []).filter((e) => e.ok && !e.terminalOnly && conducts(e) && (!needsCode || e.capabilities.includes("code"))),
    [engines.data, needsCode]
  );

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
        <button type="button" className="btn btn-icon rail-btn" title={t("agentPanel.expandAssistant")} aria-label={t("agentPanel.expandAssistantAria")} onClick={() => onToggle(true)}>
          <Icon name="i-panel" size={15} />
          {attention.length > 0 && (
            <span className="rail-badge num" role="status" title={attention.map(attentionLabel).join(" · ")} aria-label={t("agentPanel.waitingBadge", { n: attention.length })}>
              {attention.length}
            </span>
          )}
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
                onClick={() => void openThread({ boardId }).then((th) => pickThread(th.id))}
              >
                <Icon name="i-plus" size={13} />
              </button>
            }
          />
          {(threads.data?.length ?? 0) > 6 && (
            <div className="menu-search">
              <input
                className="input"
                type="search"
                aria-label={t("agentPanel.searchThreads")}
                placeholder={t("agentPanel.searchThreads")}
                value={threadQuery}
                // the menu's typeahead would take the keys otherwise
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => setThreadQuery(e.target.value)}
              />
            </div>
          )}
          {threadTerm && matchingThreads.length === 0 && <p className="meta-txt dense menu-note">{t("agentPanel.noThreadsMatch")}</p>}
          {matchingThreads.length > 30 && <p className="meta-txt dense menu-note">{t("agentPanel.moreThreads", { n: matchingThreads.length - 30 })}</p>}
          {matchingThreads.slice(0, 30).map((th) => (
            <MenuRadioItem
              key={th.id}
              checked={th.id === threadId}
              name={th.title || t("agentPanel.newThread")}
              chips={th.origins}
              sub={[attentionOf.has(th.id) ? attentionLabel(attentionOf.get(th.id)!) : th.running ? t("agentPanel.threadRunning") : th.parkedUntil ? t("agentPanel.parkedUntil", { time: clockLabel(th.parkedUntil) }) : null, timeAgo(th.updatedAt)].filter(Boolean).join(" · ")}
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
          <div className="menu-foot">
            <MenuActionItem icon={<Icon name="i-archive" size={13} />} name={showArchived ? t("agentPanel.hideArchived") : t("agentPanel.showArchived")} keepOpen onSelect={() => setShowArchived((v) => !v)} />
            {showArchived && (archived.data ?? []).length === 0 && <p className="meta-txt dense menu-note">{t("agentPanel.noArchived")}</p>}
            {showArchived &&
              (archived.data ?? []).map((th) => (
                <MenuRadioItem
                  key={th.id}
                  checked={false}
                  name={th.title || t("agentPanel.newThread")}
                  chips={th.origins}
                  sub={timeAgo(th.updatedAt)}
                  onSelect={() => unarchive.mutate(th.id, { onSuccess: () => pickThread(th.id) })}
                  actions={
                    <button type="button" className="btn btn-icon" title={t("agentPanel.restoreThread")} aria-label={t("agentPanel.restoreThread")} onClick={() => unarchive.mutate(th.id)}>
                      <Icon name="i-undo" size={12} />
                    </button>
                  }
                />
              ))}
          </div>
        </Menu>
        <button type="button" className="btn btn-icon" title={t("agentPanel.collapsePanel")} aria-label={t("agentPanel.collapseAssistantAria")} onClick={() => onToggle(false)}>
          <Icon name="i-panel" size={15} />
        </button>
      </div>

      <div
        className="ai-scroll"
        ref={scroll}
        role="log"
        aria-live="polite"
        aria-busy={busy}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {(noEngineReady || (empty && !detail.data?.thread.itemId)) && <SetupCard onOpenSettings={onOpenSettings} />}
        {empty && !noEngineReady && (
          <div className="turn turn-ai">
            <div className="turn-mark">
              <span className="prov-tick" style={{ height: 12 }} />
            </div>
            <div className="turn-body">
              <p>{t("agentPanel.introMessage")}</p>
              {!!starters.length && (
                <div className="starters" role="group" aria-label={t("agentPanel.startersAria")}>
                  {starters.map((starter) => (
                    <button key={starter.label} type="button" className="starter" disabled={blocked} title={workdirProblem ?? undefined} onClick={() => pickStarter(starter)}>
                      <Icon name={starter.icon} size={12} />
                      {t(starter.label)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {folded.map((entry) => "fold" in entry ? (
          <details key={`fold-${entry.fold[0].id}`} className="trace-fold">
            <summary>
              <Icon name="i-chev" size={10} />
              <span>{t("agentPanel.earlierSteps", { n: entry.fold.length })}</span>
            </summary>
            {entry.fold.map((m) => <TranscriptRow key={m.id} projectId={projectId} m={m} runs={runs} pending={pending} byKey={byKey} onOpenIssue={onOpenIssue} onAnswer={answerRow} onRevert={revertRow} onOpenSettings={settingsRow} engines={engines.data} retryEngines={retryEngines} onCardAction={cardActionRow} cards={cards} busy={busy} />)}
          </details>
        ) : (m => (
          <TranscriptRow
            key={m.id}
            projectId={projectId}
            m={m}
            runs={runs}
            pending={pending}
            byKey={byKey}
            onOpenIssue={onOpenIssue}
            onAnswer={answerRow}
            onRevert={revertRow}
            onOpenSettings={settingsRow}
            engines={engines.data}
            retryEngines={retryEngines}
            // only the newest failure, and only while nothing runs: try the last message again
            onRetry={m.id === lastErrorId && lastAsked && !busy ? () => void doSend(lastAsked) : undefined}
            onRetryWith={m.id === lastErrorId && lastAsked && !busy && threadId ? (engineId) => void retryWith(engineId) : undefined}
            onTroubleshoot={m.id === lastErrorId && canTroubleshoot && !busy ? () => actions.current.troubleshoot(m.threadId, m.runId) : undefined}
            onCardAction={cardActionRow}
            cards={cards}
            busy={busy}
            hint={m.id === lastChangesId}
          />
        ))(entry))}
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
        <div className="ai-composer" data-busy={busy || undefined}>
          <input ref={fileInput} type="file" multiple accept={acceptedMedia.join(",")} style={{ display: "none" }} onChange={event => {
            addAttachments(Array.from(event.target.files ?? [])); event.target.value = "";
          }} />
          <button type="button" className="btn btn-icon" aria-label={t("agentPanel.attachMedia")} title={t(acceptedMedia.length ? "agentPanel.attachMedia" : "agentPanel.unsupportedAttachment")} disabled={busy || archivedNow || !acceptedMedia.length} onClick={() => fileInput.current?.click()}>+</button>
          {/* typing stays open while the agent works — the next message can wait in here; only sending waits */}
          <textarea
            ref={composer}
            className="ai-input"
            rows={1}
            placeholder={archivedNow ? t("agentPanel.archivedPlaceholder") : doneTicket ? t("agentPanel.reopenPlaceholder", { key: doneTicket.key }) : pending ? t("agentPanel.answerPlaceholder") : doctorThread ? t("doctor.placeholder") : t("agentPanel.messagePlaceholder")}
            disabled={archivedNow}
            aria-label={t("agentPanel.messageAria")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); addAttachments(Array.from(event.clipboardData.files)); } }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              void doSend();
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
        {askReopen && doneTicket && (
          <p className="ai-workdir meta-txt dense" role="alertdialog" style={{ margin: "6px 0 0", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span>{t("agentPanel.reopenAsk", { key: doneTicket.key })}</span>
            <button type="button" className="btn btn-ghost" style={{ padding: "0 6px" }} disabled={reopening} onClick={() => void reopenAndSend()}>{t("agentPanel.reopenAndSend")}</button>
            <button type="button" className="btn btn-ghost" style={{ padding: "0 6px" }} disabled={reopening} onClick={() => setAskReopen(false)}>{t("common.cancel")}</button>
          </p>
        )}
        {archivedNow && threadId && (
          <p className="ai-workdir meta-txt dense" style={{ margin: "6px 0 0", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span>{t("agentPanel.archivedHere")}</span>
            <button type="button" className="btn btn-ghost" style={{ padding: "0 6px" }} disabled={unarchive.isPending} onClick={() => unarchive.mutate(threadId)}>
              {t("agentPanel.restoreThread")}
            </button>
          </p>
        )}
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
          {doctorThread ? (
            // the troubleshooter conducts its own threads; nothing to switch to here
            <span className="tag" title={t("agentPanel.whoConducts")}>
              {engine?.title ?? currentEngineId}
              {investigator ? ` · ${engines.data?.find((e) => e.id === investigator)?.title ?? investigator}` : ""}
            </span>
          ) : (
          <Menu
            label={t("agentPanel.engineLabel")}
            align="end"
            // the window does not refetch on focus: a CLI signed in or a model saved meanwhile shows the next time this opens
            onOpenChange={(open) => { if (open) void engines.refetch(); }}
            trigger={
              <button type="button" className="tag chip-btn" title={t("agentPanel.whoConducts")}>
                {engine?.title ?? currentEngineId}
                {engine && !engine.ok && <Icon name="i-warn" size={11} />}
                <Icon name="i-chevdown" size={9} />
              </button>
            }
          >
            <MenuHead title={t("agentPanel.whoDoesWork")} />
            {/* An engine that is not set up, or fails its check, cannot conduct: it is greyed and leads to its Settings row. */}
            {[...(engines.data ?? [])].filter((e) => !e.terminalOnly && conducts(e)).sort((a, b) => Number(b.ok) - Number(a.ok)).map((e) => (
              <MenuRadioItem
                key={e.id}
                checked={e.id === currentEngineId}
                name={e.title}
                sub={e.ok ? undefined : t("agentPanel.engineNotSetUp", { state: engineStateLabel(e, t, t("settingsDialog.engineUnavailable")) })}
                unready={e.ok ? undefined : t("localCli.configure")}
                title={e.ok ? undefined : e.reason}
                onSelect={() => {
                  if (!e.ok) return onOpenSettings(e.need === "model" ? undefined : e.id);
                  if (busy || e.id === currentEngineId) return;
                  if (threadId) setEngine.mutate({ threadId, engineId: e.id });
                  else void openThread({ engine: e.id, boardId }).then((th) => pickThread(th.id));
                }}
              />
            ))}
            <MenuActionItem icon={<Icon name="i-gear" size={13} />} name={t("agentPanel.manageModelsEngines")} onSelect={() => onOpenSettings()} />
          </Menu>
          )}
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
      <ReportDialog projectId={projectId} threadId={reportFor} onOpenChange={(open) => { if (!open) setReportFor(null); }} />
    </aside>
  );
}

export const aiOpenKey = STORE.open;
