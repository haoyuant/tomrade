import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { WindowPost } from "@tomradex/code-sessions";
import { onCell, pathForFile, send } from "./bridge";

/** Where a pane's view is in herdr's scrollback, in rows. */
type PaneScroll = Omit<Extract<WindowPost, { type: "scrolled" }>, "type" | "cell">;

/**
 * A CSS colour as xterm takes it (#rrggbb): the page resolves var(), oklch() and color-mix(),
 * a canvas pixel turns the result into sRGB.
 */
function hex(css: string, probe: HTMLElement, pixel: CanvasRenderingContext2D): string {
  probe.style.color = css;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = getComputedStyle(probe).color;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The terminal's colours from the theme on this page — the app's look once it has arrived, Tomrade's
 * default before — the ANSI palette included, so programs' colours read on light and dark themes alike.
 */
export function terminalTheme(): ITheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const pixel = canvas.getContext("2d", { willReadFrequently: true })!;
  const c = (css: string) => hex(css, probe, pixel);
  const background = c("var(--surface)");
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));
  const dark = 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 128;
  // Bright colours lean toward the text colour: darker on a light theme, lighter on a dark one.
  const bright = (css: string) => c(`color-mix(in oklch, ${css} 72%, var(--fg))`);
  const magenta = "color-mix(in oklch, var(--danger) 50%, var(--accent))";
  const cyan = "color-mix(in oklch, var(--success) 50%, var(--accent))";
  const theme: ITheme = {
    background,
    foreground: c("var(--fg)"),
    cursor: c("var(--accent)"),
    cursorAccent: background,
    selectionBackground: c("color-mix(in oklch, var(--accent) 22%, var(--surface))"),
    black: c(dark ? "var(--border-input)" : "var(--fg)"),
    brightBlack: c("var(--meta)"),
    red: c("var(--danger)"),
    brightRed: bright("var(--danger)"),
    green: c("var(--success)"),
    brightGreen: bright("var(--success)"),
    yellow: c("var(--warn)"),
    brightYellow: bright("var(--warn)"),
    blue: c("var(--accent)"),
    brightBlue: bright("var(--accent)"),
    magenta: c(magenta),
    brightMagenta: bright(magenta),
    cyan: c(cyan),
    brightCyan: bright(cyan),
    white: c(dark ? "var(--muted)" : "var(--meta)"),
    brightWhite: c(dark ? "var(--fg)" : "var(--muted)")
  };
  probe.remove();
  return theme;
}

const BUTTONS = ["left", "middle", "right"] as const;

/** How long the scrollbar stays after the view stops moving. */
const SCROLLBAR_HIDE_MS = 1_000;
const THUMB_MIN_PX = 24;

/**
 * herdr's scrollback as an overlay bar on the pane's right edge, taking no width from the grid: shown while the view
 * moves, the pointer is on it or it is dragged, and faded out a second after. Dragging the thumb, or pressing the
 * track, puts the view there.
 */
function PaneScrollbar({ scroll, onScrollTo, onWheel }: { scroll: PaneScroll | null; onScrollTo: (offset: number) => void; onWheel: (deltaY: number) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [moved, setMoved] = useState(false);
  // While dragging, the place asked for: the thumb follows the pointer ahead of herdr's answer.
  const [asked, setAsked] = useState<number | null>(null);
  const grab = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  const seen = useRef<number | undefined>(undefined);
  const offset = scroll?.offset;

  useEffect(() => {
    const first = seen.current === undefined;
    if (offset === undefined || offset === seen.current) return;
    seen.current = offset;
    if (grab.current === null) setAsked(null);
    // The place it attached at is not a move.
    if (first) return;
    setMoved(true);
    const timer = setTimeout(() => setMoved(false), SCROLLBAR_HIDE_MS);
    return () => clearTimeout(timer);
  }, [offset]);

  if (!scroll || scroll.max <= 0) return null;
  const { max, rows } = scroll;
  const share = rows / (max + rows);
  const at = 1 - (asked ?? scroll.offset) / max;

  const offsetAt = (clientY: number, held: number) => {
    const box = track.current!.getBoundingClientRect();
    const room = box.height - Math.max(THUMB_MIN_PX, box.height * share);
    if (room <= 0) return scroll.offset;
    return Math.round((1 - Math.min(1, Math.max(0, (clientY - box.top - held) / room))) * max);
  };
  // At most one ask to herdr a frame, the latest place.
  const ask = (next: number) => {
    setAsked(next);
    if (pending.current === null)
      setTimeout(() => {
        if (pending.current !== null) onScrollTo(pending.current);
        pending.current = null;
      }, 16);
    pending.current = next;
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const thumb = (e.target as HTMLElement).closest(".cs-scrollbar-thumb");
    const box = track.current!.getBoundingClientRect();
    grab.current = thumb ? e.clientY - thumb.getBoundingClientRect().top : Math.max(THUMB_MIN_PX, box.height * share) / 2;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!thumb) ask(offsetAt(e.clientY, grab.current));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (grab.current !== null) ask(offsetAt(e.clientY, grab.current));
  };
  const up = () => {
    grab.current = null;
    setMoved(true);
    setTimeout(() => setMoved(false), SCROLLBAR_HIDE_MS);
  };

  return (
    <div ref={track} className="cs-scrollbar" data-shown={moved || grab.current !== null || undefined} data-held={grab.current !== null || undefined} style={{ "--thumb": `max(${THUMB_MIN_PX}px, ${share * 100}%)`, "--at": at } as CSSProperties} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={(e) => onWheel(e.deltaY)}>
      <div className="cs-scrollbar-thumb" />
    </div>
  );
}

