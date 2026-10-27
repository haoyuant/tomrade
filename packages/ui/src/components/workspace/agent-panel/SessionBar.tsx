import { Fragment, memo, useEffect, useId, useRef, useState, type ReactElement } from "react";
import type { EngineView, PendingView } from "@tomradex/agent";
import { Icon } from "~/components/icons";
import { ContextMenu, ContextMenuActionItem } from "~/components/ui/menu";
import { ATTENTION_KEY } from "~/lib/attention";
import { findEngine } from "~/lib/agent";
import { clockLabel, timeAgo } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { keyLabel } from "~/lib/keybindings";
import { outcomeLine } from "~/lib/review";
import type { BarRow, BarStatus } from "~/lib/sessionBar";
import { rangeLabel, spanLabel } from "~/lib/sessionTime";
import type { Starting } from "~/lib/startWays";
import { askText } from "~/lib/terminalSession";

export type BarMode = "rail" | "cards";
/** What a card answers with: a terminal session's permission prompt, or an assistant question by one of its choices. */
export type CardAnswer = { which: "allow" | "deny" } | { questionId: string; value: string };

/** At most this many of a question's choices sit on its card; the rest are answered where it opens. */
const CHOICES_SHOWN = 3;
type Filter = "all" | Exclude<BarStatus, "idle">;

/** Three shapes, so the state reads without colour: a ring runs, a diamond waits, a tick ended. */
export function StatusMark({ status, size = 10 }: { status: BarStatus; size?: number }) {
  if (status === "wait") return <svg className="sbar-mark is-wait" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true"><path d="M5 0 L10 5 L5 10 L0 5 Z" /></svg>;
  if (status === "run") return <svg className="sbar-mark is-run" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.6" /></svg>;
  if (status === "done") return <svg className="sbar-mark is-done" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 L5 9 L10 3" /></svg>;
  return null;
}

/** An assistant conversation of its own can be put away or deleted here — not while its run goes, nor while it holds a permission prompt. */
const actionable = (r: BarRow) => !!r.threadId && r.status !== "run" && r.wait?.kind !== "permission";

/** The two buttons a card and a peek carry for such a conversation. */
function RowActions({ row, onArchive, onDelete }: { row: BarRow; onArchive: (threadId: string) => void; onDelete: (threadId: string) => void }) {
  const { t } = useI18n();
  return (
    <span className="sbar-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" className="btn btn-icon" title={t("agentPanel.archiveThread")} aria-label={t("agentPanel.archiveThread")} onClick={() => onArchive(row.threadId!)}>
        <Icon name="i-archive" size={12} />
      </button>
      <button type="button" className="btn btn-icon" title={t("agentPanel.deleteThread")} aria-label={t("agentPanel.deleteThread")} onClick={() => onDelete(row.threadId!)}>
        <Icon name="i-trash" size={12} />
      </button>
    </span>
  );
}

/**
 * The session bar on the panel's right edge: a column of dots to switch by, or cards that say what each is doing.
 * Memoized: the panel renders every frame a reply streams, and the bar has nothing new to show then.
 */
