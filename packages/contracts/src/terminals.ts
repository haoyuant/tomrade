/*
 * The terminal backend the Terminal window and code link run panes on, read as
 * `ctx.terminals`: herdr on macOS and Linux, Tomrade's own pty host on native
 * Windows. Both speak in herdr's shapes, so the panes draw one way.
 */

/** One picture of the terminal: ANSI bytes that paint it — all of it when `full`, else only what changed. */
export interface TerminalFrame {
  seq: number;
  width: number;
  height: number;
  full: boolean;
  bytes: Uint8Array;
}

/** `control` owns input and size (taking them from any other owner); `observe` only watches, alongside others. */
export type TerminalMode = "control" | "observe";

export type TerminalScroll = { source?: "wheel" | "page_key"; direction: "up" | "down"; lines: number; column?: number; row?: number; modifiers?: number };
export type TerminalMouse = { action: "down" | "up" | "drag" | "move"; button?: "left" | "middle" | "right" | "none"; column: number; row: number; modifiers?: number };

/** A live terminal of a pane. Calls on a closed stream, or on an observer, are dropped. */
export interface TerminalStream {
  readonly paneId: string;
  readonly mode: TerminalMode;
  onFrame(listener: (frame: TerminalFrame) => void): () => void;
  /** Once: the backend's reason (`server_shutdown`, `exited`…), or what it said when it would not attach. */
  onClose(listener: (reason: string | null) => void): () => void;
  input(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  scroll(scroll: TerminalScroll): void;
  mouse(mouse: TerminalMouse): void;
  close(): void;
  readonly closed: boolean;
}

/** Whether a live terminal can be had, and what to do when it cannot. */
export type TerminalBridge =
  | { state: "ready"; version: string }
  /** No backend runs here: herdr's direct attach on native Windows, or a build without the pty host's runtime. */
  | { state: "unsupported" }
  | { state: "notInstalled" }
  | { state: "notRunning"; version: string }
  | { state: "tooOld"; version: string; need: string; fix: string }
  /** herdr's CLI was upgraded but its server still runs the old build. */
  | { state: "stale"; version: string; server: string; fix: string };

/** How the backend reads the agent in a pane. */
export type TerminalStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** What the backend says about a pane someone follows. */
export type TerminalPaneEvent =
  | { kind: "status"; paneId: string; status: TerminalStatus; agent: string | null }
  /** The pane's process ended, or the pane was closed: nothing runs there any more. */
  | { kind: "exited"; paneId: string };

/** A pane's view in its scrollback, in rows: `offset` above the bottom, at most `max`, `rows` on screen. */
export interface TerminalScrollPosition {
  offset: number;
  max: number;
  rows: number;
}

/** What the backend reads off one pane: the agent it detected there, that agent's own session id, how it reads that agent, and the title on the pane. */
export interface TerminalPaneInfo {
  paneId: string;
  agent: string | null;
  agentSession: string | null;
  /** `unknown` for a pane with no agent, too. */
  status: TerminalStatus;
  title: string | null;
}

/** A process in a pane's foreground, as far as the backend can tell. */
export interface TerminalProcess {
  cmdline?: string;
  cwd?: string;
}

/** Where a project's panes are kept together: its sessions open there, one tab each. */
export interface TerminalWorkspaceRef {
  /** What the workspace is remembered by — the project's id. */
  key: string;
  /** What it is shown as — the project's name. */
  label: string;
}

export interface TerminalLaunch {
  cwd: string;
  label?: string;
  /** Typed into the pane's shell, with Enter; a plain shell without one (or without `program`). */
  command?: string;
  /** Run as the pane's own process instead of a shell; a backend that types commands (herdr) ignores it. */
  program?: { file: string; args: string[] };
  workspace?: TerminalWorkspaceRef;
}

/** How `revive` went: the backend answers (already, or started now), did not come up, is held by the limit, or is not here. */
export type TerminalRevive = "running" | "started" | "failed" | "held" | "notInstalled";

/** The terminal backend, `ctx.terminals`. */
export interface TerminalProvider {
  /** Which one it is: the herdr-only parts (showing a pane in herdr's own window, installing it) go with "herdr". */
  readonly kind: "herdr" | "builtin";
  /** Whether a live terminal can be had; never starts anything. */
  bridge(): Promise<TerminalBridge>;
  /** The backend's version when it is there to start, else null. */
  installed(): Promise<string | null>;
  /** True when it should answer and does not: a stream that ended then ended with it, not with its pane. */
  serverGone(): Promise<boolean>;
  /** The backend answering again after it went away, for a window showing its panes. */
  revive(force?: boolean): Promise<TerminalRevive>;
  /** A pane for a command, on a backend started for it when none runs. `startedServer` is "first" the first time ever. Null when it does not answer. */
  launch(input: TerminalLaunch): Promise<{ paneId: string; workspaceId?: string; startedServer?: "first" | "again" } | null>;
  terminal(paneId: string, opts: { mode?: TerminalMode; cols: number; rows: number }): Promise<TerminalStream>;
  /** Close a pane and end what runs in it. True once it is gone, also when it already was. */
  closePane(paneId: string): Promise<boolean>;
  /** Whether the pane is still there; null when the backend does not answer. */
  paneAlive(paneId: string): Promise<boolean | null>;
  /** Every pane the backend has; null when it does not answer. */
  panes(): Promise<TerminalPaneInfo[] | null>;
  /** What runs in a pane's foreground; empty when the backend cannot tell. */
  processes(paneId: string): Promise<TerminalProcess[]>;
  /** Hand text to the agent in a pane, as a prompt. False when it could not. */
  prompt(paneId: string, text: string): Promise<boolean>;
  /** The last lines on a pane's screen, styling stripped; null when the pane is gone. */
  readTail(paneId: string, lines?: number): Promise<string | null>;
  /** Where a pane's view is in its scrollback: now, then on every change. */
  onScroll(paneId: string, listener: (scroll: TerminalScrollPosition) => void): () => void;
  scrollTo(paneId: string, offset: number): Promise<boolean>;
  /** Hear about the panes being watched. */
  onPane(listener: (event: TerminalPaneEvent) => void): () => void;
  /** Follow a pane; the returned function lets this hold go. */
  watch(paneId: string): () => void;
  watching(): string[];
}
