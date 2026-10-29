import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import "@xterm/xterm/css/xterm.css";
import type { WindowPost } from "@tomradex/code-sessions";
import { seeThrough, terminalTheme } from "~/lib/xtermTheme";
import { onCell, pathForFile, send } from "./bridge";
import { followSelection } from "./selection";
import { fileLinks } from "./fileLinks";
import { modifiedEnter } from "./keys";
import { frameBatch } from "./frames";

/** Every cell's fit, once a frame and together. */
const fits = frameBatch();

/** A pane out of sight this long gives its context back; scrolling past it and back keeps it. */
const WEBGL_RELEASE_MS = 2_000;
/** After the browser takes a context back (it keeps only so many), when to ask again, and how often. */
const WEBGL_RETRY_MS = 3_000;
const WEBGL_RETRIES = 3;

/**
 * Draws on the GPU: every cell shares the window's one thread, and the DOM renderer restyles each row on every paint.
 * The browser keeps only so many contexts, so a pane out of sight (folded, scrolled away) gives its own back for the
 * ones on screen, and one the browser took is asked for again rather than left on the DOM renderer for good. A
 * minimized window keeps them: Chromium already frees its surfaces. Without WebGL2 the DOM renderer carries on.
 */
function drawWithWebgl(terminal: Terminal, el: HTMLElement): { dispose: () => void } {
  let webgl: WebglAddon | null = null;
  let onScreen = false;
  let unavailable = false;
  let losses = 0;
  let release: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const drop = () => {
    webgl?.dispose();
    webgl = null;
  };
  const take = () => {
    if (webgl || unavailable || !onScreen) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        if (webgl === addon) drop();
        if (++losses <= WEBGL_RETRIES) retry = setTimeout(take, WEBGL_RETRY_MS * losses);
      });
      terminal.loadAddon(addon);
      webgl = addon;
    } catch {
      unavailable = true; // no WebGL2 here
    }
  };
  const sight = new IntersectionObserver((entries) => {
    onScreen = entries.at(-1)?.isIntersecting ?? onScreen;
    clearTimeout(release);
    if (onScreen) {
      // Back in sight: a context the browser took meanwhile may be asked for anew.
      losses = 0;
      take();
    } else if (webgl) release = setTimeout(drop, WEBGL_RELEASE_MS);
  });
  sight.observe(el);
  return {
    dispose: () => {
      sight.disconnect();
      clearTimeout(release);
      clearTimeout(retry);
      drop();
    }
  };
}

/** Where a pane's view is in herdr's scrollback, in rows. */
type PaneScroll = Omit<Extract<WindowPost, { type: "scrolled" }>, "type" | "cell">;