/**
 * One session's terminal: herdr's frames painted into xterm, keys and pastes sent back as input,
 * the wheel and Page Up/Down as scrolls (herdr keeps the scrollback; xterm keeps none, since every
 * frame repaints the viewport), clicks as mouse events, files dropped on it as their paths, and the
 * size following the cell.
 */
export function TerminalCell({ cell, sessionId, pane, tokens, font, labels, autoFocus }: { cell: string; sessionId: string; pane: string; tokens: Record<string, string>; font: string; labels: { detached: (reason: string | null) => string; reattach: string; drop: string }; autoFocus: boolean }) {
  // Another ticket the same agent works in this pane is the same terminal: only another pane attaches again.
  const attachAs = useRef(sessionId);
  attachAs.current = sessionId;
  // Only the selected cell takes focus when it attaches: focus selects a cell, so another one attaching must not.
  const focusOnAttach = useRef(autoFocus);
  focusOnAttach.current = autoFocus;
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [closed, setClosed] = useState<string | null | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [scroll, setScroll] = useState<PaneScroll | null>(null);
  const wheel = (deltaY: number) => send({ type: "scroll", cell, direction: deltaY < 0 ? "up" : "down", lines: Math.max(1, Math.round(Math.abs(deltaY) / 40)) });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // A link (OSC 8) opens in the system browser; xterm's own asks with confirm() and then opens an app window.
    const linkHandler = { activate: (_e: MouseEvent, url: string) => send({ type: "openLink", url }) };
    const terminal = new Terminal({ scrollback: 0, cursorBlink: false, fontFamily: font || "ui-monospace, Menlo, monospace", fontSize: 13, allowProposedApi: false, theme: terminalTheme(), linkHandler });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(el);
    term.current = terminal;
    try {
      fit.fit();
    } catch {
      // not laid out yet; the observer fits it once it is
    }
    setClosed(undefined);
    setScroll(null);
    const off = onCell(cell, (post) => {
      if (post.type === "frame") terminal.write(post.bytes);
      else if (post.type === "scrolled") setScroll({ offset: post.offset, max: post.max, rows: post.rows });
      else if (post.type === "reattach") setAttempt((n) => n + 1);
      else if (post.type === "closed") setClosed(post.reason);
    });
    send({ type: "attach", cell, sessionId: attachAs.current, cols: terminal.cols, rows: terminal.rows });
    const input = terminal.onData((data) => send({ type: "input", cell, data }));
    const sized = terminal.onResize(({ cols, rows }) => send({ type: "resize", cell, cols, rows }));
    terminal.attachCustomWheelEventHandler((e) => {
      wheel(e.deltaY);
      return false;
    });
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "PageUp" && e.key !== "PageDown")) return true;
      send({ type: "scroll", cell, direction: e.key === "PageUp" ? "up" : "down", lines: Math.max(1, terminal.rows - 1) });
      return false;
    });
    // Clicks at a cell, for apps that asked for the mouse; herdr drops them for the rest.
    const at = (e: MouseEvent) => {
      const box = (el.querySelector(".xterm-screen") ?? el).getBoundingClientRect();
      return { column: Math.min(terminal.cols - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * terminal.cols))), row: Math.min(terminal.rows - 1, Math.max(0, Math.floor(((e.clientY - box.top) / box.height) * terminal.rows))) };
    };
    const mouse = (action: "down" | "up") => (e: MouseEvent) => send({ type: "mouse", cell, action, button: BUTTONS[e.button] ?? "left", ...at(e) });
    const down = mouse("down");
    const up = mouse("up");
    el.addEventListener("mousedown", down);
    el.addEventListener("mouseup", up);
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // hidden for a moment
      }
    });
    observer.observe(el);
    if (focusOnAttach.current) terminal.focus();
    return () => {
      observer.disconnect();
      el.removeEventListener("mousedown", down);
      el.removeEventListener("mouseup", up);
      input.dispose();
      sized.dispose();
      off();
      send({ type: "detach", cell });
      terminal.dispose();
      term.current = null;
    };
    // Tokens and font change the look only; the effect below repaints without reattaching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell, pane, attempt]);

  // The window writes the look's variables in its own effect, after this one: read them a frame later.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = terminalTheme();
    });
    return () => cancelAnimationFrame(frame);
  }, [tokens]);

  const takesFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const over = (e: DragEvent) => {
    if (!takesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const leave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  };
  const drop = (e: DragEvent) => {
    if (!takesFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    const paths = [...e.dataTransfer.files].map(pathForFile).filter(Boolean);
    if (paths.length) send({ type: "drop", cell, paths });
    term.current?.focus();
  };

  return (
    <div className="cs-term" onDragEnter={over} onDragOver={over} onDragLeave={leave} onDrop={drop}>
      <div ref={host} className="cs-term-host" />
      <PaneScrollbar scroll={closed === undefined ? scroll : null} onScrollTo={(offset) => send({ type: "scrollTo", cell, offset })} onWheel={wheel} />
      {dragging && <div className="cs-term-drop">{labels.drop}</div>}
      {closed !== undefined && (
        <div className="cs-term-closed">
          <span>{labels.detached(closed)}</span>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => setAttempt((n) => n + 1)}>
            {labels.reattach}
          </button>
        </div>
      )}
    </div>
  );
}