export const SessionBar = memo(function SessionBar({ rows, starting, openKey, mode, peeks = true, engines, pendings, onMode, onPick, onAnswer, onNew, onHistory, onArchive, onDelete }: {
  rows: BarRow[];
  /** Starts under way, before their sessions are there: on top, a dashed ring. */
  starting: readonly Starting[];
  openKey: string | null;
  mode: BarMode;
  /** Hovering or focusing a dot shows what it is doing; off, the dots show only their state. */
  peeks?: boolean;
  engines: EngineView[] | undefined;
  /** What the waiting conversations ask, by thread, for their cards to answer in place. */
  pendings: Map<string, PendingView>;
  onMode: (mode: BarMode) => void;
  onPick: (row: BarRow) => void;
  /** Answered from its card: the panel stays where it is. */
  onAnswer: (row: BarRow, answer: CardAnswer) => void;
  onNew: () => void;
  /** The look back on everything that ended, beyond the few the bar keeps. */
  onHistory: () => void;
  onArchive: (threadId: string) => void;
  /** Asks first; the panel confirms. */
  onDelete: (threadId: string) => void;
}) {
  const { t } = useI18n();
  const [peek, setPeek] = useState<{ key: string; top: number } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const peekId = useId();
  const nav = useRef<HTMLElement>(null);
  // the peek holds its buttons: it stays while the pointer crosses over to it, and goes a moment after it left either
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = () => { if (closing.current) clearTimeout(closing.current); closing.current = null; };
  const leave = () => { hold(); closing.current = setTimeout(() => setPeek(null), 200); };
  useEffect(() => () => { if (closing.current) clearTimeout(closing.current); }, []);
  // measured against the bar, so the peek sits beside its dot however far the dots have scrolled
  const peekAt = (key: string, el: HTMLElement) => {
    hold();
    if (peeks) setPeek({ key, top: el.getBoundingClientRect().top - (nav.current?.getBoundingClientRect().top ?? 0) });
  };
  const statusWord = (s: BarStatus) => t(s === "wait" ? "sessionBar.statusWait" : s === "run" ? "sessionBar.statusRun" : s === "done" ? "sessionBar.statusDone" : "sessionBar.statusIdle");
  const where = (r: BarRow) => r.cell ? t("sessionBar.whereCell", { n: r.cell }) : r.where === "panel" ? t("sessionBar.wherePanel") : r.where === "pane" ? t("sessionBar.wherePane") : r.terminalApp ? r.terminalApp.replace(/\.app$/, "") : t("sessionBar.whereOutside");
  // A dot's one word: both sides (open here and in a cell), its cell, a pane in the background, or a conversation — one writing code under another is in the background too.
  const dotWhere = (r: BarRow) =>
    r.where === "pane" ? (r.cell ? (r.key === openKey ? t("sessionBar.whereBoth") : t("sessionBar.whereCell", { n: r.cell })) : t("sessionBar.whereBackground")) : r.where === "panel" && r.depth === 1 ? t("sessionBar.whereBackground") : where(r);
  const agentName = (r: BarRow) => (r.agent ? (findEngine(engines, r.agent)?.title ?? r.agent) : null);
  const title = (r: BarRow) => r.title || t("agentPanel.newThread");
  const outcome = (r: BarRow) => (r.outcome ? outcomeLine(r.outcome, (key, vars) => t(`review.${key}`, vars)) : null);
  const said = (r: BarRow) => (r.wait ? (r.ask ? askText(r.ask, t) : r.wait.text || t(ATTENTION_KEY[r.wait.kind])) : r.status === "done" ? outcome(r) : r.activity);
  // what it is up to: continuing after a usage limit, else its state — an idle one says how long ago it moved
  const state = (r: BarRow) => (r.parkedUntil ? t("agentPanel.parkedUntil", { time: clockLabel(r.parkedUntil) }) : r.status === "idle" ? timeAgo(r.at) : statusWord(r.status));
  // a live terminal session's pane, its last lines as the pane shows them
  const tail = (r: BarRow) => (r.tail?.length ? <span className="sbar-tail mono" data-testid="sbar-tail">{r.tail.map((line, i) => <span key={i} className="sbar-tail-line">{line}</span>)}</span> : null);
  const chips = (r: BarRow) => r.origins.map((origin) => <span key={origin} className="tag neutral sbar-chip">{origin}</span>);
  const waiting = rows.filter((r) => r.status === "wait").length;
  // just started: it lands at the top of the running ones, and says so for its first minute
  const now = Date.now();
  // how long it has run or waited, or when it ran; one parked on a usage limit, when it goes on; an idle one, when it was last used
  const when = (r: BarRow) =>
    r.parkedUntil ? t("agentPanel.parkedUntil", { time: clockLabel(r.parkedUntil) }) : r.status === "wait" ? t("sessionBar.waitedFor", { d: spanLabel(now - r.at, t) }) : r.status === "run" ? t("sessionBar.ranFor", { d: spanLabel(now - r.startedAt, t) }) : r.status === "done" ? rangeLabel(r.startedAt, r.at) : timeAgo(r.at);
  const isNew = (r: BarRow) => r.status !== "done" && now - r.startedAt < 60_000;
  // A waiting card answers in place: Allow (or Deny, with no under the cursor) for a prompt on a terminal's screen, a
  // question's choices for a conversation; "look first" opens it. Nothing to press here leaves only the card.
  const ask = (r: BarRow) => {
    if (r.status !== "wait") return null;
    const pending = r.threadId ? pendings.get(r.threadId) : undefined;
    // a question with choices takes one as its answer, whether or not it also takes words; several at once are picked where it opens
    const choices = pending && !pending.question.multiple ? (pending.question.options ?? []).slice(0, CHOICES_SHOWN) : [];
    if (!r.prompt && !choices.length) return null;
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    return (
      <div className="sbar-ask" role="group" aria-label={t("sessionBar.askGroup")} data-testid="sbar-ask" onClick={stop} onKeyDown={stop}>
        <span className="sbar-ask-text">{pending?.question.text ?? said(r)}</span>
        <span className="sbar-ask-actions">
          {r.prompt === "allow" && <button type="button" className="btn btn-primary btn-xs" data-testid="sbar-allow" onClick={() => onAnswer(r, { which: "allow" })}>{t("sessionBar.allow")}</button>}
          {r.prompt === "deny" && <button type="button" className="btn btn-secondary btn-xs" data-testid="sbar-deny" onClick={() => onAnswer(r, { which: "deny" })}>{t("sessionBar.deny")}</button>}
          {pending && choices.map((choice, i) => (
            <button key={choice} type="button" className={i === 0 ? "btn btn-primary btn-xs" : "btn btn-secondary btn-xs"} data-testid="sbar-choice" onClick={() => onAnswer(r, { questionId: pending.question.id, value: choice })}>{choice}</button>
          ))}
          <button type="button" className="btn btn-secondary btn-xs" data-testid="sbar-look" onClick={() => onPick(r)}>{t("sessionBar.lookFirst")}</button>
        </span>
      </div>
    );
  };
  const count = (f: Filter) => (f === "all" ? rows.length : rows.filter((r) => r.status === f).length);
  // right-click on a dot or a card: the same two things its buttons do
  const withMenu = (r: BarRow, node: ReactElement) =>
    actionable(r) ? (
      <ContextMenu key={r.key} label={title(r)} trigger={node}>
        <ContextMenuActionItem icon={<Icon name="i-archive" size={13} />} name={t("agentPanel.archiveThread")} onSelect={() => onArchive(r.threadId!)} />
        <ContextMenuActionItem icon={<Icon name="i-trash" size={13} />} name={t("agentPanel.deleteThread")} onSelect={() => onDelete(r.threadId!)} />
      </ContextMenu>
    ) : (
      <Fragment key={r.key}>{node}</Fragment>
    );

  if (mode === "rail") {
    const live = rows.filter((r) => r.status !== "done");
    const ended = rows.filter((r) => r.status === "done");
    const shown = peeks && peek ? rows.find((r) => r.key === peek.key) : undefined;
    const dot = (r: BarRow) => withMenu(r, (
      <button
        type="button"
        className="sbar-dot"
        data-key={r.key}
        data-status={r.status}
        data-depth={r.depth || undefined}
        aria-current={r.key === openKey ? "true" : undefined}
        aria-label={`${title(r)}, ${statusWord(r.status)}`}
        aria-describedby={shown?.key === r.key ? peekId : undefined}
        onClick={() => { hold(); setPeek(null); onPick(r); }}
        onMouseEnter={(e) => peekAt(r.key, e.currentTarget)}
        onMouseLeave={leave}
        onFocus={(e) => peekAt(r.key, e.currentTarget)}
        onBlur={leave}
      >
        <span className="sbar-dot-face">
          {r.ticket ? r.ticket.replace(/^.*-/, "") : (Array.from(r.title.trim())[0] ?? "·").toUpperCase()}
          <StatusMark status={r.status} size={9} />
          {isNew(r) && <span className="sbar-new-badge">{t("sessionBar.new")}</span>}
        </span>
        <span className="sbar-dot-where">{r.status === "done" ? statusWord("done") : dotWhere(r)}</span>
      </button>
    ));
    return (
      <nav className="sbar is-rail" aria-label={t("sessionBar.label")} ref={nav}>
        <div className="sbar-head">
          <button type="button" className="btn btn-icon" title={t("sessionBar.showCards")} aria-label={t("sessionBar.showCards")} aria-expanded="false" onClick={() => onMode("cards")}>
            <Icon name="i-expand" size={13} />
          </button>
        </div>
        {waiting > 0 && (
          <span className="sbar-waiting num" role="status" aria-label={t("sessionBar.waitingCount", { n: waiting })} title={t("sessionBar.waitingCount", { n: waiting })}>
            <StatusMark status="wait" size={8} />
            {waiting}
          </span>
        )}
        <div className="sbar-dots" onScroll={() => { hold(); setPeek(null); }}>
          {starting.map((s) => (
            <span key={s.id} className="sbar-dot is-starting" data-status="start" role="status" aria-label={`${s.ticket ? `${s.ticket} ` : ""}${s.title}, ${t("codeLink.startingLine", { agent: s.agent })}`}>
              <span className="sbar-dot-face">
                {s.ticket ? s.ticket.replace(/^.*-/, "") : (Array.from(s.title.trim())[0] ?? "·").toUpperCase()}
                <span className="sbar-new-badge">{t("sessionBar.new")}</span>
              </span>
              <span className="sbar-dot-where">{t("sessionBar.statusStarting")}</span>
            </span>
          ))}
          {live.map(dot)}
          {ended.length > 0 && <span className="sbar-rule" />}
          {ended.map(dot)}
          <button type="button" className="sbar-dot sbar-new" title={t("agentPanel.newThread")} aria-label={t("agentPanel.newThread")} onClick={onNew}>
            <span className="sbar-dot-face"><Icon name="i-plus" size={13} /></span>
          </button>
          <button type="button" className="sbar-dot sbar-history" data-testid="sbar-history" title={t("review.historyNote")} aria-label={t("review.history")} onClick={onHistory}>
            <span className="sbar-dot-face"><Icon name="i-history" size={13} /></span>
            <span className="sbar-dot-where">{t("review.history")}</span>
          </button>
        </div>
        {shown && (
          <div id={peekId} role="tooltip" className="sbar-peek" data-status={shown.status} style={{ top: peek!.top }} onMouseEnter={hold} onMouseLeave={leave}>
            <span className="sbar-peek-title">
              <span>{shown.ticket ? `${shown.ticket} ${title(shown)}` : title(shown)}</span>
              {chips(shown)}
            </span>
            <span className="meta-txt dense">{[agentName(shown), where(shown), shown.status === "idle" ? statusWord("idle") : null, state(shown)].filter(Boolean).join(" · ")}</span>
            {tail(shown)}
            {said(shown) && (shown.status !== "run" || !shown.tail?.length) && <span className={shown.status === "wait" ? "sbar-peek-wait" : "sbar-peek-said"}>{shown.status === "done" ? t("sessionBar.outcome", { text: said(shown)! }) : said(shown)}</span>}
            <span className="sbar-peek-foot">
              <span className="meta-txt dense">{`${t("sessionBar.peekHint")} · ${t("sessionBar.peekExpand", { key: keyLabel("sessionBar") })}`}</span>
              {actionable(shown) && <RowActions row={shown} onArchive={onArchive} onDelete={onDelete} />}
            </span>
          </div>
        )}
      </nav>
    );
  }

  const shown = rows.filter((r) => filter === "all" || r.status === filter);
  return (
    <nav className="sbar is-cards" aria-label={t("sessionBar.label")}>
      <div className="sbar-head">
        <button type="button" className="btn btn-icon" title={t("sessionBar.showRail")} aria-label={t("sessionBar.showRail")} aria-expanded="true" onClick={() => onMode("rail")}>
          <Icon name="i-shrink" size={13} />
        </button>
        <span className="sbar-head-title">{t("sessionBar.label")}</span>
        <button type="button" className="btn btn-icon" title={t("agentPanel.newThread")} aria-label={t("agentPanel.newThread")} onClick={onNew}>
          <Icon name="i-plus" size={13} />
        </button>
      </div>
      <div className="sbar-filters" role="group" aria-label={t("sessionBar.filter")}>
        {(["all", "wait", "run", "done"] as const).map((f) => (
          <button key={f} type="button" className="sbar-filter num" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(f === "all" ? "sessionBar.filterAll" : f === "wait" ? "sessionBar.filterWait" : f === "run" ? "sessionBar.filterRun" : "sessionBar.filterDone", { n: count(f) })}
          </button>
        ))}
      </div>
      <div className="sbar-cards">
        {(filter === "all" || filter === "run") && starting.map((s) => (
          <div key={s.id} className="sbar-card is-starting" data-status="start" role="status">
            <span className="sbar-card-title">
              <span className="start-starting-mark" aria-hidden="true" />
              <span>{s.ticket ? `${s.ticket} ${s.title}` : s.title}</span>
              <span className="sbar-new-badge">{t("sessionBar.new")}</span>
            </span>
            <span className="meta-txt dense">{t("codeLink.startingLine", { agent: s.agent })}</span>
          </div>
        ))}
        {shown.map((r) => withMenu(r, (
          // a div, so the card's own buttons sit inside it; Enter and Space open it as a button would
          <div role="button" tabIndex={0} className="sbar-card" data-key={r.key} data-status={r.status} data-depth={r.depth || undefined} aria-current={r.key === openKey ? "true" : undefined} onClick={() => onPick(r)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(r); } }}>
            <span className="sbar-card-title">
              <StatusMark status={r.status} />
              <span>{r.ticket ? `${r.ticket} ${title(r)}` : title(r)}</span>
              {chips(r)}
              {isNew(r) && <span className="sbar-new-badge">{t("sessionBar.new")}</span>}
              {actionable(r) && <RowActions row={r} onArchive={onArchive} onDelete={onDelete} />}
            </span>
            <span className="meta-txt dense">{[agentName(r), r.status === "done" ? statusWord("done") : where(r), when(r)].filter(Boolean).join(" · ")}</span>
            {tail(r)}
            {ask(r) ?? (said(r) && (r.status !== "run" || !r.tail?.length) && <span className={r.status === "wait" ? "sbar-card-wait" : r.status === "done" ? "sbar-card-outcome" : "sbar-card-said"}>{said(r)}</span>)}
          </div>
        )))}
        {!shown.length && !starting.length && <p className="meta-txt dense sbar-empty">{t("sessionBar.empty")}</p>}
      </div>
      <div className="sbar-foot">
        <span>{t("review.historyNote")}</span>
        <button type="button" className="btn btn-secondary btn-xs" data-testid="sbar-history" onClick={onHistory}>
          <Icon name="i-history" size={11} /> {t("review.history")}
        </button>
      </div>
    </nav>
  );
});
