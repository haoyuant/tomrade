import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Layout, SessionRow, TerminalPlace, TerminalRow, WindowState } from "@tomradex/code-sessions";
import { interpolate, message } from "~/lib/dicts";
import { onLook, onState, onToast, send, type Look } from "./bridge";
import { close, leaves, prune, resize, show, split } from "./layout";
import { TerminalCell } from "./TerminalCell";

type Say = (key: string, vars?: Record<string, string | number>) => string;

const ASKED_GRACE_MS = 5000;

const live = (s: SessionRow) => s.state !== "ended" && s.state !== "lost";

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

function SessionList({ sessions, active, onPick, say }: { sessions: SessionRow[]; active: Set<string>; onPick: (s: SessionRow) => void; say: Say }) {
  if (!sessions.length) return <p className="cs-empty">{say("none")}</p>;
  return (
    <ul className="cs-list">
      {sessions.map((s) => (
        <li key={s.id}>
          <button type="button" className="cs-row" data-active={active.has(s.id) || undefined} data-needs={s.needsYou || undefined} data-ended={!live(s) || undefined} onClick={() => onPick(s)}>
            <span className="cs-row-head">
              <span className="mono">{s.key ?? s.branch}</span>
              <span className="cs-chip" data-state={s.needsYou ? "needs" : s.state}>
                {s.needsYou ? say("needsYou") : say(s.state)}
              </span>
            </span>
            {s.title && <span className="cs-row-title">{s.title}</span>}
            <span className="cs-row-meta">
              <span className="mono">{s.branch}</span>
              {s.mode === "run" ? ` · ${say("runMode")}` : !s.pane && live(s) ? ` · ${say("otherMachine")}` : ""}
            </span>
            {s.activity && <span className="cs-row-activity">{s.activity}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function TerminalList({ terminals, active, onPick, say }: { terminals: TerminalRow[]; active: Set<string>; onPick: (t: TerminalRow) => void; say: Say }) {
  if (!terminals.length) return null;
  return (
    <ul className="cs-list">
      {terminals.map((t) => (
        <li key={t.id}>
          <button type="button" className="cs-row" data-terminal={t.id} data-active={active.has(t.id) || undefined} onClick={() => onPick(t)}>
            <span className="cs-row-head">
              <span className="mono">{t.title}</span>
              {!t.pane && <span className="cs-chip">{say("starting")}</span>}
            </span>
            <span className="cs-row-meta mono">{t.cwd}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** An empty cell's way to a new terminal: where it starts, then the button. */
function NewTerminal({ places, ready, onOpen, say }: { places: TerminalPlace[]; ready: boolean; onOpen: (cwd: string) => void; say: Say }) {
  const [cwd, setCwd] = useState(places[0]?.cwd ?? "");
  const where = places.some((p) => p.cwd === cwd) ? cwd : (places[0]?.cwd ?? "");
  return (
    <div className="cs-new-terminal">
      {places.length > 1 && (
        <label>
          {say("startIn")}{" "}
          <select value={where} onChange={(e) => setCwd(e.target.value)}>
            {places.map((p) => (
              <option key={p.cwd} value={p.cwd} title={p.cwd}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-new-terminal" disabled={!ready || !where} onClick={() => onOpen(where)}>
        {say("newTerminal")}
      </button>
    </div>
  );
}

function Cell({ leaf, session, terminal, places, ready, onNewTerminal, focused, only, onFocus, onSplit, onClose, look, say }: { leaf: Extract<Layout, { type: "leaf" }>; session: SessionRow | undefined; terminal: TerminalRow | undefined; places: TerminalPlace[]; ready: boolean; onNewTerminal: (cwd: string) => void; focused: boolean; only: boolean; onFocus: () => void; onSplit: (d: "row" | "column") => void; onClose: () => void; look: Look; say: Say }) {
  const act = (type: "continue" | "openWorktree" | "openPr" | "focusHerdr" | "openThread") => session && send({ type, sessionId: session.id });
  const labels = useMemo(() => ({ detached: (reason: string | null) => (reason ? say("detached", { reason }) : say("detachedPlain")), reattach: say("reattach") }), [say]);
  return (
    <div className="cs-cell" data-focused={focused || undefined} data-cell-terminal={terminal?.id} onMouseDownCapture={onFocus}>
      <div className="cs-cell-bar">
        <span className="cs-cell-name">{session ? `${session.key ?? ""} ${session.title ?? session.branch}`.trim() : terminal ? `${terminal.title} · ${terminal.cwd}` : say("pick")}</span>
        {terminal && (
          <span className="cs-cell-actions">
            <button type="button" className="link-btn" onClick={() => send({ type: "closeTerminal", terminalId: terminal.id })}>{say("closeTerminal")}</button>
          </span>
        )}
        {session && (
          <span className="cs-cell-actions">
            {session.mode === "run" ? (
              <button type="button" className="link-btn" onClick={() => act("openThread")}>{say("openThread")}</button>
            ) : (
              <>
                <button type="button" className="link-btn" onClick={() => act("continue")}>{say("continue")}</button>
                <button type="button" className="link-btn" onClick={() => act("focusHerdr")}>{say("focusHerdr")}</button>
              </>
            )}
            <button type="button" className="link-btn" onClick={() => act("openWorktree")}>{say("openWorktree")}</button>
            <button type="button" className="link-btn" onClick={() => act("openPr")}>{say("openPr")}</button>
          </span>
        )}
        <span className="cs-cell-tools">
          <button type="button" className="icon-btn" title={say("splitRight")} aria-label={say("splitRight")} onClick={() => onSplit("row")}>⇥</button>
          <button type="button" className="icon-btn" title={say("splitDown")} aria-label={say("splitDown")} onClick={() => onSplit("column")}>⤓</button>
          <button type="button" className="icon-btn" title={only ? say("clearCell") : say("closeCell")} aria-label={only ? say("clearCell") : say("closeCell")} onClick={onClose}>×</button>
        </span>
      </div>
      {session?.pane || terminal?.pane ? (
        <TerminalCell cell={leaf.id} sessionId={(session ?? terminal)!.id} tokens={look.tokens} font={look.tokens["--font-mono"] ?? ""} labels={labels} />
      ) : terminal ? (
        <div className="cs-cell-empty">{say("starting")}</div>
      ) : session ? (
        <div className="cs-cell-empty">{session.mode === "run" ? say("runMode") : say("otherMachine")}</div>
      ) : (
        <div className="cs-cell-empty">
          <span>{say("pickOrNew")}</span>
          <NewTerminal places={places} ready={ready} onOpen={onNewTerminal} say={say} />
        </div>
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
  useEffect(() => {
    if (!state) return;
    const now = Date.now();
    for (const [id, at] of asked.current) if (known.has(id) || now - at > ASKED_GRACE_MS) asked.current.delete(id);
    setLayout((current) => prune(current ?? state.layout, new Set([...known, ...asked.current.keys()])));
  }, [state, known]);
  const change = useCallback((next: Layout) => {
    setLayout(next);
    send({ type: "layout", layout: next });
  }, []);

  const say: Say = useCallback((key, vars) => interpolate(message(locale, `codeSessions.${key}`), vars), [locale]);
  const shown: Look = look ?? { theme: "", dark: false, tokens: {}, locale };

  if (!state || !layout) return null;
  const cells = leaves(layout);
  const target = cells.find((c) => c.id === focused) ?? cells.find((c) => !c.sessionId) ?? cells[0]!;
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const terminalsById = new Map(state.terminals.map((t) => [t.id, t]));
  const active = new Set(cells.map((c) => c.sessionId).filter((id): id is string => !!id));
  // A server that is not running is started by the launch itself.
  const ready = state.bridge.state === "ready" || state.bridge.state === "notRunning";

  const pick = (s: SessionRow) => {
    if (s.mode === "run" && !s.pane) return send({ type: "openThread", sessionId: s.id });
    change(show(layout, target.id, s.id));
    setFocused(target.id);
  };
  const pickTerminal = (t: TerminalRow) => {
    change(show(layout, target.id, t.id));
    setFocused(target.id);
  };
  const openTerminal = (base: Layout, cell: string, cwd: string) => {
    const terminalId = crypto.randomUUID();
    asked.current.set(terminalId, Date.now());
    change(show(base, cell, terminalId));
    setFocused(cell);
    send({ type: "newTerminal", terminalId, cwd });
  };
  // From the list's button: the first empty cell, or a new one beside the focused cell.
  const newTerminal = () => {
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
        session={node.sessionId ? byId.get(node.sessionId) : undefined}
        terminal={node.sessionId ? terminalsById.get(node.sessionId) : undefined}
        places={state.places}
        ready={ready}
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
        look={shown}
        say={say}
      />
    );

  return (
    <div className="cs-window">
      <aside className="cs-side">
        <h2 className="cs-side-head">{say("sessions")}</h2>
        <SessionList sessions={state.sessions} active={active} onPick={pick} say={say} />
        <div className="cs-side-head cs-side-sub">
          <h2>{say("terminals")}</h2>
          <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-side-new-terminal" disabled={!ready} onClick={newTerminal}>
            + {say("newTerminal")}
          </button>
        </div>
        <TerminalList terminals={state.terminals} active={active} onPick={pickTerminal} say={say} />
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