export { terminalTheme };

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
  // Mouse-reporting apps such as Codex ignore wheels at the default (0,0) header.
  // The overlay scrollbar sits outside the grid, so its wheels target the body centre.
  const wheel = (deltaY: number, position = { column: Math.floor((term.current?.cols ?? 1) / 2), row: Math.floor((term.current?.rows ?? 1) / 2) }) => {
    if (deltaY === 0) return;
    send({ type: "scroll", cell, direction: deltaY < 0 ? "up" : "down", lines: 2 * Math.max(1, Math.round(Math.abs(deltaY) / 40)), ...position });
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // Both plain URLs and OSC 8 links use the system browser rather than an app window.
    const linkHandler = {
      allowNonHttpProtocols: true,
      activate: (_e: MouseEvent, url: string) => {
        if (!terminal.hasSelection()) send({ type: "openLink", url });
      }
    };
    const clear = seeThrough();
    const terminal = new Terminal({ scrollback: 0, cursorBlink: false, fontFamily: font || "ui-monospace, Menlo, monospace", fontSize: 13, allowProposedApi: false, allowTransparency: clear, theme: terminalTheme(clear), linkHandler });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon(linkHandler.activate));
    // For the recording: the screen as it stands, when a new stretch of it needs one to begin with.
    const serialize = new SerializeAddon();
    terminal.loadAddon(serialize);
    terminal.open(el);
    const gpu = drawWithWebgl(terminal, el);
    const localLinks = fileLinks(terminal, linkHandler.activate);
    term.current = terminal;
    try {
      fit.fit();
    } catch {
      // not laid out yet; the observer fits it once it is
    }
    setClosed(undefined);
    setScroll(null);
    const selection = followSelection(terminal, el);
    // The last frame handed to xterm; a snapshot says it is of the screen as of this one.
    let seq = 0;
    const off = onCell(cell, (post) => {
      if (post.type === "frame") {
        seq = post.seq;
        terminal.write(post.bytes);
      } else if (post.type === "scrolled") {
        setScroll({ offset: post.offset, max: post.max, rows: post.rows });
      } else if (post.type === "reattach") setAttempt((n) => n + 1);
      else if (post.type === "closed") setClosed(post.reason);
      else if (post.type === "snapshot") {
        // Taken once every frame before it is on the screen: xterm draws what it was given in order.
        const asOf = seq;
        terminal.write("", () => send({ type: "snapshot", cell, token: post.token, seq: asOf, width: terminal.cols, height: terminal.rows, bytes: new TextEncoder().encode(serialize.serialize({ excludeModes: true, excludeAltBuffer: true })) }));
      }
    });
    send({ type: "attach", cell, sessionId: attachAs.current, cols: terminal.cols, rows: terminal.rows });
    const input = terminal.onData((data) => send({ type: "input", cell, data }));
    const sized = terminal.onResize(({ cols, rows }) => send({ type: "resize", cell, cols, rows }));
    terminal.attachCustomWheelEventHandler((e) => {
      wheel(e.deltaY, at(e));
      return false;
    });
    terminal.attachCustomKeyEventHandler((e) => {
      const enter = modifiedEnter(e);
      if (enter) {
        // Its keypress would type a plain Enter too.
        if (e.type === "keydown") {
          e.preventDefault();
          send({ type: "key", cell, key: enter });
        }
        return false;
      }
      if (e.type !== "keydown" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "PageUp" && e.key !== "PageDown")) return true;
      send({ type: "scroll", cell, source: "page_key", direction: e.key === "PageUp" ? "up" : "down", lines: Math.max(1, terminal.rows - 1) });
      return false;
    });
    // Pointer coordinates in terminal cells, clamped to the grid for mouse-reporting apps.
    const at = (e: MouseEvent) => {
      const box = (el.querySelector(".xterm-screen") ?? el).getBoundingClientRect();
      return { column: Math.min(terminal.cols - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * terminal.cols))), row: Math.min(terminal.rows - 1, Math.max(0, Math.floor(((e.clientY - box.top) / box.height) * terminal.rows))) };
    };
    const mouse = (action: "down" | "up") => (e: MouseEvent) => send({ type: "mouse", cell, action, button: BUTTONS[e.button] ?? "left", ...at(e) });
    const down = mouse("down");
    const up = mouse("up");
    el.addEventListener("mousedown", down);
    el.addEventListener("mouseup", up);
    // A size that comes out the same grid is no resize: nothing goes to the pane, and xterm is not cleared.
    const refit = () => {
      try {
        const dims = fit.proposeDimensions();
        if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows) && (dims.cols !== terminal.cols || dims.rows !== terminal.rows)) fit.fit();
      } catch {
        // hidden for a moment
      }
    };
    const observer = new ResizeObserver(() => fits.soon(refit));
    observer.observe(el);
    if (focusOnAttach.current) terminal.focus();
    return () => {
      observer.disconnect();
      fits.cancel(refit);
      selection.dispose();
      localLinks.dispose();
      el.removeEventListener("mousedown", down);
      el.removeEventListener("mouseup", up);
      input.dispose();
      sized.dispose();
      off();
      send({ type: "detach", cell });
      gpu.dispose();
      terminal.dispose();
      term.current = null;
    };
    // Tokens and font change the look only; the effect below repaints without reattaching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell, pane, attempt]);

  // The window writes the look's variables in its own effect, after this one: read them a frame later.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!term.current) return;
      // Frosted, the grid lets the window's material through; a solid theme draws it opaque again, the cheaper way.
      const clear = seeThrough();
      term.current.options.allowTransparency = clear;
      term.current.options.theme = terminalTheme(clear);
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
