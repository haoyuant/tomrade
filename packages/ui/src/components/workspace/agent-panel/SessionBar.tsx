import { memo, useId, useRef, useState } from "react";
import type { EngineView } from "@tomradex/agent";
import { Icon } from "~/components/icons";
import { ATTENTION_KEY } from "~/lib/attention";
import { findEngine } from "~/lib/agent";
import { timeAgo } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import type { BarRow, BarStatus } from "~/lib/sessionBar";

export type BarMode = "rail" | "cards";
type Filter = "all" | Exclude<BarStatus, "idle">;

/** Three shapes, so the state reads without colour: a ring runs, a diamond waits, a tick ended. */
export function StatusMark({ status, size = 10 }: { status: BarStatus; size?: number }) {
  if (status === "wait") return <svg className="sbar-mark is-wait" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true"><path d="M5 0 L10 5 L5 10 L0 5 Z" /></svg>;
  if (status === "run") return <svg className="sbar-mark is-run" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.6" /></svg>;
  if (status === "done") return <svg className="sbar-mark is-done" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 L5 9 L10 3" /></svg>;
  return null;
}

/**
 * The session bar on the panel's right edge: a column of dots to switch by, or cards that say what each is doing.
 * Memoized: the panel renders every frame a reply streams, and the bar has nothing new to show then.
 */
export const SessionBar = memo(function SessionBar({ rows, openKey, mode, engines, onMode, onPick, onNew, onHistory }: {
  rows: BarRow[];
  openKey: string | null;
  mode: BarMode;
  engines: EngineView[] | undefined;
  onMode: (mode: BarMode) => void;
  onPick: (row: BarRow) => void;
  onNew: () => void;
  /** The look back on everything that ended, beyond the few the bar keeps. */
  onHistory: () => void;
}) {
  const { t } = useI18n();
  const [peek, setPeek] = useState<{ key: string; top: number } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const peekId = useId();
  const nav = useRef<HTMLElement>(null);
  // measured against the bar, so the peek sits beside its dot however far the dots have scrolled
  const peekAt = (key: string, el: HTMLElement) => setPeek({ key, top: el.getBoundingClientRect().top - (nav.current?.getBoundingClientRect().top ?? 0) });
  const statusWord = (s: BarStatus) => t(s === "wait" ? "sessionBar.statusWait" : s === "run" ? "sessionBar.statusRun" : s === "done" ? "sessionBar.statusDone" : "sessionBar.statusIdle");
  const where = (r: BarRow) => r.where === "panel" ? t("sessionBar.wherePanel") : r.where === "pane" ? t("sessionBar.wherePane") : r.terminalApp ? r.terminalApp.replace(/\.app$/, "") : t("sessionBar.whereOutside");
  const agentName = (r: BarRow) => (r.agent ? (findEngine(engines, r.agent)?.title ?? r.agent) : null);
  const title = (r: BarRow) => r.title || t("agentPanel.newThread");
  const said = (r: BarRow) => (r.wait ? r.wait.text || t(ATTENTION_KEY[r.wait.kind]) : r.status === "done" ? r.outcome : r.activity);
  const waiting = rows.filter((r) => r.status === "wait").length;
  // just started: it lands at the top of the running ones, and says so for its first minute
  const now = Date.now();
  const isNew = (r: BarRow) => r.status !== "done" && now - r.startedAt < 60_000;
  const count = (f: Filter) => (f === "all" ? rows.length : rows.filter((r) => r.status === f).length);

  if (mode === "rail") {
    const live = rows.filter((r) => r.status !== "done");
    const ended = rows.filter((r) => r.status === "done");
    const shown = peek ? rows.find((r) => r.key === peek.key) : undefined;
    const dot = (r: BarRow) => (
      <button
        key={r.key}
        type="button"
        className="sbar-dot"
        data-status={r.status}
        data-depth={r.depth || undefined}
        aria-current={r.key === openKey ? "true" : undefined}
        aria-label={`${title(r)}, ${statusWord(r.status)}`}
        aria-describedby={peek?.key === r.key ? peekId : undefined}
        onClick={() => { setPeek(null); onPick(r); }}
        onMouseEnter={(e) => peekAt(r.key, e.currentTarget)}
        onMouseLeave={() => setPeek(null)}
        onFocus={(e) => peekAt(r.key, e.currentTarget)}
        onBlur={() => setPeek(null)}
      >
        <span className="sbar-dot-face">
          {r.ticket ? r.ticket.replace(/^.*-/, "") : (Array.from(r.title.trim())[0] ?? "·").toUpperCase()}
          <StatusMark status={r.status} size={9} />
          {isNew(r) && <span className="sbar-new-badge">{t("sessionBar.new")}</span>}
        </span>
        <span className="sbar-dot-where">{r.status === "done" ? statusWord("done") : where(r)}</span>
      </button>
    );
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
        <div className="sbar-dots" onScroll={() => setPeek(null)}>
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
          <div id={peekId} role="tooltip" className="sbar-peek" data-status={shown.status} style={{ top: peek!.top }}>
            <span className="sbar-peek-title">{shown.ticket ? `${shown.ticket} ${title(shown)}` : title(shown)}</span>
            <span className="meta-txt dense">{[agentName(shown), where(shown), statusWord(shown.status)].filter(Boolean).join(" · ")}</span>
            {said(shown) && <span className={shown.status === "wait" ? "sbar-peek-wait" : "sbar-peek-said"}>{shown.status === "done" ? t("sessionBar.outcome", { text: said(shown)! }) : said(shown)}</span>}
            <span className="meta-txt dense">{t("sessionBar.peekHint")}</span>
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
        {shown.map((r) => (
          <button key={r.key} type="button" className="sbar-card" data-status={r.status} data-depth={r.depth || undefined} aria-current={r.key === openKey ? "true" : undefined} onClick={() => onPick(r)}>
            <span className="sbar-card-title">
              <StatusMark status={r.status} />
              <span>{r.ticket ? `${r.ticket} ${title(r)}` : title(r)}</span>
              {isNew(r) && <span className="sbar-new-badge">{t("sessionBar.new")}</span>}
            </span>
            <span className="meta-txt dense">{[agentName(r), where(r), r.status === "idle" ? timeAgo(r.at) : statusWord(r.status)].filter(Boolean).join(" · ")}</span>
            {said(r) && <span className={r.status === "wait" ? "sbar-card-wait" : r.status === "done" ? "sbar-card-outcome" : "sbar-card-said"}>{said(r)}</span>}
          </button>
        ))}
        {!shown.length && <p className="meta-txt dense sbar-empty">{t("sessionBar.empty")}</p>}
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
