import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { Layout, LayoutPreset, SessionRow, TerminalPlace, TerminalRow, WindowState } from "@tomradex/code-sessions";
import { ContextMenu, ContextMenuActionItem, ContextMenuSub } from "~/components/ui/menu";
import { interpolate, message } from "~/lib/dicts";
import { onLook, onState, onToast, send, type Look } from "./bridge";
import { applyPreset, close, leaves, place, prune, resize, show, split } from "./layout";
import { TerminalCell } from "./TerminalCell";

type Say = (key: string, vars?: Record<string, string | number>) => string;

const ASKED_GRACE_MS = 5000;

/** What can go into a cell by itself: a session with a terminal here that no terminal of the window already shows, and plain terminals. */
const placeableIds = (state: WindowState): string[] => {
  const folded = new Set(state.terminals.flatMap((t) => (t.sessionId ? [t.sessionId] : [])));
  return [...state.sessions.filter((s) => s.pane && live(s) && !folded.has(s.id)).map((s) => s.id), ...state.terminals.filter((t) => t.pane && !t.sessionId).map((t) => t.id)];
};

const live = (s: SessionRow) => s.state !== "ended" && s.state !== "lost";

type Leaf = Extract<Layout, { type: "leaf" }>;

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

function SessionList({ sessions, active, selected, onPick, say }: { sessions: SessionRow[]; active: Set<string>; selected: Set<string>; onPick: (s: SessionRow) => void; say: Say }) {
  if (!sessions.length) return <p className="cs-empty">{say("none")}</p>;
  return (
    <ul className="cs-list">
      {sessions.map((s) => (
        <li key={s.id}>
          <button type="button" className="side-row cs-row" aria-current={selected.has(s.id) ? "true" : undefined} data-active={active.has(s.id) || undefined} data-needs={s.needsYou || undefined} data-ended={!live(s) || undefined} onClick={() => onPick(s)}>
            <span className="cs-row-head">
              <span className="mono">{s.key ?? s.branch}</span>
              <span className="tag cs-chip" data-state={s.needsYou ? "needs" : s.state}>
                {s.needsYou ? say("needsYou") : say(s.state)}
              </span>
            </span>
            {s.title && <span className="cs-row-title">{s.title}</span>}
            <span className="cs-row-meta">
              <span className="mono">{s.branch}</span>
              {s.mode === "run" ? ` · ${say("runMode")}` : ""}
              {!s.pane && live(s) && s.where !== "tomrade" && (
                <span className="tag faint cs-chip cs-where" data-where={s.where} title={s.where === "elsewhere" ? say("elsewhere") : say("outsideTitle", { terminal: s.terminal ?? say("outsideTerminal") })}>
                  {s.where === "elsewhere" ? say("elsewhereTag") : (s.terminal ?? say("outsideTerminal"))}
                </span>
              )}
            </span>
            {s.activity && <span className="cs-row-activity">{s.activity}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function TerminalList({ terminals, active, selected, onPick, say }: { terminals: TerminalRow[]; active: Set<string>; selected: Set<string>; onPick: (t: TerminalRow) => void; say: Say }) {
  // One that became a code session is listed as that session.
  const plain = terminals.filter((t) => !t.sessionId);
  if (!plain.length) return null;
  return (
    <ul className="cs-list">
      {plain.map((t) => (
        <li key={t.id}>
          <button type="button" className="side-row cs-row" data-terminal={t.id} aria-current={selected.has(t.id) ? "true" : undefined} data-active={active.has(t.id) || undefined} onClick={() => onPick(t)}>
            <span className="cs-row-head">
              <span className="mono">{t.title}</span>
              {!t.pane && <span className="tag faint cs-chip">{say("starting")}</span>}
            </span>
            <span className="cs-row-meta mono">{t.cwd}</span>
          </button>
        </li>
      ))}
    </ul>
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
function NotHere({ session, picker, say }: { session: SessionRow; picker: ReactNode; say: Say }) {
  const done = session.state === "idle" || session.state === "ended" || session.state === "lost" || session.state === "error";
  // Never while the outside one may still run: two copies would share one conversation.
  const resume = done && session.where !== "elsewhere" && (
    <button type="button" className="btn btn-secondary btn-xs" onClick={() => send({ type: "continue", sessionId: session.id })}>
      {say("continueNew")}
    </button>
  );
  if (!live(session) || session.where === "herdr")
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

function Cell({ leaf, session, terminal, places, ready, onNewTerminal, focused, only, onFocus, onSplit, onClose, menu, look, say }: { leaf: Extract<Layout, { type: "leaf" }>; session: SessionRow | undefined; terminal: TerminalRow | undefined; places: TerminalPlace[]; ready: boolean; onNewTerminal: (cwd: string) => void; focused: boolean; only: boolean; onFocus: () => void; onSplit: (d: "row" | "column") => void; onClose: () => void; menu: ReactNode; look: Look; say: Say }) {
  // Right-click on the bar, or on a cell with no terminal: inside a terminal it is the program's own.
  const withMenu = (node: ReactElement) => (
    <ContextMenu label={say("cellMenu")} trigger={node}>
      {menu}
    </ContextMenu>
  );
  const act = (type: "continue" | "openWorktree" | "openPr" | "focusHerdr" | "openThread") => session && send({ type, sessionId: session.id });
  const labels = useMemo(() => ({ detached: (reason: string | null) => (reason ? say("detached", { reason }) : say("detachedPlain")), reattach: say("reattach"), drop: say("dropFiles") }), [say]);
  return (
    <div className="cs-cell" data-focused={focused || undefined} data-cell-terminal={terminal?.id} onMouseDownCapture={onFocus}>
      {withMenu(<div className="cs-cell-bar">
        <span className="cs-cell-name">{session ? `${session.key ?? ""} ${session.title ?? session.branch}`.trim() : terminal ? `${terminal.title} · ${terminal.cwd}` : say("pick")}</span>
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
          <button type="button" className="icon-btn" title={say("splitRight")} aria-label={say("splitRight")} onClick={() => onSplit("row")}>⇥</button>
          <button type="button" className="icon-btn" title={say("splitDown")} aria-label={say("splitDown")} onClick={() => onSplit("column")}>⤓</button>
          <button type="button" className="icon-btn" title={only ? say("clearCell") : say("closeCell")} aria-label={only ? say("clearCell") : say("closeCell")} onClick={onClose}>×</button>
        </span>
      </div>)}
      {session?.pane || terminal?.pane ? (
        <TerminalCell cell={leaf.id} sessionId={leaf.sessionId!} tokens={look.tokens} font={look.tokens["--font-mono"] ?? ""} labels={labels} />
      ) : terminal ? (
        withMenu(<div className="cs-cell-empty">{say("starting")}</div>)
      ) : session ? (
        withMenu(
          <div className="cs-cell-empty">
            {session.mode === "run" ? say("runMode") : <NotHere session={session} picker={<NewTerminal places={places} initial={session.worktree} ready={ready} onOpen={onNewTerminal} say={say} />} say={say} />}
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
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => onState((next) => setState(next)), []);
  useEffect(() => onLook(setLook), []);
  useEffect(() => onToast((text) => setToast(text)), []);
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
  const known = useMemo(() => new Set([...(state?.sessions.map((s) => s.id) ?? []), ...(state?.terminals.map((t) => t.id) ?? [])]), [state?.sessions, state?.terminals]);
  const current = useRef<Layout | null>(null);
  // What the first state already listed is not new: only what appears after it is placed.
  const seen = useRef<Set<string> | null>(null);
  const change = useCallback((next: Layout) => {
    current.current = next;
    setLayout(next);
    send({ type: "layout", layout: next });
  }, []);
  useEffect(() => {
    if (!state) return;
    const now = Date.now();
    for (const [id, at] of asked.current) if (known.has(id) || now - at > ASKED_GRACE_MS) asked.current.delete(id);
    const pruned = prune(current.current ?? state.layout, new Set([...known, ...asked.current.keys()]));
    const placeable = placeableIds(state);
    const fresh = seen.current ? placeable.filter((id) => !seen.current!.has(id)) : [];
    seen.current = new Set([...(seen.current ?? []), ...placeable]);
    const shownIds = new Set(leaves(pruned).flatMap((l) => (l.sessionId ? [l.sessionId, state.terminals.find((t) => t.id === l.sessionId)?.sessionId ?? l.sessionId] : [])));
    const placed = state.autoPlace ? fresh.filter((id) => !shownIds.has(id)).reduce(place, pruned) : pruned;
    if (placed !== pruned) change(placed);
    else {
      current.current = pruned;
      setLayout(pruned);
    }
  }, [state, known, change]);

  const say: Say = useCallback((key, vars) => interpolate(message(locale, `codeSessions.${key}`), vars), [locale]);
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
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const terminalsById = new Map(state.terminals.map((t) => [t.id, t]));
  // A terminal whose agent claimed a ticket shows that session in its own cell, on the pane it already has.
  const sessionIn = (id: string | null) => (id ? byId.get(terminalsById.get(id)?.sessionId ?? id) : undefined);
  const rowsOf = (c: Leaf) => (c.sessionId ? [c.sessionId, terminalsById.get(c.sessionId)?.sessionId ?? c.sessionId] : []);
  // Every cell's row reads as shown; the selected cell's alone as current.
  const active = new Set(cells.flatMap(rowsOf));
  const selected = new Set(rowsOf(target));
  // A server that is not running is started by the launch itself.
  const ready = state.bridge.state === "ready" || state.bridge.state === "notRunning";
  // Where herdr cannot show a terminal here (Windows), a new one opens in the system terminal instead.
  const outside = state.bridge.state === "unsupported";
  const canOpen = ready || outside;

  const pick = (s: SessionRow) => {
    if (s.mode === "run" && !s.pane) return send({ type: "openThread", sessionId: s.id });
    // Already in a terminal's cell: that cell, never a second controller on the same pane.
    const holding = cells.find((c) => c.sessionId && terminalsById.get(c.sessionId)?.sessionId === s.id);
    if (holding) return setFocused(holding.id);
    change(show(layout, target.id, s.id));
    setFocused(target.id);
  };
  // The cell menu's "connect": one session or terminal into that cell.
  const connect = (cell: string, id: string) => {
    const s = byId.get(id);
    if (s?.mode === "run" && !s.pane) return send({ type: "openThread", sessionId: s.id });
    const holding = cells.find((c) => c.sessionId && terminalsById.get(c.sessionId)?.sessionId === id);
    if (holding) return setFocused(holding.id);
    change(show(layout, cell, id));
    setFocused(cell);
  };
  const cellMenu = (node: Extract<Layout, { type: "leaf" }>): ReactNode => {
    const terminals = state.terminals.filter((t) => !t.sessionId && t.pane);
    const choices = [...state.sessions.filter(live), ...terminals];
    return (
      <>
        <ContextMenuSub icon={null} name={say("connect")}>
          {choices.length ? (
            choices.map((c) =>
              "branch" in c ? (
                <ContextMenuActionItem key={c.id} icon={c.needsYou ? "●" : null} name={`${c.key ?? c.branch}${c.title ? ` ${c.title}` : ""}`} onSelect={() => connect(node.id, c.id)} />
              ) : (
                <ContextMenuActionItem key={c.id} icon={null} name={`${say("terminal")} · ${c.title}`} onSelect={() => connect(node.id, c.id)} />
              )
            )
          ) : (
            <ContextMenuActionItem icon={null} name={say("nothingToConnect")} disabled onSelect={() => undefined} />
          )}
        </ContextMenuSub>
        <ContextMenuActionItem icon={null} name={say("newTerminal")} disabled={!canOpen} onSelect={() => openTerminal(layout, node.id, state.places[0]!.cwd)} />
        <ContextMenuActionItem icon={null} name={say("detach")} disabled={!node.sessionId} onSelect={() => change(show(layout, node.id, null))} />
        <ContextMenuActionItem icon={null} name={say("splitRight")} onSelect={() => change(split(layout, node.id, "row").layout)} />
        <ContextMenuActionItem icon={null} name={say("splitDown")} onSelect={() => change(split(layout, node.id, "column").layout)} />
        <ContextMenuActionItem icon={null} name={cells.length === 1 ? say("clearCell") : say("closeCell")} onSelect={() => change(close(layout, node.id))} />
      </>
    );
  };
  const pickTerminal = (t: TerminalRow) => {
    change(show(layout, target.id, t.id));
    setFocused(target.id);
  };
  const openTerminal = (base: Layout, cell: string, cwd: string) => {
    if (outside) return send({ type: "openOutside", cwd });
    const terminalId = crypto.randomUUID();
    asked.current.set(terminalId, Date.now());
    change(show(base, cell, terminalId));
    setFocused(cell);
    send({ type: "newTerminal", terminalId, cwd });
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
        session={sessionIn(node.sessionId)}
        terminal={node.sessionId ? terminalsById.get(node.sessionId) : undefined}
        places={state.places}
        ready={canOpen}
        onNewTerminal={(cwd) => openTerminal(layout, node.id, cwd)}
        focused={node.id === target.id && cells.length > 1}
        only={cells.length === 1}
        onFocus={() => setFocused(node.id)}
        onSplit={(direction) => {
          const next = split(layout, node.id, direction);
          change(next.layout);
          setFocused(next.created);
        }}
        onClose={() => change(close(layout, node.id))}
        menu={cellMenu(node)}
        look={shown}
        say={say}
      />
    );

  return (
    <div className="cs-window">
      <aside ref={side} className="cs-side">
        <h2 className="cs-side-head eyebrow">{say("sessions")}</h2>
        <SessionList sessions={state.sessions} active={active} selected={selected} onPick={pick} say={say} />
        <div className="cs-side-head cs-side-sub">
          <h2 className="eyebrow">{say("terminals")}</h2>
          <button type="button" className="link-btn side-add" data-testid="cs-side-new-terminal" disabled={!canOpen} onClick={newTerminal}>
            + {say("newTerminal")}
          </button>
        </div>
        <TerminalList terminals={state.terminals} active={active} selected={selected} onPick={pickTerminal} say={say} />
        <Layouts
          presets={state.presets}
          defaultPreset={state.defaultPreset}
          autoPlace={state.autoPlace}
          onApply={(p) => {
            change(applyPreset(layout, p.layout));
            setFocused(null);
          }}
          onSave={(name) => send({ type: "savePreset", name, layout })}
          say={say}
        />
      </aside>
      <main className="cs-main">
        <Banner state={state} say={say} />
        <div className="cs-layout">{render(layout)}</div>
      </main>
      {toast && (
        <div className="cs-toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
