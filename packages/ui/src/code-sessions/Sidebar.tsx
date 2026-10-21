import { useState, type ReactNode, type Ref } from "react";
import type { LayoutPreset, SessionRow, TerminalRow, WindowState } from "@tomradex/code-sessions";
import { isMac } from "~/lib/keys";
import { send } from "./bridge";
import { keyLabel } from "./keys";
import type { Key } from "./layout";
import { bundles, live, sessionName, sidebarRows, type HereRow } from "./lists";
import { StateChip } from "./Cell";
import { useSay } from "./say";

/** ⌘-click (Ctrl-click off a Mac) opens a row in a new pane instead of the selected one. */
const besideClick = (e: React.MouseEvent) => (isMac ? e.metaKey : e.ctrlKey);
const MOD = isMac ? "⌘" : "Ctrl";

/** A session in the list: its ticket (else what its agent calls the conversation), where it stands, and where it runs. */
function SessionBody({ s }: { s: SessionRow }) {
  const say = useSay();
  const name = sessionName(s);
  const title = s.title ?? s.agentTitle ?? (s.itemId ? null : say("noTicket"));
  return (
    <>
      <span className="cs-row-head">
        <span className="mono">{name}</span>
        <StateChip s={s} />
      </span>
      {title && <span className="cs-row-title">{title}</span>}
      <span className="cs-row-meta">
        {s.branch && s.branch !== name && <span className="mono">{s.branch}</span>}
        {s.mode === "run" ? `${s.branch && s.branch !== name ? " · " : ""}${say("runMode")}` : ""}
        {!s.pane && live(s) && s.where !== "tomrade" && (
          <span className="tag faint cs-chip cs-where" data-where={s.where} title={s.where === "elsewhere" ? say("elsewhere") : say("outsideTitle", { terminal: s.terminal ?? say("outsideTerminal") })}>
            {s.where === "elsewhere" ? say("elsewhereTag") : (s.terminal ?? say("outsideTerminal"))}
          </span>
        )}
      </span>
      {s.activity && <span className="cs-row-activity">{s.activity}</span>}
    </>
  );
}

