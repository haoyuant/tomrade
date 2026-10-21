import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { Layout, LayoutPreset, SessionRow, TerminalPlace, TerminalRow, WindowState } from "@tomradex/code-sessions";
import { ContextMenu, ContextMenuActionItem, ContextMenuSub } from "~/components/ui/menu";
import { interpolate, message } from "~/lib/dicts";
import { isMac } from "~/lib/keys";
import { onCell, onLook, onShownIn, onState, onToast, send, type Look } from "./bridge";
import { keyLabel, windowKey, type WindowKey } from "./keys";
import { applyPreset, carryOn, close, cycle, dedupe, heir, holder, landing, leaves, lock, neighbour, place, prune, resize, reveal, show, split, type Key } from "./layout";
import { bundles, sessionName, sidebarRows, type HereRow } from "./lists";
import { TerminalCell } from "./TerminalCell";

type Say = (key: string, vars?: Record<string, string | number>) => string;

const ASKED_GRACE_MS = 5000;

/** What can go into a cell by itself: a session with a terminal here that no terminal of the window already shows, and plain terminals. */
const placeableIds = (state: WindowState): string[] => {
  const folded = new Set(state.terminals.flatMap((t) => (t.sessionId ? [t.sessionId] : [])));
  return [...state.sessions.filter((s) => s.pane && live(s) && !folded.has(s.id)).map((s) => s.id), ...state.terminals.filter((t) => t.pane && !t.sessionId).map((t) => t.id)];
};

const live = (s: SessionRow) => s.state !== "ended" && s.state !== "lost";

/** A cell's id as the herdr pane it shows: a session and the terminal it runs in are one pane, never two cells. */
const paneKey = (state: WindowState): Key => {
  const panes = new Map<string, string>();
  for (const s of [...(state.archive.rows ?? []), ...state.sessions]) if (s.pane) panes.set(s.id, s.pane);
  for (const t of state.terminals) if (t.pane) panes.set(t.id, t.pane);
  return (id) => (panes.has(id) ? `pane:${panes.get(id)}` : id);
};

type Leaf = Extract<Layout, { type: "leaf" }>;

/**
 * A pick or reveal that found its pane in a cell under another ticket of the same agent: the cell now reads as the one
 * picked. A terminal and the session its agent claimed are one row, and the cell keeps the id it has.
 */
const asPicked = (state: WindowState, layout: Layout, cell: string, id: string, key: Key): Layout => {
  const held = leaves(layout).find((l) => l.id === cell)?.sessionId;
  const claimedBy = (terminal: string) => state.terminals.find((t) => t.id === terminal)?.sessionId;
  if (!held || held === id || claimedBy(held) === id || claimedBy(id) === held) return layout;
  return show(layout, cell, id, key);
};

/** ⌘-click (Ctrl-click off a Mac) opens a row in a new pane instead of the selected one. */
const besideClick = (e: React.MouseEvent) => (isMac ? e.metaKey : e.ctrlKey);
const MOD = isMac ? "⌘" : "Ctrl";

type Toast = { text: string; action?: { label: string; run: () => void } };

/** The app's lock glyph; open, the shackle lifts off one side. */
const LockGlyph = ({ locked }: { locked: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
    <g fill="none" stroke="currentColor" strokeWidth="1.15">
      <rect x="3.3" y="6.2" width="7.4" height="5.4" rx="1.2" />
      <path d={locked ? "M5.1 6.2V4.7a1.9 1.9 0 0 1 3.8 0v1.5" : "M5.1 6.2V4.7a1.9 1.9 0 0 1 3.7-.6"} />
    </g>
  </svg>
);

/** The selected cell, where a pick from the list goes: the one clicked last, else the first empty one, else the first. */
const selectedCell = (cells: Leaf[], focused: string | null): Leaf => cells.find((c) => c.id === focused) ?? cells.find((c) => !c.sessionId) ?? cells[0]!;

function Banner({ state, say }: { state: WindowState; say: Say }) {
  const b = state.bridge;
  let body: ReactNode = null;
  if (b.state === "notInstalled")
    body = (
      <>
        <span>{say("notInstalled")}</span>
        {state.install?.command ? (
          <>
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => send({ type: "install" })}>
              {say("install")}
            </button>
            <code>{state.install.command}</code>
          </>
        ) : (
          state.install && (
            <button type="button" className="link-btn" onClick={() => send({ type: "openGuide" })}>
              {say("installGuide")} →
            </button>
          )
        )}
      </>
    );
  else if (state.revive === "starting") body = <span>{say("herdrStarting")}</span>;
  else if (b.state === "notRunning" && state.revive === "failed")
    body = (
      <>
        <span>{say("herdrStartFailed")}</span>
        <button type="button" className="btn btn-secondary btn-xs" onClick={() => send({ type: "startHerdr" })}>
          {say("herdrRetry")}
        </button>
      </>
    );
  else if (b.state === "notRunning") body = <span>{say("notRunning")}</span>;
  else if (b.state === "tooOld") body = <span>{say("tooOld", { version: b.version, need: b.need, fix: b.fix })}</span>;
  else if (b.state === "stale") body = <span>{say("stale", { version: b.version, server: b.server, fix: b.fix })}</span>;
  else if (b.state === "unsupported") body = <span>{say("unsupported")}</span>;
  return (
    <>
      {body && <div className="cs-banner" data-testid="cs-bridge">{body}</div>}
      {state.warning && <div className="cs-banner" data-testid="cs-warning">{state.warning}</div>}
      {state.askSwitch && (
        <div className="cs-banner" data-testid="cs-ask-switch">
          <span>{say("askSwitch", { terminal: state.terminal })}</span>
          <button type="button" className="btn btn-primary btn-xs" onClick={() => send({ type: "switchTerminal", switch: true })}>
            {say("switchYes")}
          </button>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => send({ type: "switchTerminal", switch: false })}>
            {say("switchNo")}
          </button>
        </div>
      )}
    </>
  );
}

