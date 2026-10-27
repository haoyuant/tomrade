import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import type { LayoutPreset, SessionRow, TerminalRow, ThreadRow, WindowState } from "@tomradex/code-sessions";
import { isMac } from "~/lib/keys";
import { FoldChevron, FoldChevronSpace } from "~/components/ui/atoms";
import { onArchiveFound, send } from "./bridge";
import { Mark, RowActions, rowAgent, rowMono, rowName, rowSaid, rowTitle, saidClass, statusWord, whereOf } from "./cards";
import { keyLabel } from "./keys";
import type { Key } from "./layout";
import { bundles, matchesArchive, paneOf, sessionName, sessionStatus, statusOf, type BarStatus, type HereRow } from "./lists";
import { useSay } from "./say";

/** ⌘-click (Ctrl-click off a Mac) opens a row in a new pane instead of the selected one. */
const besideClick = (e: React.MouseEvent) => (isMac ? e.metaKey : e.ctrlKey);
const MOD = isMac ? "⌘" : "Ctrl";

/** What a dot shows: a ticket's number, else the first letter of the name. */
const shortOf = (r: HereRow, name: string): string => {
  const key = r.kind === "thread" ? r.thread.key : r.session?.key;
  return key ? key.replace(/^.*-/, "") : (Array.from(name.trim())[0] ?? "·").toUpperCase();
};

type Marks = { active: Set<string>; selected: Set<string>; shownPanes: Set<string>; selectedPane: string | null; pane: Key };
type Picks = { onSession: (s: SessionRow, beside: boolean) => void; onTerminal: (t: TerminalRow, beside: boolean) => void; onThread: (t: ThreadRow) => void; onAnswer: (s: SessionRow, which: "allow" | "deny") => void };

const has = (set: Set<string>, r: HereRow) => set.has(r.id) || (!!r.session && set.has(r.session.id));

/** A session that runs elsewhere, as a card: where it is, and what it waits with. */
function AwayCard({ s, active, selected, onPick }: { s: SessionRow; active: Set<string>; selected: Set<string>; onPick: (s: SessionRow, beside: boolean) => void }) {
  const say = useSay();
  const row: HereRow = { kind: "session", id: s.id, session: s };
  const status = sessionStatus(s);
  const said = rowSaid(row, status, say);
  const title = rowTitle(row, say);
  return (
    <button type="button" className="cs-row" data-status={status} title={say("pickHint", { mod: MOD })} aria-current={selected.has(s.id) ? "true" : undefined} data-active={active.has(s.id) || undefined} data-needs={s.needsYou || undefined} onClick={(e) => onPick(s, besideClick(e))}>
      <span className="cs-row-head">
        <span className="cs-row-name mono">
          <Mark status={status} />
          {sessionName(s)}
        </span>
        <span className="cs-where" data-where={s.where} title={s.where === "elsewhere" ? say("elsewhere") : s.where === "tomrade" ? undefined : say("outsideTitle", { terminal: s.terminal ?? say("outsideTerminal") })}>
          {whereOf(row, false, say)}
        </span>
      </span>
      {title && <span className="cs-row-title">{title}</span>}
      <span className="cs-row-meta">{[rowAgent(row), statusWord(status, say)].filter(Boolean).join(" · ")}</span>
      {said && <span className={saidClass(status)}>{said}</span>}
    </button>
  );
}

