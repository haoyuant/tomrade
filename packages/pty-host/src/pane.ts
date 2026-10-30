import { createRequire } from "node:module";
import type { IBufferCell, Terminal as HeadlessTerminal } from "@xterm/headless";
import type { TerminalFrame, TerminalMode, TerminalMouse, TerminalScroll } from "@tomradex/contracts";
import type { DetectionInput } from "./detection.js";
import { clampSize, type PaneInfo } from "./protocol.js";
import { diffFrame, fullFrame, renderRow, type Screen } from "./render.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

/** What the host needs of a pseudo-terminal: node-pty's, or a test's stand-in. */
export interface Pty {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** One attached window (or plugin): what it is sent, and how it hears the pane closed. */
export interface Attachment {
  mode: TerminalMode;
  send(frame: TerminalFrame): void;
  close(reason: string | null): void;
}

export interface ScrollState {
  offset: number;
  max: number;
  rows: number;
}

/** The rows a pane keeps above its screen. */
export const SCROLLBACK = 5_000;
/** Paints are at least this far apart: the frames of a burst of output go as one. */
export const FRAME_MS = 16;
/** A pane painting every frame for this long is a flood of output: it is painted every `BUSY_FRAME_MS` instead. */
export const BUSY_MS = 250;
/** How far apart a flood's paints are: a window parses half as many screens, and none falls behind. */
export const BUSY_FRAME_MS = 33;

/** How much of a title or progress report detection keeps, as herdr keeps it. */
const OSC_MAX = 256;
const oscText = (text: string) => [...text.replace(/\p{Cc}/gu, "")].slice(0, OSC_MAX).join("");

const sameScroll = (a: ScrollState | null, b: ScrollState) => !!a && a.offset === b.offset && a.max === b.max && a.rows === b.rows;

/**
 * One terminal of the host: its pseudo-terminal, the screen a headless xterm
 * keeps of it (with capped scrollback), where its view is in that scrollback,
 * and the windows attached to it. The headless xterm answers the program's
 * queries (ConPTY waits for its device attributes before it starts), so the
 * windows are sent only screens, never the program's own bytes.
 */
export class Pane {
  readonly term: HeadlessTerminal;
  title: string | null = null;
  /** Counts what changed the screen or title, so a reading of an unchanged pane is skipped. */
  revision = 0;
  /** The title and the last OSC 9 report as the agent sent them, for detection. */
  private oscTitle = "";
  private oscProgress = "";
  offset = 0;
  exited = false;
  private readonly attachments = new Set<Attachment>();
  private controller: Attachment | null = null;
  private shown: Screen | null = null;
  private seq = 0;
  /** Cancels the paint on its way, if one is. */
  private painting: (() => void) | null = null;
  private paintedAt = 0;
  /** How far apart paints are now, and since when output has come within a frame of every paint (0 after a quiet frame). */
  private frameMs = FRAME_MS;
  private busySince = 0;
  private lastScroll: ScrollState | null = null;
  private readonly cell: IBufferCell;
  /** Modes the public API does not report, read off the program's own sequences. */
  private cursorVisible = true;
  private cursorStyle = 0;
  private sgrMouse = false;