function SessionList({ sessions, active, selected, onPick }: { sessions: SessionRow[]; active: Set<string>; selected: Set<string>; onPick: (s: SessionRow, beside: boolean) => void }) {
  const say = useSay();
  return (
    <ul className="cs-list">
      {sessions.map((s) => (
        <li key={s.id}>
          <button type="button" className="side-row cs-row" title={say("pickHint", { mod: MOD })} aria-current={selected.has(s.id) ? "true" : undefined} data-active={active.has(s.id) || undefined} data-needs={s.needsYou || undefined} data-ended={!live(s) || undefined} onClick={(e) => onPick(s, besideClick(e))}>
            <SessionBody s={s} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * What this window shows, one row each: a session in a pane of its own, or a terminal opened here — read as the ticket
 * its agent claimed, else as what the agent calls the conversation, else as its folder. The tickets one agent works in
 * one pane come as a bundle; the ones its cell does not show are marked as on that pane, apart from the one it does.
 */
function HereList({ rows, active, selected, shownPanes, selectedPane, pane, onSession, onTerminal }: { rows: HereRow[]; active: Set<string>; selected: Set<string>; shownPanes: Set<string>; selectedPane: string | null; pane: Key; onSession: (s: SessionRow, beside: boolean) => void; onTerminal: (t: TerminalRow, beside: boolean) => void }) {
  const say = useSay();
  if (!rows.length) return <p className="cs-empty">{say("none")}</p>;
  const has = (set: Set<string>, r: HereRow) => set.has(r.id) || (!!r.session && set.has(r.session.id));
  const item = (r: HereRow) => {
    const s = r.session;
    const current = has(selected, r);
    const bound = current || has(active, r) ? undefined : pane(r.id) === selectedPane ? "selected" : shownPanes.has(pane(r.id)) ? "shown" : undefined;
    return (
      <li key={r.id}>
        <button
          type="button"
          className="side-row cs-row"
          data-terminal={r.kind === "terminal" ? r.terminal.id : undefined}
          title={say("pickHint", { mod: MOD })}
          aria-current={current ? "true" : undefined}
          data-active={has(active, r) || undefined}
          data-bound={bound}
          data-needs={s?.needsYou || undefined}
          onClick={(e) => (r.kind === "terminal" ? onTerminal(r.terminal, besideClick(e)) : onSession(r.session, besideClick(e)))}
        >
          {s ? (
            <SessionBody s={s} />
          ) : r.kind === "terminal" ? (
            <>
              <span className="cs-row-head">
                <span className="mono">{r.terminal.running ?? r.terminal.title}</span>
                {!r.terminal.pane && <span className="tag faint cs-chip">{say("starting")}</span>}
              </span>
              {r.terminal.agentTitle && <span className="cs-row-title">{r.terminal.agentTitle}</span>}
              <span className="cs-row-meta mono">{r.terminal.cwd}</span>
            </>
          ) : null}
        </button>
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
            <span className="cs-bundle-head" title={say("samePaneHint")}>
              {say("samePane", { n: group.length })}
            </span>
            <ul className="cs-list">{group.map(item)}</ul>
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
  if (!rows) return <p className="cs-empty">{say("archiveLoading")}</p>;
  const tickets = rows.filter((s) => s.itemId);
  const talks = rows.filter((s) => !s.itemId);
  const shown = shelf === "tickets" ? tickets : talks;
  const when = (at: number) => new Date(at).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <>
      <div className="seg cs-shelves" role="group" data-testid="cs-archive-shelves">
        <button type="button" aria-pressed={shelf === "tickets"} data-testid="cs-shelf-tickets" onClick={() => setShelf("tickets")}>
          {say("shelfTickets", { n: tickets.length })}
        </button>
        <button type="button" aria-pressed={shelf === "talks"} data-testid="cs-shelf-talks" onClick={() => setShelf("talks")}>
          {say("shelfTalks", { n: talks.length })}
        </button>
      </div>
      {!shown.length ? (
        <p className="cs-empty">{say(shelf === "tickets" ? "archiveEmpty" : "talksEmpty")}</p>
      ) : (
        <ul className="cs-list" data-testid="cs-archive-list">
          {shown.map((s) => (
            <li key={s.id}>
              <button type="button" className="side-row cs-row" aria-current={selected.has(s.id) ? "true" : undefined} data-active={active.has(s.id) || undefined} onClick={() => onPick(s)}>
                <span className="cs-row-head">
                  <span className={s.itemId ? "mono" : undefined}>{s.itemId ? sessionName(s) : (s.conversation ?? sessionName(s))}</span>
                  <span className="cs-row-meta">{say("endedAt", { when: when(s.endedAt!) })}</span>
                </span>
                {s.itemId && s.title && <span className="cs-row-title">{s.title}</span>}
                <span className="cs-row-meta mono">{s.itemId ? s.branch : [s.agentName ?? s.agent, s.cwd ?? s.worktree].filter(Boolean).join(" · ")}</span>
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

type SidebarProps = {
  ref: Ref<HTMLElement>;
  state: WindowState;
  locale: string;
  folded: boolean;
  onFold: () => void;
  active: Set<string>;
  selected: Set<string>;
  shownPanes: Set<string>;
  selectedPane: string | null;
  pane: Key;
  canOpen: boolean;
  onPick: (s: SessionRow, beside?: boolean) => void;
  onTerminal: (t: TerminalRow, beside?: boolean) => void;
  onNewTerminal: () => void;
  onApplyPreset: (p: LayoutPreset) => void;
  onSavePreset: (name: string) => void;
};

/** The window's list: what it shows, the sessions it cannot, saved layouts and the archive; or, folded, a strip. */
export function Sidebar({ ref, state, locale, folded, onFold, active, selected, shownPanes, selectedPane, pane, canOpen, onPick, onTerminal, onNewTerminal, onApplyPreset, onSavePreset }: SidebarProps) {
  const say = useSay();
  const [outsideOpen, setOutsideOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const openArchive = (open: boolean) => {
    setArchiveOpen(open);
    send({ type: "archive", open });
  };
  const groups = sidebarRows(state.sessions, state.terminals);
  const needsYou = state.sessions.filter((s) => s.needsYou).length;
  const foldLabel = `${say(folded ? "unfold" : "fold")} (${keyLabel("fold")})`;

  return (
    <aside ref={ref} className="cs-side" data-folded={folded || undefined}>
      {folded ? (
        <div className="cs-strip">
          <button type="button" className="icon-btn cs-fold" data-testid="cs-fold" title={foldLabel} aria-label={foldLabel} onClick={onFold}>
            »
          </button>
          {needsYou > 0 && (
            <span className="tag cs-chip" data-state="needs" title={say("needsYouCount", { n: needsYou })}>
              {needsYou}
            </span>
          )}
          <span className="cs-strip-name" data-testid="cs-project" title={say("projectTitle", { project: state.projectName })}>
            {state.projectName}
          </span>
        </div>
      ) : (
        <>
          <div className="cs-project-head">
            <span className="cs-project" data-testid="cs-project" title={say("projectTitle", { project: state.projectName })}>
              {state.projectName}
            </span>
            <button type="button" className="icon-btn cs-fold" data-testid="cs-fold" title={foldLabel} aria-label={foldLabel} onClick={onFold}>
              «
            </button>
          </div>
          {archiveOpen ? (
            <>
              <div className="cs-side-head cs-side-sub">
                <h2 className="eyebrow">{say("archiveHead")}</h2>
                <button type="button" className="link-btn side-add" data-testid="cs-archive-back" onClick={() => openArchive(false)}>
                  ← {say("archiveBack")}
                </button>
              </div>
              <ArchiveList rows={state.archive.rows} locale={locale} active={active} selected={selected} onPick={onPick} />
            </>
          ) : (
            <>
              <div className="cs-side-head">
                <h2 className="eyebrow">{say("here")}</h2>
                <button type="button" className="link-btn side-add" data-testid="cs-side-new-terminal" disabled={!canOpen} onClick={onNewTerminal}>
                  + {say("newTerminal")}
                </button>
              </div>
              {(groups.here.length > 0 || !groups.away.length) && <HereList rows={groups.here} active={active} selected={selected} shownPanes={shownPanes} selectedPane={selectedPane} pane={pane} onSession={onPick} onTerminal={onTerminal} />}
              <OutsideGroup sessions={groups.away} open={outsideOpen} onToggle={() => setOutsideOpen((o) => !o)} list={<SessionList sessions={groups.away} active={active} selected={selected} onPick={onPick} />} />
              <Layouts
                presets={state.presets}
                defaultPreset={state.defaultPreset}
                autoPlace={state.autoPlace}
                onApply={onApplyPreset}
                onSave={onSavePreset}
               
              />
              <button type="button" className="link-btn cs-archive-open" data-testid="cs-archive" onClick={() => openArchive(true)}>
                {say("archive", { n: state.archive.count })}
              </button>
            </>
          )}
        </>
      )}
    </aside>
  );
}
