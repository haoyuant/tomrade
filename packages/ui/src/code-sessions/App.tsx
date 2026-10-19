import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Layout, SessionRow, WindowState } from "@tomradex/code-sessions";
import { interpolate, message } from "~/lib/dicts";
import { onLook, onState, onToast, send, type Look } from "./bridge";
import { close, leaves, prune, resize, show, split } from "./layout";
import { TerminalCell } from "./TerminalCell";

type Say = (key: string, vars?: Record<string, string | number>) => string;

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

function Cell({ leaf, session, focused, only, onFocus, onSplit, onClose, look, say }: { leaf: Extract<Layout, { type: "leaf" }>; session: SessionRow | undefined; focused: boolean; only: boolean; onFocus: () => void; onSplit: (d: "row" | "column") => void; onClose: () => void; look: Look; say: Say }) {
  const act = (type: "continue" | "openWorktree" | "openPr" | "focusHerdr" | "openThread") => session && send({ type, sessionId: session.id });
  const labels = useMemo(() => ({ detached: (reason: string | null) => (reason ? say("detached", { reason }) : say("detachedPlain")), reattach: say("reattach") }), [say]);
  return (
    <div className="cs-cell" data-focused={focused || undefined} onMouseDownCapture={onFocus}>
      <div className="cs-cell-bar">
        <span className="cs-cell-name">{session ? `${session.key ?? ""} ${session.title ?? session.branch}`.trim() : say("pick")}</span>
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
      {session?.pane ? (
        <TerminalCell cell={leaf.id} sessionId={session.id} tokens={look.tokens} font={look.tokens["--font-mono"] ?? ""} labels={labels} />
      ) : (
        <div className="cs-cell-empty">{session ? (session.mode === "run" ? say("runMode") : say("otherMachine")) : say("pick")}</div>
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
  const known = useMemo(() => new Set(state?.sessions.map((s) => s.id) ?? []), [state?.sessions]);
  useEffect(() => {
    if (!state) return;
    setLayout((current) => prune(current ?? state.layout, known));
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
  const active = new Set(cells.map((c) => c.sessionId).filter((id): id is string => !!id));

  const pick = (s: SessionRow) => {
    if (s.mode === "run" && !s.pane) return send({ type: "openThread", sessionId: s.id });
    change(show(layout, target.id, s.id));
    setFocused(target.id);
  };

  const render = (node: Layout): ReactNode =>
    node.type === "split" ? (
      <Split key={node.id} node={node} render={render} onRatio={(id, ratio) => change(resize(layout, id, ratio))} />
    ) : (
      <Cell
        key={node.id}
        leaf={node}
        session={node.sessionId ? byId.get(node.sessionId) : undefined}
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
