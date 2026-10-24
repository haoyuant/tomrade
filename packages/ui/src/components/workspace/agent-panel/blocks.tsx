import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Block, EngineView, FocusRef, PendingView, RunView, ThreadMessage } from "@tomradex/agent";
import type { Item, ModelErrorKind } from "@tomradex/domain";
import { modelErrorKind } from "@tomradex/domain/model-errors";
import { Icon } from "~/components/icons";
import { Hint } from "~/components/ui/hint";
import { Menu, MenuActionItem, MenuHead } from "~/components/ui/menu";
import { PRIORITY_LABEL, WORK_TYPE_KEY } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { traceState } from "~/lib/steps";
import type { RunProgress } from "~/lib/agent";
import { offerStart, permissionLabel, useMergeTicket, useResolveMerge, useStartTickets } from "~/lib/codeLink";
import { useEngines } from "~/lib/agent";
import { useAgentDock } from "~/components/chrome/ProjectShell";
import { openExternal } from "~/lib/shell";
import type { MergeCard, StartBatchCard } from "@tomradex/code-link";
import { useSetupInTerminal } from "~/lib/setup";
import { useImShareNext, useImThreadBindings } from "~/lib/im";
import { isCancelKey, isCommitKey, isComposing } from "~/lib/keys";
import { useFilesInfo } from "~/lib/files";
import { openExternal, openPath } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { duration, retryReason, runTokensLabel, tokens } from "./format";

