import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ClosedTerminalRow, Layout, SessionRow, TerminalRow, ThreadRow, WindowState } from "@tomradex/code-sessions";
import { Icon, IconSprite } from "~/components/icons";
import { ContextMenuActionItem, ContextMenuSub } from "~/components/ui/menu";
import { useLocaleWords } from "~/lib/dicts";
import { useFrosted } from "~/lib/frost";
import { announceKeymap, formatChord, hits, primeKeymap, resolveKeymap } from "~/lib/keybindings";
import { backdropFills } from "@tomradex/theme-image/colors";
import { answerSession, answerThreadAsk, onLook, onShownIn, onState, onTails, onToast, send, terminalPicture, type Look } from "./bridge";
import { Cell } from "./Cell";
import { clipboardOf } from "./clipboard";
import { GuessContext, guessesByPane } from "./guess";
import { arrowsLabel, keyLabel, windowKey, type WindowKey } from "./keys";
import { applyPreset, carryOn, close, cycle, heir, holder, landing, leaves, lock, neighbour, resize, show, split } from "./layout";
import { activeRows, live, sessionName, sidebarRows, type HereRow } from "./lists";
import { Overview } from "./Overview";
import { Palette, type PaletteAction } from "./Palette";
import { SayContext, sayIn, useSay, WordsContext, wordsIn, type SayKey } from "./say";
import { Sidebar } from "./Sidebar";
import { asPicked, carriedOf, paneKey, useWindowLayout, type Leaf, type Picked } from "./useWindowLayout";

/** What a cell's buttons and menu do, read from the window's latest render when they are used. */
interface CellActs {
  newTerminal(cell: string, cwd: string): void;
  talk(cell: string, s: SessionRow): void;
  focus(cell: string): void;
  lock(cell: string): void;
  split(cell: string, direction: "row" | "column"): void;
  close(cell: string): void;
  menu(cell: string): ReactNode;
}
type CellHandlers = { onNewTerminal: (cwd: string) => void; onTalk: (s: SessionRow) => void; onFocus: () => void; onLock: () => void; onSplit: (d: "row" | "column") => void; onClose: () => void; menu: ReactNode };

/** A cell's menu, made as it opens from the window as it is then. */
function CellMenu({ cell, acts }: { cell: string; acts: { current: CellActs | null } }) {
  return <>{acts.current?.menu(cell)}</>;
}

type Toast = { text: string; action?: { label: string; run: () => void } };

/** How often the overview reads the panes' last lines while it is open. */
const TAILS_EVERY_MS = 2000;

const sameTails = (a: Record<string, string | null>, b: Record<string, string | null>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && a[k] === b[k]);
};

/** Whether anyone can see the window: not when it is minimised, hidden or covered. */
const seen = () => document.visibilityState !== "hidden";