  constructor(
    readonly id: string,
    readonly pty: Pty,
    readonly cwd: string,
    readonly label: string | null,
    cols: number,
    rows: number,
    private readonly hooks: { onScroll(pane: Pane, scroll: ScrollState): void; onExit(pane: Pane): void; onTitle?(pane: Pane): void; onOutput?(pane: Pane): void },
    scrollback = SCROLLBACK
  ) {
    this.term = new Terminal({ cols: clampSize(cols), rows: clampSize(rows), scrollback, allowProposedApi: true });
    this.cell = this.term.buffer.active.getNullCell();
    const decset = (on: boolean) => (params: (number | number[])[]) => {
      for (const p of params.flat()) {
        if (p === 25) this.cursorVisible = on;
        else if (p === 1006) this.sgrMouse = on;
      }
      return false;
    };
    this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, decset(true));
    this.term.parser.registerCsiHandler({ prefix: "?", final: "l" }, decset(false));
    this.term.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
      this.cursorStyle = Number(params.flat()[0] ?? 0) || 0;
      return false;
    });
    this.term.parser.registerEscHandler({ final: "c" }, () => {
      this.cursorVisible = true;
      this.cursorStyle = 0;
      this.sgrMouse = false;
      return false;
    });
    // OSC 9;4 is how some agents report progress (`4;0` idle); detection reads the last one.
    this.term.parser.registerOscHandler(9, (data) => {
      this.oscProgress = oscText(data);
      this.revision++;
      return false;
    });
    this.term.onTitleChange((title) => {
      this.oscTitle = oscText(title);
      this.revision++;
      const next = title.trim() || null;
      if (next === this.title) return;
      this.title = next;
      hooks.onTitle?.(this);
    });
    // Its answers to the program's queries (device attributes, cursor position) go back to the program.
    this.term.onData((data) => !this.exited && this.pty.write(data));
    pty.onData((data) => {
      const base = this.term.buffer.active.baseY;
      this.term.write(data, () => {
        // A view up in the scrollback stays on what it showed while output goes on below.
        if (this.offset) this.offset = Math.min(this.offset + Math.max(0, this.term.buffer.active.baseY - base), this.maxOffset());
        this.revision++;
        this.schedule();
        hooks.onOutput?.(this);
      });
    });
    pty.onExit(() => hooks.onExit(this));
  }

  get pid(): number {
    return this.pty.pid;
  }

  private maxOffset(): number {
    const buffer = this.term.buffer.active;
    return buffer.type === "alternate" ? 0 : buffer.baseY;
  }

  scroll(): ScrollState {
    return { offset: Math.min(this.offset, this.maxOffset()), max: this.maxOffset(), rows: this.term.rows };
  }

  info(): PaneInfo {
    const s = this.scroll();
    return { pane_id: this.id, title: this.title, label: this.label, cwd: this.cwd, pid: this.pid, scroll: { offset_from_bottom: s.offset, max_offset_from_bottom: s.max, viewport_rows: s.rows } };
  }

  /** The screen the view shows now. */
  screen(): Screen {
    const buffer = this.term.buffer.active;
    const { cols, rows } = this.term;
    const offset = Math.min(this.offset, this.maxOffset());
    const top = buffer.baseY - offset;
    const out: Screen = { width: cols, height: rows, rows: [], widths: [], cursor: null, modes: this.modes(), alternate: buffer.type === "alternate" };
    for (let y = 0; y < rows; y++) {
      const row = renderRow(buffer.getLine(top + y), cols, this.cell);
      out.rows.push(row.text);
      out.widths.push(row.width);
    }
    if (!offset && this.cursorVisible) out.cursor = { x: Math.min(buffer.cursorX, cols - 1), y: buffer.cursorY };
    return out;
  }

  private modes(): string {
    const m = this.term.modes;
    const set = (n: number, on: boolean) => `\x1b[?${n}${on ? "h" : "l"}`;
    return `${set(1, m.applicationCursorKeysMode)}${m.applicationKeypadMode ? "\x1b=" : "\x1b>"}${set(2004, m.bracketedPasteMode)}${set(1004, m.sendFocusMode)}\x1b[${this.cursorStyle} q`;
  }

  /**
   * The pane's live bottom as herdr's detection reads it, whatever the view is scrolled to: a screen's height of rows
   * ending at the last one with something on it (or the cursor's, if lower), each without trailing blanks, the blank
   * rows at the end dropped. On the alternate screen, the whole screen.
   */
  detectionText(): string {
    const buffer = this.term.buffer.active;
    const total = buffer.length;
    const row = (y: number) => buffer.getLine(y)?.translateToString(true).trimEnd() ?? "";
    let end = total - 1;
    if (buffer.type === "normal") {
      const top = buffer.baseY;
      let last = -1;
      for (let y = total - 1; y >= top && last < 0; y--) if (row(y).trim()) last = y;
      if (last >= 0) end = Math.max(last, Math.min(top + buffer.cursorY, total - 1));
    }
    const rows: string[] = [];
    for (let y = Math.max(0, end + 1 - this.term.rows); y <= end; y++) rows.push(row(y));
    while (rows.length && !rows.at(-1)!.trim()) rows.pop();
    return rows.length ? `${rows.join("\n")}\n` : "";
  }

  /** What an agent's detection manifest reads of the pane. */
  detectionInput(): DetectionInput {
    return { screen: this.detectionText(), oscTitle: this.oscTitle, oscProgress: this.oscProgress };
  }

  /** Progress another agent reported says nothing of the one that took its place. */
  forgetProgress(): void {
    this.oscProgress = "";
  }

  /** The last lines with something on them, styling stripped. */
  tail(lines: number): string {
    const buffer = this.term.buffer.active;
    const text: string[] = [];
    for (let y = 0; y < buffer.length; y++) text.push(buffer.getLine(y)?.translateToString(true) ?? "");
    while (text.length && !text.at(-1)) text.pop();
    return text.slice(-Math.max(1, lines)).join("\n");
  }

  /** Attaches a window once everything written so far is on the screen: `ready` hears it took, then the window is painted the screen whole. */
  attach(attachment: Attachment, cols: number, rows: number, ready: () => void = () => undefined): void {
    this.term.write("", () => {
      if (this.exited) return attachment.close("exited");
      if (attachment.mode === "control") {
        // Taking over, as herdr does: the one that held the pane is let go, and its window offers to attach again.
        const previous = this.controller;
        this.controller = attachment;
        if (previous) {
          this.attachments.delete(previous);
          previous.close("taken_over");
        }
        this.resize(cols, rows);
      }
      // The others are brought up to now first, so the new one joins on the screen they all have.
      this.flush();
      this.attachments.add(attachment);
      ready();
      attachment.send(this.frame(this.shown!, true));
    });
  }

  detach(attachment: Attachment): void {
    this.attachments.delete(attachment);
    if (this.controller === attachment) this.controller = null;
  }

  controls(attachment: Attachment): boolean {
    return this.controller === attachment && !this.exited;
  }

  input(data: string): void {
    if (this.exited) return;
    // Its echo is painted at the full rate, flood or not: a paint held for a flood's slower frame is brought forward.
    if (this.frameMs !== FRAME_MS) {
      this.frameMs = FRAME_MS;
      this.busySince = 0;
      if (this.painting) {
        this.painting();
        this.painting = null;
        this.schedule();
      }
    }
    // Typing brings the view back to the bottom, where it goes.
    if (this.offset) {
      this.offset = 0;
      this.schedule();
    }
    // As user input, so xterm parses the echo that follows at once rather than a timer later (a whole 15.6 ms tick on
    // Windows); its onData hands it on to the program.
    this.term.input(data, true);
  }

  resize(cols: number, rows: number): void {
    const c = clampSize(cols);
    const r = clampSize(rows);
    if (this.exited || (c === this.term.cols && r === this.term.rows)) return;
    this.term.resize(c, r);
    this.revision++;
    try {
      this.pty.resize(c, r);
    } catch {
      // the process is ending
    }
    this.schedule();
  }

  scrollTo(offset: number): void {
    const next = Math.max(0, Math.min(Math.round(offset), this.maxOffset()));
    if (next === this.offset) return;
    this.offset = next;
    this.schedule();
  }

  /**
   * The wheel and Page Up/Down: to a program that reads the mouse, as its own wheel events; on the alternate screen
   * (a pager, an editor), as the keys; otherwise through the scrollback.
   */
  wheel(s: TerminalScroll): void {
    if (this.exited) return;
    const up = s.direction === "up";
    const lines = clampSize(s.lines);
    const alternate = this.term.buffer.active.type === "alternate";
    if (s.source === "page_key") {
      if (alternate) this.pty.write(up ? "\x1b[5~" : "\x1b[6~");
      else this.scrollTo(this.offset + (up ? lines : -lines));
      return;
    }
    if (this.term.modes.mouseTrackingMode !== "none" && this.term.modes.mouseTrackingMode !== "x10") {
      const at = { column: s.column ?? 0, row: s.row ?? 0 };
      for (let i = 0; i < lines; i++) this.pty.write(this.mouseReport(up ? 64 : 65, at.column, at.row, false, s.modifiers ?? 0));
      return;
    }
    if (alternate) {
      const key = this.term.modes.applicationCursorKeysMode ? (up ? "\x1bOA" : "\x1bOB") : up ? "\x1b[A" : "\x1b[B";
      this.pty.write(key.repeat(lines));
      return;
    }
    this.scrollTo(this.offset + (up ? lines : -lines));
  }

  /** A click, as the program asked to hear them; nothing when it reads no mouse. */
  mouse(m: TerminalMouse): void {
    const mode = this.term.modes.mouseTrackingMode;
    if (this.exited || mode === "none") return;
    if (mode === "x10" && m.action !== "down") return;
    if (mode === "vt200" && (m.action === "drag" || m.action === "move")) return;
    if (mode === "drag" && m.action === "move") return;
    const button = { left: 0, middle: 1, right: 2, none: 3 }[m.button ?? "left"];
    const code = (m.action === "drag" || m.action === "move" ? 32 : 0) + (m.action === "move" ? 3 : button);
    this.pty.write(this.mouseReport(code, m.column, m.row, m.action === "up", m.modifiers ?? 0));
  }

  private mouseReport(code: number, column: number, row: number, release: boolean, modifiers: number): string {
    const x = Math.max(0, Math.round(column)) + 1;
    const y = Math.max(0, Math.round(row)) + 1;
    const b = code + (modifiers & 28);
    if (this.sgrMouse) return `\x1b[<${b};${x};${y}${release ? "m" : "M"}`;
    // The old encoding has no release per button, and no room past column 223.
    const chr = (n: number) => String.fromCharCode(Math.min(255, 32 + n));
    return `\x1b[M${chr(release ? 3 + (modifiers & 28) : b)}${chr(x)}${chr(y)}`;
  }

  /**
   * Paints what changed, for every window at once: right after this turn of output when the last paint is a frame
   * behind (a keystroke's echo), else once it is, so a burst goes as one. Output that keeps coming within a frame of
   * every paint for `BUSY_MS` is painted every `BUSY_FRAME_MS`, until a frame goes by without any.
   */
  private schedule(): void {
    if (this.painting || this.exited) return;
    const paint = () => {
      this.painting = null;
      this.flush();
    };
    const now = Date.now();
    if (now - this.paintedAt >= this.frameMs) {
      this.frameMs = FRAME_MS;
      this.busySince = 0;
    } else if (!this.busySince) this.busySince = this.paintedAt;
    else if (now - this.busySince >= BUSY_MS) this.frameMs = BUSY_FRAME_MS;
    const wait = this.paintedAt + this.frameMs - now;
    if (wait <= 0) {
      const soon = setImmediate(paint);
      this.painting = () => clearImmediate(soon);
    } else {
      const timer = setTimeout(paint, wait);
      this.painting = () => clearTimeout(timer);
    }
  }

  private flush(): void {
    this.painting?.();
    this.painting = null;
    this.paintedAt = Date.now();
    const next = this.screen();
    if (this.shown && this.attachments.size) {
      const bytes = diffFrame(this.shown, next);
      if (bytes) {
        const frame = this.frame(next, false, bytes);
        for (const a of this.attachments) a.send(frame);
      }
    }
    this.shown = next;
    this.tellScroll();
  }

  private frame(screen: Screen, full: boolean, bytes = fullFrame(screen)): TerminalFrame {
    return { seq: ++this.seq, width: screen.width, height: screen.height, full, bytes: new Uint8Array(Buffer.from(bytes, "utf8")) };
  }

  private tellScroll(): void {
    const now = this.scroll();
    if (sameScroll(this.lastScroll, now)) return;
    this.lastScroll = now;
    this.hooks.onScroll(this, now);
  }

  /** The pane is over: the windows get its last screen and are told, once. */
  end(): void {
    if (this.exited) return;
    this.flush();
    this.exited = true;
    for (const a of [...this.attachments]) a.close("exited");
    this.attachments.clear();
    this.controller = null;
  }

  dispose(): void {
    this.end();
    this.painting?.();
    this.painting = null;
    this.term.dispose();
  }
}
