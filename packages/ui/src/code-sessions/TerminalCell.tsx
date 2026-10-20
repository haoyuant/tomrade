import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onCell, send } from "./bridge";

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

/**
 * One session's terminal: herdr's frames painted into xterm, keys and pastes sent back as input,
 * the wheel and Page Up/Down as scrolls (herdr keeps the scrollback; xterm keeps none, since every
 * frame repaints the viewport), clicks as mouse events, and the size following the cell.
 */
export function TerminalCell({ cell, sessionId, tokens, font, labels }: { cell: string; sessionId: string; tokens: Record<string, string>; font: string; labels: { detached: (reason: string | null) => string; reattach: string } }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [closed, setClosed] = useState<string | null | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const terminal = new Terminal({ scrollback: 0, cursorBlink: false, fontFamily: font || "ui-monospace, Menlo, monospace", fontSize: 13, allowProposedApi: false, theme: terminalTheme() });
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
    const off = onCell(cell, (post) => {
      if (post.type === "frame") terminal.write(post.bytes);
      else if (post.type === "reattach") setAttempt((n) => n + 1);
      else setClosed(post.reason);
    });
    send({ type: "attach", cell, sessionId, cols: terminal.cols, rows: terminal.rows });
    const input = terminal.onData((data) => send({ type: "input", cell, data }));
    const sized = terminal.onResize(({ cols, rows }) => send({ type: "resize", cell, cols, rows }));
    terminal.attachCustomWheelEventHandler((e) => {
      const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 40));
      send({ type: "scroll", cell, direction: e.deltaY < 0 ? "up" : "down", lines });
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
    terminal.focus();
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
  }, [cell, sessionId, attempt]);

  // The window writes the look's variables in its own effect, after this one: read them a frame later.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = terminalTheme();
    });
    return () => cancelAnimationFrame(frame);
  }, [tokens]);

  return (
    <div className="cs-term">
      <div ref={host} className="cs-term-host" />
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