/** Where a session stands; "needs you" wins over its state. */
function StateChip({ s, say }: { s: SessionRow; say: Say }) {
  return (
    <span className="tag cs-chip" data-testid="cs-state" data-state={s.needsYou ? "needs" : s.state}>
      {s.needsYou ? say("needsYou") : say(s.state)}
    </span>
  );
}

/** How herdr reads the agent in a plain terminal, in the session chip's words; blocked is "needs you". */
function AgentChip({ status, say }: { status: NonNullable<TerminalRow["agentStatus"]>; say: Say }) {
  const state = status === "working" ? "running" : status === "blocked" ? "needs" : status;
  return (
    <span className="tag cs-chip" data-testid="cs-state" data-state={state}>
      {say(state === "needs" ? "needsYou" : state)}
    </span>
  );
}

/** A session in the list: its ticket (else what its agent calls the conversation), where it stands, and where it runs. */
function SessionBody({ s, say }: { s: SessionRow; say: Say }) {
  const name = sessionName(s);
  const title = s.title ?? s.agentTitle ?? (s.itemId ? null : say("noTicket"));
  return (
    <>
      <span className="cs-row-head">
        <span className="mono">{name}</span>
        <StateChip s={s} say={say} />
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

function SessionList({ sessions, active, selected, onPick, say }: { sessions: SessionRow[]; active: Set<string>; selected: Set<string>; onPick: (s: SessionRow, beside: boolean) => void; say: Say }) {
  return (
    <ul className="cs-list">
      {sessions.map((s) => (
        <li key={s.id}>
          <button type="button" className="side-row cs-row" title={say("pickHint", { mod: MOD })} aria-current={selected.has(s.id) ? "true" : undefined} data-active={active.has(s.id) || undefined} data-needs={s.needsYou || undefined} data-ended={!live(s) || undefined} onClick={(e) => onPick(s, besideClick(e))}>
            <SessionBody s={s} say={say} />
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
function HereList({ rows, active, selected, shownPanes, selectedPane, pane, onSession, onTerminal, say }: { rows: HereRow[]; active: Set<string>; selected: Set<string>; shownPanes: Set<string>; selectedPane: string | null; pane: Key; onSession: (s: SessionRow, beside: boolean) => void; onTerminal: (t: TerminalRow, beside: boolean) => void; say: Say }) {
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
            <SessionBody s={s} say={say} />
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
function OutsideGroup({ sessions, open, onToggle, list, say }: { sessions: SessionRow[]; open: boolean; onToggle: () => void; list: ReactNode; say: Say }) {
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
function ArchiveList({ rows, locale, active, selected, onPick, say }: { rows: SessionRow[] | null; locale: string; active: Set<string>; selected: Set<string>; onPick: (s: SessionRow) => void; say: Say }) {
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

/** A cell's way to a new terminal, the same wherever it shows: the folder it starts in, then the button below. */
function NewTerminal({ places, initial, ready, onOpen, say }: { places: TerminalPlace[]; initial?: string | null; ready: boolean; onOpen: (cwd: string) => void; say: Say }) {
  const [cwd, setCwd] = useState(initial ?? places[0]?.cwd ?? "");
  const where = places.some((p) => p.cwd === cwd) ? cwd : (places[0]?.cwd ?? "");
  return (
    <div className="cs-new-terminal">
      <label className="cs-new-terminal-where">
        <span>{say("startIn")}</span>
        <select className="select" data-testid="cs-new-terminal-where" value={where} disabled={!places.length} onChange={(e) => setCwd(e.target.value)}>
          {places.map((p) => (
            <option key={p.cwd} value={p.cwd} title={p.cwd}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-new-terminal" disabled={!ready || !where} onClick={() => onOpen(where)}>
        {say("newTerminal")}
      </button>
    </div>
  );
}

/** Saved layouts: apply one, keep the current one under a name, pick the one new windows open with; and the auto-place switch. */
function Layouts({ presets, defaultPreset, autoPlace, onApply, onSave, say }: { presets: LayoutPreset[]; defaultPreset: string | null; autoPlace: boolean; onApply: (p: LayoutPreset) => void; onSave: (name: string) => void; say: Say }) {
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

/** A session whose terminal this window cannot show: where it runs, and what can be done from here. */
type Line = { who: "person" | "agent" | "tool"; text: string };

/**
 * An ended session's cell: which agent worked it and when it ended, the way to go on, and its conversation read-only
 * from the agent's own record — or, without one, just the way to go on.
 */
function Ended({ session, cell, locale, resume, picker, say }: { session: SessionRow; cell: string; locale: string; resume: ReactNode; picker: ReactNode; say: Say }) {
  const [read, setRead] = useState<{ lines: Line[] | null; cut: boolean } | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    setRead(null);
    const off = onCell(cell, (post) => {
      if (post.type === "conversation" && post.sessionId === session.id) setRead({ lines: post.lines, cut: post.cut });
    });
    send({ type: "conversation", cell, sessionId: session.id });
    return off;
  }, [cell, session.id]);
  const lines = read?.lines?.length ? read.lines : null;
  const when = session.endedAt ? new Date(session.endedAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  const who = session.agentName ?? session.agent;
  if (!lines)
    return (
      <div className="cs-not-here" data-testid="cs-ended">
        <span>{say("endedHere")}</span>
        <span className="cs-row-meta">{when ? say("endedBy", { agent: who, when }) : who}</span>
        {resume}
        {picker}
      </div>
    );
  return (
    <div className="cs-ended" data-testid="cs-ended">
      <div className="cs-ended-head">
        <span className="cs-row-meta" data-testid="cs-ended-by">{when ? say("endedBy", { agent: who, when }) : who}</span>
        {resume}
        {picking ? (
          picker
        ) : (
          <button type="button" className="link-btn" data-testid="cs-ended-new" onClick={() => setPicking(true)}>
            {say("orNewTerminal")}
          </button>
        )}
      </div>
      <div className="cs-convo" data-testid="cs-convo" aria-label={say("convoReadOnly")}>
        {read?.cut && <p className="cs-convo-cut">{say("convoCut")}</p>}
        {lines.map((l, i) => (
          <div key={i} className="cs-convo-line" data-who={l.who}>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function NotHere({ session, cell, locale, picker, onTalk, say }: { session: SessionRow; cell: string; locale: string; picker: ReactNode; onTalk: () => void; say: Say }) {
  const done = session.state === "idle" || session.state === "ended" || session.state === "lost" || session.state === "error";
  // Never while the outside one may still run: two copies would share one conversation. A ticket goes on through code
  // link; a conversation without one, through its agent's own resume.
  const resume =
    done &&
    session.where !== "elsewhere" &&
    (session.itemId ? (
      <button type="button" className="btn btn-secondary btn-xs" onClick={() => send({ type: "continue", sessionId: session.id })}>
        {say("continueNew")}
      </button>
    ) : session.resumable ? (
      <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-talk-on" onClick={onTalk}>
        {say("talkOn")}
      </button>
    ) : null);
  if (!live(session)) return <Ended session={session} cell={cell} locale={locale} resume={resume} picker={picker} say={say} />;
  if (session.where === "herdr")
    return (
      <div className="cs-not-here" data-testid="cs-ended">
        <span>{say("endedHere")}</span>
        {resume}
        {picker}
      </div>
    );
  if (session.where === "elsewhere") return <div className="cs-not-here">{say("elsewhere")}</div>;
  const terminal = session.terminal ?? say("outsideTerminal");
  return (
    <div className="cs-not-here" data-testid="cs-outside">
      <span>{say("outside", { terminal })}</span>
      <span className="cs-not-here-actions">
        {session.switchable && (
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => send({ type: "switchTo", sessionId: session.id })}>
            {say("switchTo", { terminal })}
          </button>
        )}
        {resume}
      </span>
    </div>
  );
}

function Cell({ leaf, pane, session, terminal, places, ready, onNewTerminal, onTalk, focused, selected, only, onFocus, onSplit, onClose, onLock, menu, look, say }: { leaf: Extract<Layout, { type: "leaf" }>; pane: string; session: SessionRow | undefined; terminal: TerminalRow | undefined; places: TerminalPlace[]; ready: boolean; onNewTerminal: (cwd: string) => void; onTalk: (s: SessionRow) => void; focused: boolean; selected: boolean; only: boolean; onFocus: () => void; onSplit: (d: "row" | "column") => void; onClose: () => void; onLock: () => void; menu: ReactNode; look: Look; say: Say }) {
  // Right-click on the bar, or on a cell with no terminal: inside a terminal it is the program's own.
  const withMenu = (node: ReactElement) => (
    <ContextMenu label={say("cellMenu")} trigger={node}>
      {menu}
    </ContextMenu>
  );
  const act = (type: "continue" | "openWorktree" | "openPr" | "focusHerdr" | "openThread") => session && send({ type, sessionId: session.id });
  const labels = useMemo(() => ({ detached: (reason: string | null) => (reason ? say("detached", { reason }) : say("detachedPlain")), reattach: say("reattach"), drop: say("dropFiles") }), [say]);
  return (
    <div className="cs-cell" data-cell={leaf.id} data-focused={focused || undefined} data-locked={leaf.locked || undefined} data-cell-terminal={terminal?.id} onMouseDownCapture={onFocus} onFocusCapture={onFocus}>
      {withMenu(<div className="cs-cell-bar">
        <span className="cs-cell-name">
          {session?.key ? (
            <>
              <span className="mono">{session.key}</span>{" "}
              {session.agentName && <><span className="cs-cell-agent">{session.agentName}</span>{" "}</>}
              {session.title ?? session.branch}
            </>
          ) : session ? (session.agentTitle ?? sessionName(session)) : terminal ? `${terminal.agentTitle ?? terminal.running ?? terminal.title} · ${terminal.cwd}` : say("pick")}
        </span>
        {session ? <StateChip s={session} say={say} /> : terminal?.agentStatus && <AgentChip status={terminal.agentStatus} say={say} />}
        {terminal?.note && !session && <span className="cs-cell-note" title={terminal.note}>{terminal.note}</span>}
        {terminal && !session && (
          <span className="cs-cell-actions">
            <button type="button" className="link-btn" onClick={() => send({ type: "closeTerminal", terminalId: terminal.id })}>{say("closeTerminal")}</button>
          </span>
        )}
        {session && (
          <span className="cs-cell-actions">
            {session.mode === "run" ? (
              <button type="button" className="link-btn" onClick={() => act("openThread")}>{say("openThread")}</button>
            ) : session.where === "herdr" ? (
              <>
                <button type="button" className="link-btn" onClick={() => act("continue")}>{say("continue")}</button>
                <button type="button" className="link-btn" onClick={() => act("focusHerdr")}>{say("focusHerdr")}</button>
              </>
            ) : null}
            <button type="button" className="link-btn" onClick={() => act("openWorktree")}>{say("openWorktree")}</button>
            <button type="button" className="link-btn" onClick={() => act("openPr")}>{say("openPr")}</button>
          </span>
        )}
        <span className="cs-cell-tools">
          {leaf.sessionId && (
            <button type="button" className="icon-btn cs-lock" data-testid="cs-lock" aria-pressed={!!leaf.locked} title={leaf.locked ? `${say("unlockCell")} · ${say("lockedHint")}` : say("lockCell")} aria-label={leaf.locked ? say("unlockCell") : say("lockCell")} onClick={onLock}>
              <LockGlyph locked={!!leaf.locked} />
            </button>
          )}
          <button type="button" className="icon-btn" title={say("withKey", { action: say("splitRight"), key: keyLabel("splitRight") })} aria-label={say("splitRight")} onClick={() => onSplit("row")}>⇥</button>
          <button type="button" className="icon-btn" title={say("withKey", { action: say("splitDown"), key: keyLabel("splitDown") })} aria-label={say("splitDown")} onClick={() => onSplit("column")}>⤓</button>
          <button type="button" className="icon-btn" title={only ? say("clearCell") : say("withKey", { action: say("closeCell"), key: keyLabel("close") })} aria-label={only ? say("clearCell") : say("closeCell")} onClick={onClose}>×</button>
        </span>
      </div>)}
      {session?.pane || terminal?.pane ? (
        <TerminalCell cell={leaf.id} sessionId={leaf.sessionId!} pane={pane} tokens={look.tokens} font={look.tokens["--font-mono"] ?? ""} labels={labels} autoFocus={selected} />
      ) : terminal ? (
        withMenu(<div className="cs-cell-empty">{say("starting")}</div>)
      ) : session ? (
        withMenu(
          <div className="cs-cell-empty">
            {session.mode === "run" ? say("runMode") : <NotHere session={session} cell={leaf.id} locale={look.locale} picker={<NewTerminal places={places} initial={session.worktree ?? session.cwd} ready={ready} onOpen={onNewTerminal} say={say} />} onTalk={() => onTalk(session)} say={say} />}
          </div>
        )
      ) : (
        withMenu(
          <div className="cs-cell-empty">
            <span>{say("pickOrNew")}</span>
            <NewTerminal places={places} ready={ready} onOpen={onNewTerminal} say={say} />
          </div>
        )
      )}
    </div>
  );
}

function Split({ node, render, onRatio }: { node: Extract<Layout, { type: "split" }>; render: (n: Layout) => ReactNode; onRatio: (id: string, ratio: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const drag = (e: React.PointerEvent) => {
    const el = box.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => onRatio(node.id, node.direction === "row" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={box} className="cs-split" data-direction={node.direction}>
      <div style={{ flex: `${node.ratio} 1 0` }} className="cs-split-part">{render(node.a)}</div>
      <div className="cs-divider" data-direction={node.direction} onPointerDown={drag} role="separator" aria-orientation={node.direction === "row" ? "vertical" : "horizontal"} />
      <div style={{ flex: `${1 - node.ratio} 1 0` }} className="cs-split-part">{render(node.b)}</div>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<WindowState | null>(null);
  const [look, setLook] = useState<Look | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [outsideOpen, setOutsideOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // The window's own say once it has spoken; until then, the fold the project's window was left with.
  const [foldedHere, setFoldedHere] = useState<boolean | null>(null);
  const folded = foldedHere ?? state?.folded ?? false;
  const toggleFold = useCallback(() => {
    setFoldedHere(!folded);
    send({ type: "fold", folded: !folded });
  }, [folded]);
  const openArchive = (open: boolean) => {
    setArchiveOpen(open);
    send({ type: "archive", open });
  };

  useEffect(() => onState((next) => setState(next)), []);
  useEffect(() => onLook(setLook), []);
  useEffect(() => onToast((text) => setToast({ text })), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  // The app's look: its theme variables on this document, and its language on the page.
  useEffect(() => {
    if (!look) return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(look.tokens)) root.style.setProperty(name, value);
    root.classList.toggle("dark", look.dark);
  }, [look]);
  const locale = look?.locale ?? state?.locale ?? "en";
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // The first state brings the remembered layout; after that the window owns it, minus sessions that went.
  // A terminal just asked for may miss from a state sent before the ask arrived; its cell keeps it a moment.
  const asked = useRef(new Map<string, number>());
  const known = useMemo(() => new Set([...(state?.sessions.map((s) => s.id) ?? []), ...(state?.archive.rows?.map((s) => s.id) ?? []), ...(state?.terminals.map((t) => t.id) ?? [])]), [state?.sessions, state?.archive.rows, state?.terminals]);
  const current = useRef<Layout | null>(null);
  // What the first state already listed is not new: only what appears after it is placed.
  const seen = useRef<Set<string> | null>(null);
  const focusedNow = useRef(focused);
  focusedNow.current = focused;
  // Cells in the order they were selected, the last selected last: a pick that must not go to the selected cell goes to the least recent.
  const recent = useRef<string[]>([]);
  useEffect(() => {
    if (focused) recent.current = [...recent.current.filter((id) => id !== focused), focused];
  }, [focused]);
  const revealed = useRef(0);
  // Ended sessions the person put in a cell to read: they stay, wherever their pane went on.
  const toRead = useRef(new Set<string>());
  // The window's keys, taken before a terminal hears them, so they never reach the shell; what they do is read from the latest render.
  const onWindowKey = useRef<(key: WindowKey) => void>(() => undefined);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const key = windowKey(e);
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      onWindowKey.current(key);
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, []);
  const change = useCallback((next: Layout) => {
    current.current = next;
    setLayout(next);
    send({ type: "layout", layout: next });
  }, []);
  useEffect(() => {
    if (!state) return;
    const now = Date.now();
    for (const [id, at] of asked.current) if (known.has(id) || now - at > ASKED_GRACE_MS) asked.current.delete(id);
    const key = paneKey(state);
    const kept = prune(current.current ?? state.layout, new Set([...known, ...asked.current.keys()]));
    // A ticket finished while the agent goes on in its pane: the cell follows the pane.
    const carried = new Map(state.sessions.flatMap((s) => (s.continuedIn && !toRead.current.has(s.id) ? [[s.id, s.continuedIn] as const] : [])));
    // One pane in one cell: a cell that would show it a second time is emptied, and that is saved.
    const pruned = dedupe(carryOn(kept, carried, key), key, focusedNow.current);
    const placeable = placeableIds(state);
    const fresh = seen.current ? placeable.filter((id) => !seen.current!.has(id)) : [];
    seen.current = new Set([...(seen.current ?? []), ...placeable]);
    let placed = state.autoPlace ? fresh.reduce((acc, id) => place(acc, id, key), pruned) : pruned;
    // Asked from outside (a start, "open in terminal", a ticket's earlier session): the session in a cell, that cell selected — once it has its pane, or ended, to read.
    const ask = state.reveal;
    if (ask && ask.at !== revealed.current && state.sessions.some((s) => s.id === ask.sessionId && (s.pane || s.endedAt !== null))) {
      revealed.current = ask.at;
      if (state.sessions.some((s) => s.id === ask.sessionId && s.endedAt !== null)) toRead.current.add(ask.sessionId);
      const shown = reveal(placed, ask.sessionId, focusedNow.current, key);
      placed = asPicked(state, shown.layout, shown.cell, ask.sessionId, key);
      setFocused(shown.cell);
    }
    if (placed !== kept) change(placed);
    else {
      current.current = pruned;
      setLayout(pruned);
    }
  }, [state, known, change]);

  const say: Say = useCallback((key, vars) => interpolate(message(locale, `codeSessions.${key}`), vars), [locale]);
  // The plugin would not stream a pane into a second cell: that cell empties, and the one showing it is selected.
  useEffect(
    () =>
      onShownIn(({ cell, other }) => {
        const now = current.current;
        if (now && leaves(now).some((l) => l.id === cell && l.sessionId)) change(show(now, cell, null));
        setFocused(other);
        setToast({ text: say("shownInOther") });
      }),
    [change, say]
  );
  const shown: Look = look ?? { theme: "", dark: false, tokens: {}, locale };

  // The selected cell's row comes into view in the list.
  const side = useRef<HTMLElement>(null);
  const selectedId = layout ? selectedCell(leaves(layout), focused).sessionId : null;
  useEffect(() => {
    side.current?.querySelector('.cs-row[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (!state || !layout) return null;
  const cells = leaves(layout);
  const target = selectedCell(cells, focused);
  // An archived session picked into a cell is in the archive's rows until the next state carries it.
  const byId = new Map([...(state.archive.rows ?? []), ...state.sessions].map((s) => [s.id, s]));
  const groups = sidebarRows(state.sessions, state.terminals);
  const terminalsById = new Map(state.terminals.map((t) => [t.id, t]));
  const key = paneKey(state);
  // A terminal whose agent claimed a ticket shows that session in its own cell, on the pane it already has.
  const sessionIn = (id: string | null) => (id ? byId.get(terminalsById.get(id)?.sessionId ?? id) : undefined);
  const rowsOf = (c: Leaf) => (c.sessionId ? [c.sessionId, terminalsById.get(c.sessionId)?.sessionId ?? c.sessionId] : []);
  // Every cell's row reads as shown; the selected cell's alone as current.
  const active = new Set(cells.flatMap(rowsOf));
  const selected = new Set(rowsOf(target));
  // The panes cells show, for the other tickets their agents work there.
  const shownPanes = new Set(cells.flatMap((c) => (c.sessionId ? [key(c.sessionId)] : [])));
  const selectedPane = target.sessionId ? key(target.sessionId) : null;
  // A server that is not running is started by the launch itself.
  const ready = state.bridge.state === "ready" || state.bridge.state === "notRunning";
  // Where herdr cannot show a terminal here (Windows), a new one opens in the system terminal instead.
  const outside = state.bridge.state === "unsupported";
  const canOpen = ready || outside;

  const nameOf = (id: string) => {
    const s = sessionIn(id);
    if (s) return sessionName(s);
    const t = terminalsById.get(id);
    return t ? (t.agentTitle ?? t.title) : id;
  };
  // Shown where `landing` says: never a second controller on the same pane, never over a locked cell or one that needs
  // you. Whatever left a pane is said, with a way back.
  const land = (id: string, beside: boolean) => {
    const at = landing(layout, id, { selected: target.id, beside, recent: recent.current, needsYou: (shown) => !!sessionIn(shown)?.needsYou, key });
    const next = asPicked(state, at.layout, at.cell, id, key);
    if (next !== layout) change(next);
    setFocused(at.cell);
    const left = at.replaced;
    if (!left) return;
    setToast({
      text: say("leftPane", { name: nameOf(left) }),
      action: {
        label: say("undo"),
        run: () => {
          const now = current.current;
          if (!now || !leaves(now).some((l) => l.id === at.cell)) return;
          // Put back unless another cell shows it by now.
          const elsewhere = holder(now, left, key);
          if (elsewhere && elsewhere.id !== at.cell) return setFocused(elsewhere.id);
          change(show(now, at.cell, left, key));
          setFocused(at.cell);
        }
      }
    });
  };
  const pick = (s: SessionRow, beside = false) => {
    if (!live(s)) toRead.current.add(s.id);
    if (s.mode === "run" && !s.pane) return send({ type: "openThread", sessionId: s.id });
    land(s.id, beside);
  };
  // The cell menu's "connect": one session or terminal into that cell.
  const connect = (cell: string, id: string) => {
    const s = byId.get(id);
    if (s?.mode === "run" && !s.pane) return send({ type: "openThread", sessionId: s.id });
    // Shown in a locked cell, or under the terminal it runs in, it stays there; else it moves to this cell.
    const holding = holder(layout, id, key);
    if (holding && (holding.locked || holding.sessionId !== id)) return setFocused(holding.id);
    change(show(layout, cell, id, key));
    setFocused(cell);
  };
  const cellMenu = (node: Extract<Layout, { type: "leaf" }>): ReactNode => {
    const terminals = state.terminals.filter((t) => !t.sessionId && t.pane);
    const choices = [...state.sessions.filter(live), ...terminals];
    return (
      <>
        <ContextMenuActionItem icon={null} name={node.locked ? say("unlockCell") : say("lockCell")} disabled={!node.sessionId} onSelect={() => change(lock(layout, node.id, !node.locked))} />
        {node.locked ? (
          <ContextMenuActionItem icon={null} name={say("connect")} disabled onSelect={() => undefined} />
        ) : (
          <ContextMenuSub icon={null} name={say("connect")}>
            {choices.length ? (
              choices.map((c) =>
                "branch" in c ? (
                  <ContextMenuActionItem key={c.id} icon={c.needsYou ? "●" : null} name={`${sessionName(c)}${(c.title ?? c.agentTitle) ? ` ${c.title ?? c.agentTitle}` : ""}`} onSelect={() => connect(node.id, c.id)} />
                ) : (
                  <ContextMenuActionItem key={c.id} icon={null} name={`${say("terminal")} · ${c.title}`} onSelect={() => connect(node.id, c.id)} />
                )
              )
            ) : (
              <ContextMenuActionItem icon={null} name={say("nothingToConnect")} disabled onSelect={() => undefined} />
            )}
          </ContextMenuSub>
        )}
        <ContextMenuActionItem icon={null} name={say("newTerminal")} disabled={!canOpen || !!node.locked} onSelect={() => openTerminal(layout, node.id, state.places[0]!.cwd)} />
        <ContextMenuActionItem icon={null} name={say("detach")} disabled={!node.sessionId || !!node.locked} onSelect={() => change(show(layout, node.id, null))} />
        <ContextMenuActionItem icon={null} name={say("splitRight")} hint={keyLabel("splitRight")} onSelect={() => change(split(layout, node.id, "row").layout)} />
        <ContextMenuActionItem icon={null} name={say("splitDown")} hint={keyLabel("splitDown")} onSelect={() => change(split(layout, node.id, "column").layout)} />
        <ContextMenuActionItem icon={null} name={cells.length === 1 ? say("clearCell") : say("closeCell")} hint={cells.length === 1 ? undefined : keyLabel("close")} onSelect={() => change(close(layout, node.id))} />
        {cells.length > 1 && (
          <ContextMenuSub icon={null} name={say("goToPane")}>
            {(["left", "right", "up", "down"] as const).map((d) => {
              const to = neighbour(layout, node.id, d);
              return <ContextMenuActionItem key={d} icon={null} name={say(`pane${d[0]!.toUpperCase()}${d.slice(1)}`)} hint={keyLabel(d)} disabled={!to} onSelect={() => to && select(to)} />;
            })}
            <ContextMenuActionItem icon={null} name={say("panePrevious")} hint={keyLabel("previous")} onSelect={() => select(cycle(layout, node.id, -1))} />
            <ContextMenuActionItem icon={null} name={say("paneNext")} hint={keyLabel("next")} onSelect={() => select(cycle(layout, node.id, 1))} />
          </ContextMenuSub>
        )}
      </>
    );
  };
  const pickTerminal = (t: TerminalRow, beside = false) => land(t.id, beside);
  const openTerminal = (base: Layout, cell: string, cwd: string | null, resume?: string) => {
    if (outside) return cwd ? send({ type: "openOutside", cwd }) : undefined;
    const terminalId = crypto.randomUUID();
    asked.current.set(terminalId, Date.now());
    change(show(base, cell, terminalId));
    setFocused(cell);
    send({ type: "newTerminal", terminalId, cwd, ...(resume ? { resume } : {}) });
  };
  // Selected by key: the keyboard goes along, to the cell's terminal, or nowhere for a cell without one.
  const select = (cell: string) => {
    setFocused(cell);
    requestAnimationFrame(() => {
      const box = document.querySelector<HTMLTextAreaElement>(`.cs-cell[data-cell="${cell}"] .xterm-helper-textarea`);
      if (box) box.focus();
      else (document.activeElement as HTMLElement | null)?.blur();
    });
  };
  const splitCell = (cell: string, direction: "row" | "column") => {
    const next = split(layout, cell, direction);
    change(next.layout);
    return next.created;
  };
  onWindowKey.current = (key) => {
    if (key === "fold") return toggleFold();
    if (key === "splitRight" || key === "splitDown") return select(splitCell(target.id, key === "splitRight" ? "row" : "column"));
    if (key === "close") {
      if (cells.length === 1) return window.close();
      const to = heir(layout, target.id);
      change(close(layout, target.id));
      return to && select(to);
    }
    if (key === "previous" || key === "next") return select(cycle(layout, target.id, key === "next" ? 1 : -1));
    const to = neighbour(layout, target.id, key);
    if (to) select(to);
  };
  // From the list's button: the first empty cell, or a new one beside the focused cell.
  const newTerminal = () => {
    if (outside) return send({ type: "openOutside", cwd: state.places[0]!.cwd });
    const empty = cells.find((c) => !c.sessionId);
    if (empty) return openTerminal(layout, empty.id, state.places[0]!.cwd);
    const next = split(layout, target.id, "row");
    openTerminal(next.layout, next.created, state.places[0]!.cwd);
  };

  const render = (node: Layout): ReactNode =>
    node.type === "split" ? (
      <Split key={node.id} node={node} render={render} onRatio={(id, ratio) => change(resize(layout, id, ratio))} />
    ) : (
      <Cell
        key={node.id}
        leaf={node}
        pane={node.sessionId ? key(node.sessionId) : ""}
        session={sessionIn(node.sessionId)}
        terminal={node.sessionId ? terminalsById.get(node.sessionId) : undefined}
        places={state.places}
        ready={canOpen}
        onNewTerminal={(cwd) => openTerminal(layout, node.id, cwd)}
        onTalk={(s) => openTerminal(layout, node.id, s.cwd ?? s.worktree, s.id)}
        focused={node.id === target.id && cells.length > 1}
        selected={node.id === target.id}
        only={cells.length === 1}
        onFocus={() => setFocused(node.id)}
        onLock={() => change(lock(layout, node.id, !node.locked))}
        onSplit={(direction) => setFocused(splitCell(node.id, direction))}
        onClose={() => change(close(layout, node.id))}
        menu={cellMenu(node)}
        look={shown}
        say={say}
      />
    );

  const needsYou = state.sessions.filter((s) => s.needsYou).length;
  const foldLabel = `${say(folded ? "unfold" : "fold")} (${keyLabel("fold")})`;

  return (
    <div className="cs-window">
      <aside ref={side} className="cs-side" data-folded={folded || undefined}>
        {folded ? (
          <div className="cs-strip">
            <button type="button" className="icon-btn cs-fold" data-testid="cs-fold" title={foldLabel} aria-label={foldLabel} onClick={toggleFold}>
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
              <button type="button" className="icon-btn cs-fold" data-testid="cs-fold" title={foldLabel} aria-label={foldLabel} onClick={toggleFold}>
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
                <ArchiveList rows={state.archive.rows} locale={locale} active={active} selected={selected} onPick={pick} say={say} />
              </>
            ) : (
              <>
                <div className="cs-side-head">
                  <h2 className="eyebrow">{say("here")}</h2>
                  <button type="button" className="link-btn side-add" data-testid="cs-side-new-terminal" disabled={!canOpen} onClick={newTerminal}>
                    + {say("newTerminal")}
                  </button>
                </div>
                {(groups.here.length > 0 || !groups.away.length) && <HereList rows={groups.here} active={active} selected={selected} shownPanes={shownPanes} selectedPane={selectedPane} pane={key} onSession={pick} onTerminal={pickTerminal} say={say} />}
                <OutsideGroup sessions={groups.away} open={outsideOpen} onToggle={() => setOutsideOpen((o) => !o)} list={<SessionList sessions={groups.away} active={active} selected={selected} onPick={pick} say={say} />} say={say} />
                <Layouts
                  presets={state.presets}
                  defaultPreset={state.defaultPreset}
                  autoPlace={state.autoPlace}
                  onApply={(p) => {
                    change(applyPreset(layout, p.layout, undefined, key));
                    setFocused(null);
                  }}
                  onSave={(name) => send({ type: "savePreset", name, layout })}
                  say={say}
                />
                <button type="button" className="link-btn cs-archive-open" data-testid="cs-archive" onClick={() => openArchive(true)}>
                  {say("archive", { n: state.archive.count })}
                </button>
              </>
            )}
          </>
        )}
      </aside>
      <main className="cs-main">
        <Banner state={state} say={say} />
        <div className="cs-layout">{render(layout)}</div>
      </main>
      {toast && (
        <div className="cs-toast" role="status" data-testid="cs-toast" onClick={() => setToast(null)}>
          {toast.text}
          {toast.action && (
            <button type="button" className="cs-toast-action" data-testid="cs-toast-action" onClick={toast.action.run}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
