import type { Disposer } from "./contract.js";

/** SDK 0.2.10. Whether herdr can hand over a live terminal, and the command that fixes it when it cannot. */
export type TerminalBridgeState =
  | { state: "ready"; version: string }
  | { state: "unsupported" }
  | { state: "notInstalled" }
  | { state: "notRunning"; version: string }
  | { state: "tooOld"; version: string; need: string; fix: string }
  | { state: "stale"; version: string; server: string; fix: string };

/** One picture of the terminal: ANSI bytes that paint it — the whole viewport when `full`, else only the cells that changed. */
export interface TerminalFrame {
  seq: number;
  width: number;
  height: number;
  full: boolean;
  bytes: Uint8Array;
}

/** A live terminal of a herdr pane. The frames repaint the viewport only: scrolling back is asked for with `scroll`. */
export interface TerminalHandle {
  readonly paneId: string;
  readonly mode: "control" | "observe";
  onFrame(listener: (frame: TerminalFrame) => void): Disposer;
  /** Once, when the stream ends: herdr's reason, or what it said when it would not attach. */
  onClose(listener: (reason: string | null) => void): Disposer;
  /** Keys and pastes; a controller's only — an observer's input is dropped. */
  input(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  scroll(scroll: { direction: "up" | "down"; lines: number; column?: number; row?: number; modifiers?: number }): void;
  mouse(mouse: { action: "down" | "up" | "drag" | "move"; button?: "left" | "middle" | "right" | "none"; column: number; row: number; modifiers?: number }): void;
  /** Detach: the pane keeps running in herdr. Also done for every terminal the plugin left open when it unloads. */
  close(): void;
}

/**
 * SDK 0.2.10. Terminals of the herdr panes code sessions run in, through the
 * app: a plugin neither reaches herdr's socket nor starts its CLI itself.
 */
export interface TerminalsApi {
  state(): Promise<TerminalBridgeState>;
  /** `control` (the default) takes input and size from any other owner; `observe` watches beside others. Rejects when `state()` is not ready. */
  open(paneId: string, opts: { mode?: "control" | "observe"; cols: number; rows: number }): Promise<TerminalHandle>;
}