/** The keys the window keeps, said along its bottom edge the way this platform writes them. */
function KeysFooter() {
  const say = useSay();
  return (
    <footer className="cs-keys" data-testid="cs-keys">
      <span>{say("keysNote")}</span>
      <span><kbd>{keyLabel("splitRight")}</kbd> {say("keySplitRight")}</span>
      <span><kbd>{keyLabel("splitDown")}</kbd> {say("keySplitDown")}</span>
      <span><kbd>{keyLabel("close")}</kbd> {say("keyClose")}</span>
      <span><kbd>{arrowsLabel()}</kbd> {say("keyArrows")}</span>
      <span><kbd>{keyLabel("previous")}</kbd> <kbd>{keyLabel("next")}</kbd> {say("keyPrevNext")}</span>
      <span><kbd>{keyLabel("fold")}</kbd> {say("keyFold")}</span>
      <span>{say("keyOnlyNew")} <kbd>{keyLabel("palette")}</kbd></span>
    </footer>
  );
}

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
  else if (b.state === "forbidden") body = <span>{say("hostForbidden")}</span>;
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
  // Ended sessions and closed terminals picked from History: a cell shows one before a state carries it.
  const [picked, setPicked] = useState<Picked>(() => ({ sessions: new Map(), terminals: new Map() }));
  const { laid, focused, setFocused, change, current, asked, recent, toRead, flash } = useWindowLayout(state, picked);
  const [toast, setToast] = useState<Toast | null>(null);
  // The window's own say once it has spoken; until then, the fold the project's window was left with.
  const [foldedHere, setFoldedHere] = useState<boolean | null>(null);
  const folded = foldedHere ?? state?.folded ?? false;
  const toggleFold = useCallback(() => {
    setFoldedHere(!folded);
    send({ type: "fold", folded: !folded });
  }, [folded]);
  // The cells, or every session as one big card over them; the cells stay attached underneath.
  const [view, setView] = useState<"grid" | "overview">("grid");
  // The window's own choice once made; until then, the one the project's window was left with.
  const [overviewAllHere, setOverviewAllHere] = useState<boolean | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tails, setTails] = useState<Record<string, string | null>>({});
  const rows = useMemo(() => (state ? sidebarRows(state.sessions, state.terminals, state.threads) : { here: [], away: [] }), [state]);
  const guesses = useMemo(() => guessesByPane(state?.sessions ?? []), [state]);
  // The person's keys, as the app's window has them: copy and paste here are theirs.
  const overrides = state?.keybindings;
  const overridesKey = JSON.stringify(overrides ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const keymap = useMemo(() => resolveKeymap(overrides), [overridesKey]);
  primeKeymap(keymap);
  useLayoutEffect(announceKeymap, [keymap]);

  useEffect(() => onState((next) => setState(next)), []);
  useEffect(() => onLook(setLook), []);
  useEffect(() => onToast((text) => setToast({ text })), []);
  useEffect(() => onTails((post) => setTails((was) => (sameTails(was, post.panes) ? was : post.panes))), []);
  // Nobody sees it: the plugin stops asking herdr for it and sending it state, and the overview stops reading tails.
  const [visible, setVisible] = useState(seen);
  useEffect(() => {
    const changed = () => {
      setVisible(seen());
      send({ type: "visible", visible: seen() });
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (view !== "overview" || !visible) return;
    send({ type: "tails" });
    const timer = setInterval(() => send({ type: "tails" }), TAILS_EVERY_MS);
    return () => clearInterval(timer);
  }, [view, visible]);
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
    root.toggleAttribute("data-frosted", !!look.frosted);
  }, [look]);
  const locale = look?.locale ?? state?.locale ?? "en";
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const picture = useTerminalPicture(look);

  // The window's keys, taken before a terminal hears them, so they never reach the shell; what they do is read from the latest render.
  const onWindowKey = useRef<(key: WindowKey) => void>(() => undefined);
  // Each cell's handlers, made once and reading the latest render: a cell then redraws only when what it shows changes.
  const cellActs = useRef<CellActs | null>(null);
  const cellHandlers = useRef(new Map<string, CellHandlers>());
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // the app's key for this window, pressed in it: it is already in front, so the shell never hears it
      if (hits(e, "terminalWindow")) {
        e.preventDefault();
        e.stopPropagation();
        window.focus();
        return;
      }
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const anyWords = useMemo(() => wordsIn(locale), [locale, words]);
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
  const shown: Look = useMemo(() => ({ ...(look ?? { theme: "", dark: false, tokens: {}, locale }), clear: !!look?.frosted || !!picture }), [look, locale, picture]);

  // The selected cell's row comes into view in the list.
  const side = useRef<HTMLElement>(null);
  const selectedId = laid ? selectedCell(leaves(laid), focused).sessionId : null;
  useEffect(() => {
    side.current?.querySelector('.cs-row[aria-current="true"], .cs-dot[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (!state || !laid) return null;
  const key = paneKey(state);
  // Drawn handed over already, before the effect saves it: a cell whose ticket just finished keeps its terminal attached.
  const layout = carryOn(laid, carriedOf(state, toRead.current), key);
  const cells = leaves(layout);
  const target = selectedCell(cells, focused);
  // A session picked from History into a cell is known by that pick until the next state carries it.
  const byId = new Map([...picked.sessions, ...state.sessions.map((s) => [s.id, s] as const)]);
  const terminalsById = new Map(state.terminals.map((t) => [t.id, t]));
  // A closed terminal picked from History to play back, likewise.
  const closedById = new Map([...picked.terminals, ...state.closedTerminals.map((t) => [t.id, t] as const)]);
  // A terminal whose agent claimed a ticket shows that session in its own cell, on the pane it already has.
  const sessionIn = (id: string | null) => (id ? byId.get(terminalsById.get(id)?.sessionId ?? id) : undefined);
  const rowsOf = (c: Leaf) => (c.sessionId ? [c.sessionId, terminalsById.get(c.sessionId)?.sessionId ?? c.sessionId] : []);
  // Every cell's row reads as shown; the selected cell's alone as current.
  const active = new Set(cells.flatMap(rowsOf));
  // Each cell's number, as its bar says it, for the rows it shows.
  const cellNumbers = new Map(cells.flatMap((c, i) => rowsOf(c).map((id) => [id, i + 1] as const)));
  // What is still going, as the assistant panel's bar reads it: the bar shows only this, the overview unless asked for all.
  const listedAt = Date.now();
  const going = activeRows(rows, active, listedAt);
  // The overview's active view is what is still going: the bar's last few to end are not.
  const goingNow = activeRows(rows, active, listedAt, { ended: false });
  const overviewAll = overviewAllHere ?? state.overviewAll;
  const scope = { all: overviewAll, active: goingNow.here.length + goingNow.away.length, total: rows.here.length + rows.away.length, onAll: (all: boolean) => { setOverviewAllHere(all); send({ type: "overviewAll", all }); } };
  const shownInOverview = overviewAll ? rows : goingNow;
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
    return t ? (t.agentTitle ?? t.title) : (closedById.get(id)?.title ?? id);
  };
  // Shown where `landing` says: never a second controller on the same pane, never over a locked cell or one that needs
  // you. Whatever left a pane is said, with a way back.
  const land = (id: string, beside: boolean) => {
    // Picked over the overview: back to the cells, to see it in its own.
    setView("grid");
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
    if (s.mode === "run" && !s.pane) return send({ type: "openThread", sessionId: s.id });
    if (!live(s)) {
      toRead.current.add(s.id);
      setPicked((p) => (p.sessions.has(s.id) ? p : { ...p, sessions: new Map(p.sessions).set(s.id, s) }));
    }
    land(s.id, beside);
  };
  // A closed terminal from History: its recording, read in a cell like an ended session.
  const pickClosed = (t: ClosedTerminalRow) => {
    toRead.current.add(t.id);
    setPicked((p) => (p.terminals.has(t.id) ? p : { ...p, terminals: new Map(p.terminals).set(t.id, t) }));
    land(t.id, false);
  };
  // An assistant conversation has no pane here: the app window shows it.
  const showThread = (t: ThreadRow) => send({ type: "showThread", threadId: t.id });
  const answer = (s: SessionRow, which: "allow" | "deny") => answerSession(s.id, which);
  const answerThread = (t: ThreadRow, questionId: string, value: string) => answerThreadAsk(t.id, questionId, value);
  // The overview is drawn over the cells, so the keyboard leaves whatever terminal held it.
  const openOverview = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    setView("overview");
  };
  // "See in a pane": back to the cells, with it in one, selected.
  const seeInPane = (r: HereRow) => {
    setView("grid");
    if (r.kind === "terminal") pickTerminal(r.terminal);
    else if (r.session) pick(r.session);
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
    const clipboard = clipboardOf(node.id);
    const hint = (chords: string[]) => (chords[0] ? formatChord(chords[0]) : undefined);
    return (
      <>
        <ContextMenuActionItem icon={null} name={say("copy")} hint={hint(keymap.terminalCopy)} disabled={!clipboard?.canCopy()} onSelect={() => clipboard?.copy()} />
        <ContextMenuActionItem icon={null} name={say("paste")} hint={hint(keymap.terminalPaste)} disabled={!clipboard} onSelect={() => clipboard?.paste()} />
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
        <ContextMenuActionItem icon={null} name={say("splitRight")} hint={keyLabel("splitRight")} onSelect={() => select(splitCell(node.id, "row"))} />
        <ContextMenuActionItem icon={null} name={say("splitDown")} hint={keyLabel("splitDown")} onSelect={() => select(splitCell(node.id, "column"))} />
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
  const openTerminal = (base: Layout, cell: string, cwd: string | null, resume?: string, from?: string) => {
    if (outside) return cwd ? send({ type: "openOutside", cwd }) : undefined;
    const terminalId = crypto.randomUUID();
    asked.current.set(terminalId, Date.now());
    change(show(base, cell, terminalId));
    setFocused(cell);
    send({ type: "newTerminal", terminalId, cwd, ...(resume ? { resume } : {}), ...(from ? { from } : {}) });
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
  // The folder a cell works in: its terminal's, its session's worktree, a closed terminal's; the project's for an empty one.
  const folderOf = (id: string | null): string => {
    const s = sessionIn(id);
    return (id ? terminalsById.get(id)?.cwd : undefined) ?? (s ? (s.worktree ?? s.cwd) : null) ?? (id ? closedById.get(id)?.cwd : undefined) ?? state.places[0]!.cwd;
  };
  // Split as iTerm does: the new half is a plain shell in the folder of the cell it came from, never asking for an agent.
  // With nothing to open one in, it stays empty.
  const splitCell = (cell: string, direction: "row" | "column") => {
    setView("grid");
    const next = split(layout, cell, direction);
    if (!ready) {
      change(next.layout);
      return next.created;
    }
    const from = cells.find((c) => c.id === cell)?.sessionId ?? null;
    openTerminal(next.layout, next.created, folderOf(from), undefined, (from ? (sessionIn(from)?.pane ?? terminalsById.get(from)?.pane) : null) ?? undefined);
    return next.created;
  };
  const leafOf = (cell: string) => cells.find((c) => c.id === cell);
  cellActs.current = {
    newTerminal: (cell, cwd) => openTerminal(layout, cell, cwd),
    talk: (cell, s) => openTerminal(layout, cell, s.cwd ?? s.worktree, s.id),
    focus: (cell) => setFocused(cell),
    lock: (cell) => {
      const leaf = leafOf(cell);
      if (leaf) change(lock(layout, cell, !leaf.locked));
    },
    split: (cell, direction) => setFocused(splitCell(cell, direction)),
    close: (cell) => change(close(layout, cell)),
    menu: (cell) => {
      const leaf = leafOf(cell);
      return leaf ? cellMenu(leaf) : null;
    }
  };
  for (const id of cellHandlers.current.keys()) if (!leafOf(id)) cellHandlers.current.delete(id);
  const handlersOf = (cell: string): CellHandlers => {
    let made = cellHandlers.current.get(cell);
    if (!made) {
      const acts = () => cellActs.current!;
      made = {
        onNewTerminal: (cwd) => acts().newTerminal(cell, cwd),
        onTalk: (s) => acts().talk(cell, s),
        onFocus: () => acts().focus(cell),
        onLock: () => acts().lock(cell),
        onSplit: (direction) => acts().split(cell, direction),
        onClose: () => acts().close(cell),
        menu: <CellMenu cell={cell} acts={cellActs} />
      };
      cellHandlers.current.set(cell, made);
    }
    return made;
  };
  onWindowKey.current = (key) => {
    // over the palette, the window's keys wait: ⌘K again closes it
    if (paletteOpen) return key === "palette" ? setPaletteOpen(false) : undefined;
    if (key === "palette") return setPaletteOpen(true);
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

  // ⌘K's history: the ended sessions cells show and the ones panes ran before, newest first.
  const ended = [...new Map([...state.sessions.filter((s) => !live(s)), ...Object.values(state.history).flat()].map((s) => [s.id, s])).values()]
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 30);
  const paletteActions: PaletteAction[] = [
    ...(canOpen ? [{ id: "new", label: say("newTerminal"), run: newTerminal }] : []),
    // as ⌘D does: an empty cell beside the selected one, selected
    { id: "split", label: say("paletteSplitRight"), kb: keyLabel("splitRight"), run: () => select(splitCell(target.id, "row")) },
    view === "grid" ? { id: "overview", label: say("viewOverview"), run: openOverview } : { id: "grid", label: say("viewGrid"), run: () => setView("grid") },
    { id: "fold", label: say(folded ? "unfold" : "fold"), kb: keyLabel("fold"), run: toggleFold },
    // a Mac terminal's ⌘K: here the shell or agent in the selected cell clears its screen (Ctrl+L)
    ...(target.sessionId ? [{ id: "clear", label: say("paletteClear"), run: () => send({ type: "input", cell: target.id, data: "\f" }) }] : []),
    ...state.presets.map((p) => ({ id: `layout:${p.id}`, label: say("paletteLayout", { name: p.name }), run: () => { change(applyPreset(layout, p.layout, undefined, key)); setFocused(null); } }))
  ];
  const paletteRow = (r: HereRow) => (r.kind === "thread" ? showThread(r.thread) : seeInPane(r));
  // The cell a row is in, numbered as the cells' heads number them.
  const cellOf = (r: HereRow): number | null => {
    const at = cells.findIndex((c) => !!c.sessionId && (c.sessionId === r.id || (!!r.session && rowsOf(c).includes(r.session.id))));
    return at < 0 ? null : at + 1;
  };

  const render = (node: Layout): ReactNode =>
    node.type === "split" ? (
      <Split key={node.id} node={node} render={render} onRatio={(id, ratio) => change(resize(layout, id, ratio))} />
    ) : (
      <Cell
        key={node.id}
        leaf={node}
        number={cells.indexOf(node) + 1}
        pane={node.sessionId ? key(node.sessionId) : ""}
        herdrClient={state.herdrClient}
        session={sessionIn(node.sessionId)}
        terminal={node.sessionId ? terminalsById.get(node.sessionId) : undefined}
        closed={node.sessionId ? closedById.get(node.sessionId) : undefined}
        places={state.places}
        ready={canOpen}
        focused={node.id === target.id && cells.length > 1}
        flash={flash?.cell === node.id ? flash.at : null}
        selected={node.id === target.id}
        only={cells.length === 1}
        {...handlersOf(node.id)}
        look={shown}
      />
    );

  return (
    <SayContext.Provider value={say}><GuessContext.Provider value={guesses}>
      <WordsContext.Provider value={anyWords}>
      <div className="cs-window">
        <IconSprite />
        <div className="cs-topbar">
          <span className="cs-project" data-testid="cs-project" title={say("projectTitle", { project: state.projectName })}>
            {state.projectName}
          </span>
          <div className="cs-top-actions" data-testid="cs-top-actions">
            <button type="button" className="btn btn-ghost btn-xs" data-testid="cs-top-split-right" aria-label={say("topSplitRight")} title={say("withKey", { action: say("splitRight"), key: keyLabel("splitRight") })} onClick={() => select(splitCell(target.id, "row"))}>
              <Icon className="ico" name="i-split" size={13} />
              <span className="cs-top-word">{say("topSplitRight")}</span>
              <kbd className="cs-top-word">{keyLabel("splitRight")}</kbd>
            </button>
            <button type="button" className="btn btn-ghost btn-xs" data-testid="cs-top-split-down" aria-label={say("topSplitDown")} title={say("withKey", { action: say("splitDown"), key: keyLabel("splitDown") })} onClick={() => select(splitCell(target.id, "column"))}>
              <Icon className="ico cs-ico-down" name="i-split" size={13} />
              <span className="cs-top-word">{say("topSplitDown")}</span>
              <kbd className="cs-top-word">{keyLabel("splitDown")}</kbd>
            </button>
            <button type="button" className="btn btn-ghost btn-xs" data-testid="cs-top-palette" aria-label={say("topPalette")} title={say("withKey", { action: say("topPalette"), key: keyLabel("palette") })} onClick={() => setPaletteOpen(true)}>
              <Icon className="ico" name="i-search" size={13} />
              <kbd className="cs-top-word">{keyLabel("palette")}</kbd>
              <span className="cs-top-word">{say("topPalette")}</span>
            </button>
          </div>
          <div className="seg quiet cs-views" role="group" aria-label={say("viewToggle")} data-testid="cs-views">
            <button type="button" aria-pressed={view === "grid"} data-testid="cs-view-grid" onClick={() => setView("grid")}>
              <Icon className="ico" name="i-grid" size={13} />
              {say("viewGrid")}
            </button>
            <button type="button" aria-pressed={view === "overview"} data-testid="cs-view-overview" onClick={openOverview}>
              <Icon className="ico" name="i-cards" size={13} />
              {say("viewOverview")}
            </button>
          </div>
          <button type="button" className="btn btn-ghost btn-xs" data-testid="cs-top-main" aria-label={say("topMainWindow")} title={say("topMainWindowHint")} onClick={() => send({ type: "mainWindow" })}>
            <Icon className="ico" name="i-monitor" size={13} />
            <span className="cs-top-word">{say("topMainWindow")}</span>
          </button>
        </div>
        <div className="cs-body">
          <main className="cs-main">
            <Banner state={state} />
            <div className="cs-layout">{render(layout)}</div>
            {view === "overview" && <Overview rows={[...shownInOverview.here, ...shownInOverview.away.map((s): HereRow => ({ kind: "session", id: s.id, session: s }))]} scope={scope} tails={tails} active={active} cells={cellNumbers} onSee={seeInPane} onThread={showThread} onAnswer={answer} onAnswerThread={answerThread} />}
          </main>
          <Sidebar
            ref={side}
            state={state}
            rows={going}
            locale={locale}
            folded={folded}
            onFold={toggleFold}
            marks={{ active, selected, cells: cellNumbers, shownPanes, selectedPane, pane: key }}
            canOpen={canOpen}
            onPick={pick}
            onTerminal={pickTerminal}
            onClosed={pickClosed}
            onThread={showThread}
            onAnswer={answer}
            onAnswerThread={answerThread}
            onNewTerminal={newTerminal}
            onApplyPreset={(p) => {
              change(applyPreset(layout, p.layout, undefined, key));
              setFocused(null);
            }}
            onSavePreset={(name) => send({ type: "savePreset", name, layout })}
            onDeletePreset={(preset) => {
              const at = state.presets.findIndex((p) => p.id === preset.id);
              const isDefault = state.defaultPreset === preset.id;
              send({ type: "deletePreset", id: preset.id });
              setToast({ text: say("layoutDeleted", { name: preset.name }), action: { label: say("undo"), run: () => send({ type: "restorePreset", preset, at: Math.max(0, at), isDefault }) } });
            }}
          />
        </div>
        <KeysFooter />
        <Palette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          here={rows.here}
          away={rows.away}
          ended={ended}
          actions={paletteActions}
          tickets={canOpen ? state.tickets : []}
          startAgent={state.startAgent}
          cellOf={cellOf}
          onRow={paletteRow}
          onAway={(s) => send({ type: "openThread", sessionId: s.id })}
          onStartTicket={(ticket) => send({ type: "startTicket", itemId: ticket.id })}
        />
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
      </WordsContext.Provider>
    </GuessContext.Provider></SayContext.Provider>
  );
}

const PICTURE_VARS = ["--backdrop-image", "--backdrop-shell", "--backdrop-pane", "--backdrop-tile", "--backdrop-float"];
/**
 * The picture a custom theme puts behind this window, painted under translucent panes the way the
 * main window paints its own; null when the theme has none for it, or this machine lacks it.
 */
function useTerminalPicture(look: Look | null): string | null {
  const [picture, setPicture] = useState<{ theme: string; url: string } | null>(null);
  const themeId = look?.backdrop?.terminalVeil !== undefined ? look.theme : null;
  useEffect(() => {
    if (!themeId) return setPicture(null);
    let url: string | null = null, gone = false;
    void terminalPicture(themeId).then(image => {
      if (gone) return;
      if (!image) return setPicture(null);
      url = URL.createObjectURL(new Blob([Uint8Array.from(atob(image.base64), char => char.charCodeAt(0))], { type: image.mime }));
      setPicture({ theme: themeId, url });
    });
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [themeId]);
  const shown = useFrosted(picture && picture.theme === themeId ? picture.url : null, look?.backdrop?.frost ?? 0);
  const veil = look?.backdrop?.terminalVeil, bg = look?.tokens["--bg"], surface = look?.tokens["--surface"];
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("cs-backdrop", !!shown);
    for (const name of PICTURE_VARS) root.style.removeProperty(name);
    if (!shown || veil === undefined || !bg || !surface) return;
    root.style.setProperty("--backdrop-image", `url("${shown}")`);
    for (const [name, value] of Object.entries(backdropFills({ bg, surface }, veil))) root.style.setProperty(`--${name}`, value);
  }, [shown, veil, bg, surface]);
  return shown;
}
