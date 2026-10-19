import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onCell, send } from "./bridge";

/** The xterm colours from the app's theme variables. */
export function terminalTheme(tokens: Record<string, string>): ITheme {
  const t = (name: string, fallback: string) => tokens[`--${name}`] || fallback;
  return { background: t("surface", "#1e1e1e"), foreground: t("fg", "#e6e6e6"), cursor: t("accent", "#e6e6e6"), cursorAccent: t("surface", "#1e1e1e"), selectionBackground: t("accent-light", "#44475a") };
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
    const terminal = new Terminal({ scrollback: 0, cursorBlink: false, fontFamily: font || "ui-monospace, Menlo, monospace", fontSize: 13, allowProposedApi: false, theme: terminalTheme(tokens) });
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

  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme(tokens);
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