/** What ran in a pane before what it shows now, oldest first: each opens in a pane as an ended session. */
function PaneTimeline({ past, locale, selected, onPick }: { past: SessionRow[]; locale: string; selected: Set<string>; onPick: (s: SessionRow, beside: boolean) => void }) {
  const say = useSay();
  const day = (at: number) => new Date(at).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const hour = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return (
    <ol className="cs-list cs-timeline fold-row-body" data-testid="cs-timeline" aria-label={say("paneEarlier")}>
      {past.map((s) => (
        <li key={s.id}>
          <button type="button" className="cs-row" data-status="done" data-ended aria-current={selected.has(s.id) ? "true" : undefined} title={say("pickHint", { mod: MOD })} onClick={(e) => onPick(s, besideClick(e))}>
            <span className="cs-row-head">
              <span className={s.key ? "cs-row-name mono" : "cs-row-name"}>{s.key ?? s.conversation ?? sessionName(s)}</span>
              <span className="cs-row-meta">{s.agentName ?? s.agent}</span>
            </span>
            {s.key && s.title && <span className="cs-row-title">{s.title}</span>}
            <span className="cs-row-meta">{`${day(s.startedAt)}–${s.endedAt ? hour(s.endedAt) : ""}`}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * The bar's cards, one each: a session in a pane of its own, a terminal opened here — read as the ticket its agent
 * claimed, else as what the agent calls the conversation, else as its folder — or an assistant conversation, which opens
 * in the app window. The tickets one agent works in one pane come as a bundle; the ones its cell does not show are marked
 * as on that pane, apart from the one it does. A permission its agent declared the keys for is answered under its card.
 */
function HereList({ rows, history, locale, marks, picks }: { rows: HereRow[]; history: WindowState["history"]; locale: string; marks: Marks; picks: Picks }) {
  const say = useSay();
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  if (!rows.length) return <p className="cs-empty">{say("none")}</p>;
  const { active, selected, shownPanes, selectedPane, pane } = marks;
  // A pane that ran sessions before folds open to them; once one does, every row keeps the chevron's room, so they line up.
  const pastOf = (r: HereRow) => {
    const at = paneOf(r);
    return at ? (history[at] ?? []) : [];
  };
  const folds = rows.some((r) => pastOf(r).length > 0);
  const toggle = (at: string) =>
    setUnfolded((now) => {
      const next = new Set(now);
      if (!next.delete(at)) next.add(at);
      return next;
    });
  const chevron = (r: HereRow) => {
    const at = paneOf(r);
    const past = pastOf(r);
    if (!folds) return null;
    if (!at || !past.length) return <FoldChevronSpace />;
    return <FoldChevron open={unfolded.has(at)} label={say("paneEarlierCount", { n: past.length })} testId="cs-pane-history" onToggle={() => toggle(at)} />;
  };
  const timeline = (r: HereRow) => {
    const at = paneOf(r);
    return at && unfolded.has(at) && pastOf(r).length ? <PaneTimeline past={pastOf(r)} locale={locale} selected={selected} onPick={picks.onSession} /> : null;
  };
  const open = (r: HereRow, e: React.MouseEvent) => (r.kind === "terminal" ? picks.onTerminal(r.terminal, besideClick(e)) : r.kind === "session" ? picks.onSession(r.session, besideClick(e)) : picks.onThread(r.thread));
  /** `lead`: the row speaks for its pane (alone on it), so the pane's history folds from it. */
  const item = (r: HereRow, lead = true) => {
    const s = r.session;
    const status = statusOf(r);
    const current = has(selected, r);
    const inCell = current || has(active, r);
    const bound = inCell || r.kind === "thread" ? undefined : pane(r.id) === selectedPane ? "selected" : shownPanes.has(pane(r.id)) ? "shown" : undefined;
    const name = rowName(r, say);
    const title = rowTitle(r, say);
    const said = rowSaid(r, status, say);
    const button = (
      <button
        type="button"
        className={r.kind === "thread" ? "cs-row cs-thread" : "cs-row"}
        data-status={status}
        data-terminal={r.kind === "terminal" ? r.terminal.id : undefined}
        data-thread={r.kind === "thread" ? r.thread.id : undefined}
        title={r.kind === "thread" ? say("openInMain") : say("pickHint", { mod: MOD })}
        aria-current={current ? "true" : undefined}
        data-active={inCell || undefined}
        data-bound={bound}
        data-needs={s?.needsYou || undefined}
        data-ended={status === "done" || undefined}
        onClick={(e) => open(r, e)}
      >
        <span className="cs-row-head">
          <span className={rowMono(r) ? "cs-row-name mono" : "cs-row-name"}>
            <Mark status={status} />
            {name}
          </span>
          {r.kind === "terminal" && !r.terminal.pane ? <span className="tag faint cs-chip">{say("starting")}</span> : <span className="cs-where">{whereOf(r, inCell, say)}</span>}
        </span>
        {title && <span className="cs-row-title">{title}</span>}
        {r.kind === "terminal" && !s ? <span className="cs-row-meta mono">{r.terminal.cwd}</span> : <span className="cs-row-meta">{[rowAgent(r), statusWord(status, say)].filter(Boolean).join(" · ")}</span>}
        {said && <span className={saidClass(status)}>{said}</span>}
      </button>
    );
    // Allow and Deny sit inside the card's lower edge: beside its button, since a button holds no other.
    const card = (
      <div className="cs-card">
        {button}
        <RowActions row={r} onSee={() => undefined} onThread={picks.onThread} onAnswer={picks.onAnswer} />
      </div>
    );
    if (!lead || !folds) return <li key={r.id}>{card}</li>;
    return (
      <li key={r.id}>
        <div className="fold-row cs-fold-row">
          {chevron(r)}
          {card}
        </div>
        {timeline(r)}
      </li>
    );
  };
  return (
    <ul className="cs-list">
      {bundles(rows).map((group) => {
        if (group.length === 1) return item(group[0]!);
        const at = pane(group[0]!.id);
        return (
          <li key={`bundle:${at}`} className="cs-bundle" data-testid="cs-bundle" data-shown={shownPanes.has(at) || undefined} data-selected={at === selectedPane || undefined}>
            {folds ? (
              <span className="fold-row cs-fold-row">
                {chevron(group[0]!)}
                <span className="cs-bundle-head" title={say("samePaneHint")}>
                  {say("samePane", { n: group.length })}
                </span>
              </span>
            ) : (
              <span className="cs-bundle-head" title={say("samePaneHint")}>
                {say("samePane", { n: group.length })}
              </span>
            )}
            {timeline(group[0]!)}
            <ul className="cs-list">{group.map((r) => item(r, false))}</ul>
          </li>
        );
      })}
    </ul>
  );
}

/** Live sessions this window cannot show, under one head that counts them and the ones that need you; closed until opened. */
function OutsideGroup({ sessions, open, onToggle, list }: { sessions: SessionRow[]; open: boolean; onToggle: () => void; list: ReactNode }) {
  const say = useSay();
  if (!sessions.length) return null;
  const needs = sessions.filter((s) => s.needsYou).length;
  return (
    <div className="cs-group" data-testid="cs-outside-group">
      <button type="button" className="side-row cs-group-head" aria-expanded={open} title={say("outsideGroupTitle")} onClick={onToggle}>
        <span className="cs-group-caret" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="cs-group-name">{say("outsideGroup")}</span>
        <span className="tag faint cs-chip" data-testid="cs-outside-count">{sessions.length}</span>
        {needs > 0 && (
          <span className="tag cs-chip" data-state="needs" data-testid="cs-outside-needs">
            {say("needsYouCount", { n: needs })}
          </span>
        )}
      </button>
      {open && list}
    </div>
  );
}

/**
 * The ended sessions on two shelves, newest first: ticket work, and conversations had without a ticket. Picking one
 * shows it in a pane as an ended session.
 */
function ArchiveList({ rows, locale, active, selected, onPick }: { rows: SessionRow[] | null; locale: string; active: Set<string>; selected: Set<string>; onPick: (s: SessionRow) => void }) {
  const say = useSay();
  const [shelf, setShelf] = useState<"tickets" | "talks">("tickets");
  const [query, setQuery] = useState("");
  // What was said is searched in the agents' records, a moment after the typing stops; the rest is matched here.
  const [said, setSaid] = useState<{ query: string; ids: Set<string> }>({ query: "", ids: new Set() });
  useEffect(() => onArchiveFound((post) => setSaid({ query: post.query, ids: new Set(post.ids) })), []);
  useEffect(() => {
    if (!query.trim()) return;
    const timer = setTimeout(() => send({ type: "archiveSearch", query }), 300);
    return () => clearTimeout(timer);
  }, [query]);
  if (!rows) return <p className="cs-empty">{say("archiveLoading")}</p>;
  const saidIt = (s: SessionRow) => said.query === query && said.ids.has(s.id);
  const found = query.trim() ? rows.filter((s) => matchesArchive(s, query) || saidIt(s)) : rows;
  const tickets = found.filter((s) => s.itemId);
  const talks = found.filter((s) => !s.itemId);
  const shown = shelf === "tickets" ? tickets : talks;
  const when = (at: number) => new Date(at).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <>
      <input type="search" className="input cs-archive-search" data-testid="cs-archive-search" aria-label={say("archiveSearch")} placeholder={say("archiveSearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="seg cs-shelves" role="group" data-testid="cs-archive-shelves">
        <button type="button" aria-pressed={shelf === "tickets"} data-testid="cs-shelf-tickets" onClick={() => setShelf("tickets")}>
          {say("shelfTickets", { n: tickets.length })}
        </button>
        <button type="button" aria-pressed={shelf === "talks"} data-testid="cs-shelf-talks" onClick={() => setShelf("talks")}>
          {say("shelfTalks", { n: talks.length })}
        </button>
      </div>
      {!shown.length ? (
        <p className="cs-empty">{query.trim() ? say("archiveNoMatch") : say(shelf === "tickets" ? "archiveEmpty" : "talksEmpty")}</p>
      ) : (
        <ul className="cs-list" data-testid="cs-archive-list">
          {shown.map((s) => (
            <li key={s.id}>
              <button type="button" className="cs-row" data-status="done" aria-current={selected.has(s.id) ? "true" : undefined} data-active={active.has(s.id) || undefined} onClick={() => onPick(s)}>
                <span className="cs-row-head">
                  <span className={s.itemId ? "cs-row-name mono" : "cs-row-name"}>
                    <Mark status="done" />
                    {s.itemId ? sessionName(s) : (s.conversation ?? sessionName(s))}
                  </span>
                  <span className="cs-row-meta">{say("endedAt", { when: when(s.endedAt!) })}</span>
                </span>
                {s.itemId && s.title && <span className="cs-row-title">{s.title}</span>}
                <span className="cs-row-meta mono">{s.itemId ? s.branch : [s.agentName ?? s.agent, s.cwd ?? s.worktree].filter(Boolean).join(" · ")}</span>
                {query.trim() && !matchesArchive(s, query) && saidIt(s) && (
                  <span className="cs-row-meta" data-testid="cs-archive-said">
                    {say("archiveSaid")}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Saved layouts: apply one, keep the current one under a name, pick the one new windows open with; and the auto-place switch. */
function Layouts({ presets, defaultPreset, autoPlace, onApply, onSave }: { presets: LayoutPreset[]; defaultPreset: string | null; autoPlace: boolean; onApply: (p: LayoutPreset) => void; onSave: (name: string) => void }) {
  const say = useSay();
  const [naming, setNaming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="cs-layouts">
      <div className="cs-side-head cs-side-sub">
        <h2 className="eyebrow">{say("layouts")}</h2>
        {naming === null && (
          <button type="button" className="link-btn side-add" data-testid="cs-save-layout" onClick={() => setNaming("")}>
            {say("saveLayout")}
          </button>
        )}
      </div>
      {naming !== null && (
        <form
          className="cs-layout-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(naming);
            setNaming(null);
          }}
        >
          <input autoFocus value={naming} placeholder={say("layoutName")} aria-label={say("layoutName")} onChange={(e) => setNaming(e.target.value)} />
          <button type="submit" className="btn btn-primary btn-xs">{say("save")}</button>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => setNaming(null)}>{say("cancel")}</button>
        </form>
      )}
      <ul className="cs-list">
        {presets.map((p) => (
          <li key={p.id} className="cs-preset" data-preset={p.id}>
            {renaming?.id === p.id ? (
              <form
                className="cs-layout-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  send({ type: "renamePreset", id: p.id, name: renaming.name });
                  setRenaming(null);
                }}
              >
                <input autoFocus value={renaming.name} aria-label={say("layoutName")} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} />
                <button type="submit" className="btn btn-primary btn-xs">{say("save")}</button>
              </form>
            ) : (
              <>
                <button type="button" className="link-btn cs-preset-name" title={say("applyLayout")} onClick={() => onApply(p)}>
                  {p.name}
                </button>
                <button type="button" className="icon-btn" data-default={p.id === defaultPreset || undefined} title={p.id === defaultPreset ? say("unsetDefault") : say("setDefault")} aria-label={p.id === defaultPreset ? say("unsetDefault") : say("setDefault")} onClick={() => send({ type: "defaultPreset", id: p.id === defaultPreset ? null : p.id })}>
                  {p.id === defaultPreset ? "★" : "☆"}
                </button>
                <button type="button" className="icon-btn" title={say("rename")} aria-label={say("rename")} onClick={() => setRenaming({ id: p.id, name: p.name })}>✎</button>
                <button type="button" className="icon-btn" title={say("deleteLayout")} aria-label={say("deleteLayout")} onClick={() => send({ type: "deletePreset", id: p.id })}>×</button>
              </>
            )}
          </li>
        ))}
      </ul>
      <label className="cs-auto-place">
        <input type="checkbox" data-testid="cs-auto-place" checked={autoPlace} onChange={(e) => send({ type: "autoPlace", on: e.target.checked })} /> {say("autoPlace")}
      </label>
    </div>
  );
}

/** The folded bar: a column of dots, one per row, with a peek beside the one under the pointer; the way back on top. */
function Rail({ ref, rows, waiting, marks, picks, foldLabel, onFold }: { ref: Ref<HTMLElement>; rows: HereRow[]; waiting: number; marks: Marks; picks: Picks; foldLabel: string; onFold: () => void }) {
  const say = useSay();
  const [peek, setPeek] = useState<{ id: string; top: number } | null>(null);
  const peekId = useId();
  const nav = useRef<HTMLElement | null>(null);
  // Measured against the bar, so the peek sits beside its dot however far the dots have scrolled.
  const peekAt = (id: string, el: HTMLElement) => setPeek({ id, top: el.getBoundingClientRect().top - (nav.current?.getBoundingClientRect().top ?? 0) });
  const shown = peek ? rows.find((r) => r.id === peek.id) : undefined;
  const dot = (r: HereRow) => {
    const status = statusOf(r);
    const name = rowName(r, say);
    const current = has(marks.selected, r);
    return (
      <button
        key={r.id}
        type="button"
        className="cs-dot"
        data-status={status}
        data-thread={r.kind === "thread" ? r.thread.id : undefined}
        aria-current={current ? "true" : undefined}
        data-active={has(marks.active, r) || undefined}
        aria-label={`${name}, ${statusWord(status, say)}`}
        aria-describedby={peek?.id === r.id ? peekId : undefined}
        onClick={(e) => {
          setPeek(null);
          if (r.kind === "terminal") picks.onTerminal(r.terminal, besideClick(e));
          else if (r.kind === "session") picks.onSession(r.session, besideClick(e));
          else picks.onThread(r.thread);
        }}
        onMouseEnter={(e) => peekAt(r.id, e.currentTarget)}
        onMouseLeave={() => setPeek(null)}
        onFocus={(e) => peekAt(r.id, e.currentTarget)}
        onBlur={() => setPeek(null)}
      >
        <span className="cs-dot-face">
          {shortOf(r, name)}
          <Mark status={status} size={9} />
        </span>
        <span className="cs-dot-where">{status === "done" ? statusWord("done", say) : whereOf(r, has(marks.active, r), say)}</span>
      </button>
    );
  };
  const live = rows.filter((r) => statusOf(r) !== "done");
  const ended = rows.filter((r) => statusOf(r) === "done");
  return (
    <aside
      ref={(el) => {
        nav.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      className="cs-side"
      data-folded
      data-mode="rail"
      aria-label={say("bar")}
    >
      <button type="button" className="icon-btn cs-fold" data-testid="cs-fold" title={foldLabel} aria-label={foldLabel} aria-expanded="false" onClick={onFold}>
        «
      </button>
      {waiting > 0 && (
        <span className="cs-waiting" role="status" data-testid="cs-waiting" title={say("needsYouCount", { n: waiting })} aria-label={say("needsYouCount", { n: waiting })}>
          <Mark status="wait" size={8} />
          {waiting}
        </span>
      )}
      <div className="cs-dots" onScroll={() => setPeek(null)}>
        {live.map(dot)}
        {ended.length > 0 && <span className="cs-rule" />}
        {ended.map(dot)}
      </div>
      {shown && (
        <div id={peekId} role="tooltip" className="cs-peek" data-testid="cs-peek" data-status={statusOf(shown)} style={{ top: peek!.top }}>
          <span className="cs-peek-title">{[rowName(shown, say), rowTitle(shown, say)].filter(Boolean).join(" ")}</span>
          <span className="cs-row-meta">{[rowAgent(shown), whereOf(shown, has(marks.active, shown), say), statusWord(statusOf(shown), say)].filter(Boolean).join(" · ")}</span>
          {rowSaid(shown, statusOf(shown), say) && <span className={saidClass(statusOf(shown))}>{rowSaid(shown, statusOf(shown), say)}</span>}
          <span className="cs-row-meta">{say("peekHint")}</span>
        </div>
      )}
    </aside>
  );
}

type SidebarProps = {
  ref: Ref<HTMLElement>;
  state: WindowState;
  rows: { here: HereRow[]; away: SessionRow[] };
  locale: string;
  folded: boolean;
  onFold: () => void;
  marks: Marks;
  canOpen: boolean;
  onPick: (s: SessionRow, beside?: boolean) => void;
  onTerminal: (t: TerminalRow, beside?: boolean) => void;
  onThread: (t: ThreadRow) => void;
  onAnswer: (s: SessionRow, which: "allow" | "deny") => void;
  onNewTerminal: () => void;
  onApplyPreset: (p: LayoutPreset) => void;
  onSavePreset: (name: string) => void;
};

/**
 * The session bar on the window's right edge, the assistant panel's: cards that say where each session stands and
 * what it waits with, the sessions this window cannot show, saved layouts and the archive; or, folded, a column of dots.
 */
export function Sidebar({ ref, state, rows, locale, folded, onFold, marks, canOpen, onPick, onTerminal, onThread, onAnswer, onNewTerminal, onApplyPreset, onSavePreset }: SidebarProps) {
  const say = useSay();
  const [outsideOpen, setOutsideOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const openArchive = (open: boolean) => {
    setArchiveOpen(open);
    send({ type: "archive", open });
  };
  const picks: Picks = { onSession: onPick, onTerminal, onThread, onAnswer };
  const waiting = rows.here.filter((r) => statusOf(r) === "wait").length + rows.away.filter((s) => sessionStatus(s) === "wait").length;
  const foldLabel = `${say(folded ? "unfold" : "fold")} (${keyLabel("fold")})`;
  if (folded) return <Rail ref={ref} rows={rows.here} waiting={waiting} marks={marks} picks={picks} foldLabel={foldLabel} onFold={onFold} />;
  const awayList = (
    <ul className="cs-list">
      {rows.away.map((s) => (
        <li key={s.id}>
          <AwayCard s={s} active={marks.active} selected={marks.selected} onPick={onPick} />
        </li>
      ))}
    </ul>
  );
  return (
    <aside ref={ref} className="cs-side" data-mode="cards" aria-label={say("bar")}>
      <div className="cs-bar-head">
        <button type="button" className="icon-btn cs-fold" data-testid="cs-fold" title={foldLabel} aria-label={foldLabel} aria-expanded="true" onClick={onFold}>
          »
        </button>
        <span className="cs-bar-title">{say("bar")}</span>
        {waiting > 0 && (
          <span className="cs-waiting" role="status" data-testid="cs-waiting" title={say("needsYouCount", { n: waiting })} aria-label={say("needsYouCount", { n: waiting })}>
            <Mark status="wait" size={8} />
            {waiting}
          </span>
        )}
        {!archiveOpen && (
          <button type="button" className="link-btn side-add" data-testid="cs-side-new-terminal" disabled={!canOpen} onClick={onNewTerminal}>
            + {say("newTerminal")}
          </button>
        )}
      </div>
      {archiveOpen ? (
        <>
          <div className="cs-side-head cs-side-sub">
            <h2 className="eyebrow">{say("archiveHead")}</h2>
            <button type="button" className="link-btn side-add" data-testid="cs-archive-back" onClick={() => openArchive(false)}>
              ← {say("archiveBack")}
            </button>
          </div>
          <ArchiveList rows={state.archive.rows} locale={locale} active={marks.active} selected={marks.selected} onPick={onPick} />
        </>
      ) : (
        <>
          {(rows.here.length > 0 || !rows.away.length) && <HereList rows={rows.here} history={state.history} locale={locale} marks={marks} picks={picks} />}
          <OutsideGroup sessions={rows.away} open={outsideOpen} onToggle={() => setOutsideOpen((o) => !o)} list={awayList} />
          <Layouts presets={state.presets} defaultPreset={state.defaultPreset} autoPlace={state.autoPlace} onApply={onApplyPreset} onSave={onSavePreset} />
          <button type="button" className="link-btn cs-archive-open" data-testid="cs-archive" onClick={() => openArchive(true)}>
            {say("archive", { n: state.archive.count })}
          </button>
        </>
      )}
    </aside>
  );
}

export type { BarStatus };
