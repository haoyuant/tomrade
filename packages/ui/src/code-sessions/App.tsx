import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Layout, SessionRow, TerminalRow, WindowState } from "@tomradex/code-sessions";
import { ContextMenuActionItem, ContextMenuSub } from "~/components/ui/menu";
import { useLocaleWords } from "~/lib/dicts";
import { onLook, onShownIn, onState, onToast, send, type Look } from "./bridge";
import { Cell } from "./Cell";
import { keyLabel, windowKey, type WindowKey } from "./keys";
import { applyPreset, carryOn, close, cycle, heir, holder, landing, leaves, lock, neighbour, resize, show, split } from "./layout";
import { live, sessionName } from "./lists";
import { SayContext, sayIn, useSay, type SayKey } from "./say";
import { Sidebar } from "./Sidebar";
import { asPicked, carriedOf, paneKey, useWindowLayout, type Leaf } from "./useWindowLayout";

type Toast = { text: string; action?: { label: string; run: () => void } };

/** The selected cell, where a pick from the list goes: the one clicked last, else the first empty one, else the first. */
const selectedCell = (cells: Leaf[], focused: string | null): Leaf => cells.find((c) => c.id === focused) ?? cells.find((c) => !c.sessionId) ?? cells[0]!;

/** The cell menu's words for a direction. */
const PANE_WORD: Record<"left" | "right" | "up" | "down", SayKey> = { left: "paneLeft", right: "paneRight", up: "paneUp", down: "paneDown" };

function Banner({ state }: { state: WindowState }) {
  const say = useSay();
  const b = state.bridge;
  // Tomrade's own terminal host (native Windows): nothing of herdr's to install, start or switch to.
  const builtin = state.provider === "builtin";
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
  else if (state.revive === "starting") body = <span>{say(builtin ? "hostStarting" : "herdrStarting")}</span>;
  else if (state.revive === "failed" && (builtin || b.state === "notRunning"))
    body = (
      <>
        <span>{say(builtin ? "hostStartFailed" : "herdrStartFailed")}</span>
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
          <span>{say(builtin ? "askSwitchBuiltin" : "askSwitch", { terminal: state.terminal })}</span>
          <button type="button" className="btn btn-primary btn-xs" onClick={() => send({ type: "switchTerminal", switch: true })}>
            {say(builtin ? "switchYesBuiltin" : "switchYes")}
          </button>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => send({ type: "switchTerminal", switch: false })}>
            {say("switchNo")}
          </button>
        </div>
      )}
    </>
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
  const { laid, focused, setFocused, change, current, asked, recent, toRead } = useWindowLayout(state);
  const [toast, setToast] = useState<Toast | null>(null);
  // The window's own say once it has spoken; until then, the fold the project's window was left with.
  const [foldedHere, setFoldedHere] = useState<boolean | null>(null);
  const folded = foldedHere ?? state?.folded ?? false;
  const toggleFold = useCallback(() => {
    setFoldedHere(!folded);
    send({ type: "fold", folded: !folded });
  }, [folded]);

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

  // Its words, once a language shipped on demand has arrived.
  const words = useLocaleWords(locale);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const say = useMemo(() => sayIn(locale), [locale, words]);
  // The plugin would not stream a pane into a second cell: that cell empties, and the one showing it is selected.
  useEffect(
    () =>
      onShownIn(({ cell, other }) => {
        const now = current.current;
        if (now && leaves(now).some((l) => l.id === cell && l.sessionId)) change(show(now, cell, null));
        setFocused(other);
        setToast({ text: say("shownInOther") });
      }),
    [change, say, current, setFocused]
  );
  const shown: Look = look ?? { theme: "", dark: false, tokens: {}, locale };

  // The selected cell's row comes into view in the list.
  const side = useRef<HTMLElement>(null);
  const selectedId = laid ? selectedCell(leaves(laid), focused).sessionId : null;
  useEffect(() => {
    side.current?.querySelector('.cs-row[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (!state || !laid) return null;
  const key = paneKey(state);
  // Drawn handed over already, before the effect saves it: a cell whose ticket just finished keeps its terminal attached.
  const layout = carryOn(laid, carriedOf(state, toRead.current), key);
  const cells = leaves(layout);
  const target = selectedCell(cells, focused);
  // An archived session picked into a cell is in the archive's rows until the next state carries it.
  const byId = new Map([...(state.archive.rows ?? []), ...state.sessions].map((s) => [s.id, s]));
  const terminalsById = new Map(state.terminals.map((t) => [t.id, t]));
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
              return <ContextMenuActionItem key={d} icon={null} name={say(PANE_WORD[d])} hint={keyLabel(d)} disabled={!to} onSelect={() => to && select(to)} />;
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
        herdrClient={state.herdrClient}
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
      />
    );

  return (
    <SayContext.Provider value={say}>
      <div className="cs-window">
        <Sidebar
          ref={side}
          state={state}
          locale={locale}
          folded={folded}
          onFold={toggleFold}
          active={active}
          selected={selected}
          shownPanes={shownPanes}
          selectedPane={selectedPane}
          pane={key}
          canOpen={canOpen}
          onPick={pick}
          onTerminal={pickTerminal}
          onNewTerminal={newTerminal}
          onApplyPreset={(p) => {
            change(applyPreset(layout, p.layout, undefined, key));
            setFocused(null);
          }}
          onSavePreset={(name) => send({ type: "savePreset", name, layout })}
        />
        <main className="cs-main">
          <Banner state={state} />
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
    </SayContext.Provider>
  );
}