/** The pulse that says "not stuck": what it's doing, for how long, and the tokens so far — or, loudly, that requests are failing. */
export function WorkingLine({ startedAt, progress, streaming }: { startedAt: number; progress: RunProgress | null; streaming: boolean }) {
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
export function RetryRow({ block }: { block: Block & { type: "retry" } }) {
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

// A markdown link, a path quoted in backticks, a web or file URL, or a bare absolute path — in that order of preference.
const LINK_RE = /\[([^\]\n]+)\]\(((?:https?|file):\/\/[^\s)]+|~?\/[^\s)]+|[A-Za-z]:\\[^\s)]+)\)|`((?:~\/|\/|[A-Za-z]:\\)[^`\n]+)`|((?:https?|file):\/\/[^\s<>"'`\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]+)|((?<![\w/:.~-])(?:~\/|\/)[\w.@%+-]+(?:\/[\w.@%+-]+)+\/?|(?<![\w])[A-Za-z]:\\[^\s<>"'`\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]+)/g;
// A bare slash path counts only where it looks like a file on disk, not a route such as /api/v1.
const ON_DISK = /^(?:~\/|\/(?:Users|home|Volumes|tmp|private|opt|var|mnt)\/|[A-Za-z]:\\)|\.\w{1,8}\/?$/;

/** Sentence punctuation after a bare link belongs to the sentence; a closing bracket only when the link never opened one. */
function trimTrailing(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    if (".,;:!?'\"。，；：！？、》」』".includes(ch)) end--;
    else if (ch === ")" && raw.slice(0, end).split("(").length <= raw.slice(0, end).split(")").length - 1) end--;
    else if ((ch === "]" || ch === "）") && !raw.slice(0, end - 1).includes(ch === "]" ? "[" : "（")) end--;
    else break;
  }
  return raw.slice(0, end);
}

/** A local path from a `file://` URL, or the path as written. */
function localPath(target: string): string {
  if (!/^file:\/\//i.test(target)) return target;
  try {
    const pathname = decodeURIComponent(new URL(target).pathname);
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return target;
  }
}

function WebLink({ url, label }: { url: string; label: string }) {
  const { t } = useI18n();
  return (
    <a className="tlink" href={url} title={t("agentPanel.openLink", { target: url })} onClick={(e) => { e.preventDefault(); openExternal(url); }}>
      {label}
    </a>
  );
}

/** A file in the project's Files opens in Tomrade's own viewer; anything else on disk opens with the system's app. */
function PathLink({ projectId, target, label }: { projectId: string; target: string; label: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const files = useFilesInfo(projectId);
  const open = async () => {
    const dir = files.data?.dir?.replace(/[\\/]+$/, "");
    const inside = dir && (target.startsWith(dir + "/") || target.startsWith(dir + "\\")) ? target.slice(dir.length + 1).replace(/\\/g, "/").replace(/\/$/, "") : null;
    if (inside) return void navigate({ to: "/p/$projectId/f/$", params: { projectId, _splat: inside } });
    if (!(await openPath(target))) toast({ body: t("agentPanel.pathMissing", { target }) });
  };
  return (
    <a className="tlink" href={target} title={t("agentPanel.openPath", { target })} onClick={(e) => { e.preventDefault(); void open(); }}>
      {label}
    </a>
  );
}

function keyed(text: string, byKey: Map<string, Item>, onOpenIssue: (id: string) => void, at: number): ReactNode[] {
  return text.split(KEY_RE).map((part, i) =>
    i % 2 === 1 ? <KeyRef key={`${at}-${i}`} text={part} item={byKey.get(part)} onOpenIssue={onOpenIssue} /> : <Fragment key={`${at}-${i}`}>{part}</Fragment>
  );
}

/** Plain text with keys, links and paths live. Deliberately not a markdown renderer — the engines are told to write plainly. */
export function linkify(text: string, byKey: Map<string, Item>, onOpenIssue: (id: string) => void, projectId: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const [whole, mdLabel, mdTarget, quoted, url, bare] = m;
    const start = m.index;
    let raw = whole;
    let target: string;
    let label: string;
    if (mdTarget !== undefined) { target = mdTarget; label = mdLabel; }
    else if (quoted !== undefined) { target = quoted; label = whole; }
    else {
      raw = trimTrailing(url ?? bare);
      if (bare !== undefined && !ON_DISK.test(raw)) continue;
      target = raw;
      label = raw;
    }
    if (start > last) out.push(...keyed(text.slice(last, start), byKey, onOpenIssue, last));
    out.push(/^https?:/i.test(target)
      ? <WebLink key={`l${start}`} url={target} label={label} />
      : <PathLink key={`l${start}`} projectId={projectId} target={localPath(target)} label={label} />);
    last = start + raw.length;
  }
  if (last < text.length) out.push(...keyed(text.slice(last), byKey, onOpenIssue, last));
  return out;
}

const OP_GLYPH = { created: "+", updated: "~", deleted: "–" } as const;

export function Trace({ block }: { block: Block & { type: "trace" } }) {
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

export type StartOfferCard = { itemId: string; key: string; title: string; task?: string };

// The assistant does not carry tickets out; it hands them to the Start dialog, where the person chooses.
export function StartOffer({ card, onOpenIssue }: { card: StartOfferCard; onOpenIssue: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="tool-card" data-testid="start-offer">
      <div className="tool-head">
        <Icon name="i-plug" size={12} />
        {card.key} {card.title}
      </div>
      {card.task && <p className="tool-row" data-testid="start-offer-task">{t("codeLink.startTask", { task: card.task })}</p>}
      <p className="tool-row">{t("agentPanel.startOfferLead")}</p>
      <div className="tool-row">
        <button
          type="button"
          className="btn btn-primary btn-xs"
          onClick={() => {
            onOpenIssue(card.itemId);
            offerStart(card.itemId, card.task);
          }}
        >
          {t("agentPanel.startOffer", { key: card.key })}
        </button>
      </div>
    </div>
  );
}

/**
 * Tickets the assistant was asked to start. Until they run, the person either confirms the start
 * (a ticket just filed from their request) or picks the agent here (the conversation's own could
 * not code) and starts them all at once; then each ticket says how it went and opens its session.
 */
export function StartBatchBlock({ card, cardId, projectId, threadId, onOpenIssue }: { card: StartBatchCard; cardId: string; projectId: string; threadId: string; onOpenIssue: (id: string) => void }) {
  const { t } = useI18n();
  const engines = useEngines();
  const { showThread } = useAgentDock();
  const start = useStartTickets(projectId);
  const ready = (engines.data ?? []).filter((engine) => engine.ok && engine.capabilities.includes("code") && !engine.terminalOnly);
  const [chosenEngine, setChosenEngine] = useState<string | null>(null);
  const [chosenPermission, setChosenPermission] = useState<string | null>(null);
  const settled = card.config ?? null;
  const picking = !card.results && !settled;
  const engine = ready.find((e) => e.id === chosenEngine) ?? ready[0];
  const permissionModes = engine?.permissionModes;
  const permissionMode = permissionModes ? (chosenPermission && permissionModes.choices.some((c) => c.value === chosenPermission) ? chosenPermission : permissionModes.default) : undefined;
  const n = card.tickets.length;
  const head = card.results
    ? t(n === 1 ? "agentPanel.startBatchDoneOne" : "agentPanel.startBatchDone", { n })
    : settled
      ? t(n === 1 ? "agentPanel.startBatchConfirmOne" : "agentPanel.startBatchConfirm", { n })
      : t(n === 1 ? "agentPanel.startBatchPickOne" : "agentPanel.startBatchPick", { n });
  const go = (config: { engine: string; options?: Record<string, unknown>; permissionMode?: string }) =>
    start.mutate({ itemIds: card.tickets.map((ticket) => ticket.itemId), requestedBy: threadId, ...config, ...(card.task ? { task: card.task } : {}), cardId });
  return (
    <div className="tool-card" data-testid="start-batch" data-state={card.results ? "started" : settled ? "confirm" : "pick"}>
      <div className="tool-head">
        <Icon name="i-plug" size={12} />
        {head}
      </div>
      {card.task && <p className="tool-row" data-testid="start-batch-task">{t("codeLink.startTask", { task: card.task })}</p>}
      <ul className="tool-row start-batch-list">
        {card.tickets.map((ticket) => {
          const result = card.results?.find((r) => r.itemId === ticket.itemId);
          return (
            <li key={ticket.itemId} data-testid="start-batch-ticket" data-state={result ? (result.ok ? "started" : "stopped") : "pending"}>
              <button type="button" className="kref num" onClick={() => onOpenIssue(ticket.itemId)}>{ticket.key}</button> {ticket.title}
              {result && (
                <span className="meta-txt dense start-batch-result">
                  {result.ok
                    ? result.message
                      ? t("agentPanel.startBatchWaiting", { question: result.message })
                      : t(result.continued ? "agentPanel.startBatchContinued" : "agentPanel.startBatchStarted", { engine: findEngineTitle(engines.data, result.engine), branch: result.branch ?? "" })
                    : result.message ?? t("agentPanel.startBatchStopped")}
                  {result.ok && result.threadId && (
                    <>
                      {" · "}
                      <button type="button" className="link-btn" data-testid="start-batch-open" onClick={() => showThread(result.threadId!)}>{t("agentPanel.startBatchOpen")}</button>
                    </>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {settled && !card.results && (
        <div className="tool-row start-batch-pick">
          <span className="meta-txt dense">{t("agentPanel.startBatchWith", { engine: findEngineTitle(engines.data, settled.engine) })}</span>
          <button type="button" className="btn btn-primary btn-xs" disabled={start.isPending} data-testid="start-batch-go" onClick={() => go(settled)}>
            {start.isPending ? t("agentPanel.startBatchStarting") : t(n === 1 ? "agentPanel.startBatchGoOne" : "agentPanel.startBatchGo", { n })}
          </button>
        </div>
      )}
      {picking && (
        <>
          {card.reason && <p className="tool-row meta-txt dense">{t("agentPanel.startBatchWhy", { reason: card.reason })}</p>}
          {ready.length === 0 ? (
            <p className="tool-row meta-txt dense" data-testid="start-batch-none">{t("agentPanel.startBatchNoEngine")}</p>
          ) : (
            <div className="tool-row start-batch-pick">
              <span className="start-batch-field">
                <label className="meta-txt" htmlFor={`sb-engine-${cardId}`}>{t("agentPanel.startBatchEngine")}</label>
                <select id={`sb-engine-${cardId}`} className="select" value={engine?.id ?? ""} disabled={start.isPending} onChange={(event) => { setChosenEngine(event.target.value); setChosenPermission(null); }}>
                  {ready.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
                </select>
              </span>
              {permissionModes && (
                <span className="start-batch-field">
                  <label className="meta-txt" htmlFor={`sb-perm-${cardId}`}>{t("agentPanel.startBatchPermission")}</label>
                  <select id={`sb-perm-${cardId}`} className="select" value={permissionMode} disabled={start.isPending} onChange={(event) => setChosenPermission(event.target.value)}>
                    {permissionModes.choices.map((choice) => <option key={choice.value} value={choice.value}>{permissionLabel(t, choice)}</option>)}
                  </select>
                </span>
              )}
              <button
                type="button"
                className="btn btn-primary btn-xs"
                disabled={start.isPending || !engine}
                data-testid="start-batch-go"
                onClick={() => engine && go({ engine: engine.id, ...(permissionMode ? { permissionMode } : {}) })}
              >
                {start.isPending ? t("agentPanel.startBatchStarting") : t(n === 1 ? "agentPanel.startBatchGoOne" : "agentPanel.startBatchGo", { n })}
              </button>
            </div>
          )}
        </>
      )}
      {!card.results && start.error && <p className="tool-row meta-txt dense" data-testid="start-batch-error">{String((start.error as Error).message ?? start.error)}</p>}
    </div>
  );
}

const findEngineTitle = (engines: EngineView[] | undefined, id: string | undefined): string => engines?.find((e) => e.id === id || e.includes?.includes(id ?? ""))?.title ?? id ?? "";

/** A ticket asked for here is delivered: the pull request or branch, and the merge for the person to say — or to hand back to the session when it conflicts. */
export function MergeBlock({ card, projectId, threadId, onOpenIssue }: { card: MergeCard; projectId: string; threadId: string; onOpenIssue: (id: string) => void }) {
  const { t } = useI18n();
  const merge = useMergeTicket(projectId);
  const resolve = useResolveMerge(projectId);
  const [pending, setPending] = useState(false);
  const busy = merge.isPending || resolve.isPending || (pending && card.state === "offered");
  const conflict = card.state === "refused" && card.cause === "conflict";
  return (
    <div className="tool-card" data-testid="merge-offer" data-state={card.state}>
      <div className="tool-head">
        <Icon name="i-merge" size={12} />
        <button type="button" className="kref num" onClick={() => onOpenIssue(card.itemId)}>{card.key}</button> {card.title}
      </div>
      <p className="tool-row">
        {card.prUrl ? (
          <a href={card.prUrl} onClick={(event) => { event.preventDefault(); openExternal(card.prUrl!); }}>{card.prUrl.replace(/^https?:\/\/(www\.)?/, "")}</a>
        ) : (
          <span className="num">{t("agentPanel.mergeBranch", { branch: card.branch, base: card.base, repo: card.repo })}</span>
        )}
      </p>
      {card.state === "offered" && <p className="tool-row meta-txt dense">{t("agentPanel.mergeLead")}</p>}
      {card.state === "merged" && <p className="tool-row meta-txt dense" data-testid="merge-done">{card.message ?? t("agentPanel.mergeMerged")}</p>}
      {card.state === "resolving" && <p className="tool-row meta-txt dense" data-testid="merge-resolving">{t("agentPanel.mergeResolving")}</p>}
      {card.state === "refused" && (
        <p className="tool-row meta-txt dense" data-testid="merge-refused">
          {t("agentPanel.mergeRefused", { message: card.message ?? "" })}
          {card.cause === "dirty" && ` ${t("agentPanel.mergeDirtyHint")}`}
        </p>
      )}
      {(card.state === "offered" || card.state === "refused") && (
        <div className="tool-row">
          <button
            type="button"
            className={conflict ? "btn btn-xs" : "btn btn-primary btn-xs"}
            disabled={busy}
            data-testid="merge-go"
            onClick={() => { setPending(true); merge.mutate(card.itemId, { onSettled: () => setPending(false) }); }}
          >
            {busy && !resolve.isPending ? t("agentPanel.merging") : t(card.state === "refused" ? "agentPanel.mergeAgain" : "agentPanel.mergeButton")}
          </button>
          {conflict && (
            <button type="button" className="btn btn-primary btn-xs" disabled={busy} data-testid="merge-resolve" onClick={() => resolve.mutate({ itemId: card.itemId, requestedBy: threadId })}>
              {resolve.isPending ? t("agentPanel.startBatchStarting") : t("agentPanel.mergeResolve")}
            </button>
          )}
        </div>
      )}
      {(merge.error || resolve.error) && <p className="tool-row meta-txt dense">{String(((merge.error ?? resolve.error) as Error).message ?? merge.error ?? resolve.error)}</p>}
    </div>
  );
}

export interface ProposalCard {
  rootTitle?: string;
  epics?: { title: string; body?: string; features?: { title: string; body?: string; workType?: "coding" | "general"; priority?: number }[] }[];
  notes?: string;
}

/** The tree a plan would write, shown in full so the person can decide on the question below it. */
export function ProposalBlock({ card }: { card: ProposalCard }) {
  const { t } = useI18n();
  const epics = card.epics ?? [];
  const tickets = epics.reduce((n, epic) => n + (epic.features?.length ?? 0), 0);
  return (
    <div className="tool-card proposal">
      <div className="tool-head">
        <Icon name="i-stack" size={12} />
        {t("agentPanel.planProposal", { epics: epics.length, tickets })}
      </div>
      {card.rootTitle && <p className="proposal-root">{card.rootTitle}</p>}
      {epics.map((epic, i) => (
        <div className="proposal-epic" key={i}>
          <p className="proposal-epic-title">{epic.title}</p>
          {epic.body && <p className="proposal-body">{epic.body}</p>}
          <ul className="proposal-tickets">
            {(epic.features ?? []).map((ticket, j) => (
              <li key={j}>
                <span className="proposal-ticket-title">{ticket.title}</span>
                {ticket.workType && <span className="tag faint">{t(WORK_TYPE_KEY[ticket.workType])}</span>}
                {!!ticket.priority && <span className="tag faint">{PRIORITY_LABEL[ticket.priority]}</span>}
                {ticket.body && <p className="proposal-body">{ticket.body}</p>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {card.notes && <p className="proposal-notes">{card.notes}</p>}
    </div>
  );
}

export function CardBlock({ block }: { block: Block & { type: "card" } }) {
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
export function Question({ block, pending, onAnswer, busy }: { block: Block & { type: "question" }; pending: PendingView | null; onAnswer: (id: string, value: string | string[]) => void; busy: boolean }) {
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

export function RunFoot({ block, run, byKey, onOpenIssue, onRevert, busy, hint }: { block: Block & { type: "changes" }; run: RunView | undefined; byKey: Map<string, Item>; onOpenIssue: (id: string) => void; onRevert: (runId: string) => void; busy: boolean; hint?: boolean }) {
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

export function RunMetrics({ run }: { run: RunView | undefined }) {
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
/** What a failed turn means, from the model service; `other` (and `slow`, which only a waiting check reports) has no words of its own. */
const MODEL_ERROR_KEY: Partial<Record<ModelErrorKind, MessageKey>> = {
  auth: "agentPanel.error_auth",
  quota: "agentPanel.error_quota",
  rate: "agentPanel.error_rate",
  model: "agentPanel.error_model",
  server: "agentPanel.error_server",
  network: "agentPanel.error_network"
};
/** The same, for an agent that signs in on its own. */
const AGENT_ERROR_KEY: Partial<Record<ModelErrorKind, MessageKey>> = {
  auth: "agentPanel.errorAgent_auth",
  quota: "agentPanel.errorAgent_quota",
  rate: "agentPanel.errorAgent_rate",
  model: "agentPanel.errorAgent_model",
  server: "agentPanel.errorAgent_server",
  network: "agentPanel.errorAgent_network"
};

export function ErrorBlock({ text, details, engine, others, onOpenSettings, onRetry, onRetryWith, onTroubleshoot }: {
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
  const headKey = (own ? AGENT_ERROR_KEY : MODEL_ERROR_KEY)[kind];
  const head = headKey ? t(headKey, own ? { name: engine.title } : undefined) : null;
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

/** A message written while a run works: it goes out by itself once the run ends well. */
export type Queued = { id: string; text: string; focus: FocusRef[] };

export function QueuedRow({ entry, held, canSend, onSave, onRemove, onSendNow, onSteer }: { entry: Queued; held: boolean; canSend: boolean; onSave: (text: string) => void; onRemove: () => void; onSendNow: () => void; onSteer?: () => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="ai-queued" data-held={held || undefined}>
      <span className="q-state">{t(held ? "agentPanel.queuedHeld" : "agentPanel.queued")}</span>
      {editing === null ? (
        <p className="q-text" title={entry.text}>{entry.text}</p>
      ) : (
        <textarea
          className="input q-edit"
          aria-label={t("agentPanel.queuedEdit")}
          autoFocus
          rows={Math.min(4, editing.split("\n").length)}
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            if (isCancelKey(e)) { e.preventDefault(); e.stopPropagation(); setEditing(null); }
            else if (isCommitKey(e) && !e.shiftKey) {
              e.preventDefault();
              if (editing.trim()) onSave(editing.trim()); else onRemove();
              setEditing(null);
            }
          }}
        />
      )}
      <span className="q-actions">
        {held && canSend && (
          <button type="button" className="btn btn-ghost btn-xs" onClick={onSendNow}>{t("agentPanel.queuedSendNow")}</button>
        )}
        {onSteer && (
          <button type="button" className="btn btn-ghost btn-xs" title={t("agentPanel.steerNowTitle")} onClick={onSteer}>{t("agentPanel.steerNow")}</button>
        )}
        <button type="button" className="btn btn-icon" title={t("agentPanel.queuedEdit")} aria-label={t("agentPanel.queuedEdit")} onClick={() => setEditing(editing === null ? entry.text : null)}>
          <Icon name="i-pen" size={11} />
        </button>
        <button type="button" className="btn btn-icon" title={t("agentPanel.queuedRemove")} aria-label={t("agentPanel.queuedRemove")} onClick={onRemove}>
          <Icon name="i-trash" size={11} />
        </button>
      </span>
    </div>
  );
}

/**
 * The brief that opened a ticket's session, folded: it is the machine's words,
 * long and fixed, and nobody reads it twice. The person's own messages stay
 * as they are — this is only the first line they did not write.
 */
export function StartBrief({ m }: { m: ThreadMessage }) {
  const { t } = useI18n();
  const text = m.block.type === "text" ? m.block.text : "";
  return (
    <details className="turn turn-user turn-brief">
      <summary>{t("agentPanel.startBrief")}</summary>
      <p>{text}</p>
    </details>
  );
}

/**
 * A conversation bound to an IM group: its desktop turns stay on the desktop
 * unless the person shares the next one with the group, here.
 */
export function ImGroupShare({ projectId, threadId }: { projectId: string; threadId: string }) {
  const { t } = useI18n();
  const bindings = useImThreadBindings(projectId, threadId);
  const share = useImShareNext();
  const groups = (bindings.data ?? []).filter((b) => b.group);
  if (!groups.length) return null;
  return (
    <>
      {groups.map((g) => (
        <div key={g.id} className="ai-queued" data-testid="im-group-share">
          <span className="q-state">{t("agentPanel.imGroup")}</span>
          <p className="q-text" title={g.conversationId}>
            {g.shareNext ? t("agentPanel.imGroupSharing", { group: g.conversationId }) : t("agentPanel.imGroupPrivate", { group: g.conversationId })}
          </p>
          <button type="button" className="btn btn-ghost" disabled={share.isPending} onClick={() => share.mutate([g.id, !g.shareNext])}>
            {g.shareNext ? t("common.cancel") : t("agentPanel.imGroupShare")}
          </button>
        </div>
      ))}
    </>
  );
}
