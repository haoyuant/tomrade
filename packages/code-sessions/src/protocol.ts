import type { HerdrBridge, TerminalMouse, TerminalScroll } from "@tomradex/herdr";

/** One code session as the window lists it. */
export interface SessionRow {
  id: string;
  itemId: string | null;
  key: string | null;
  title: string | null;
  branch: string;
  /** "needs you" is `waiting` with a question or permission pending. */
  state: "running" | "waiting" | "idle" | "error" | "ended" | "lost";
  needsYou: boolean;
  /** What it is doing now, or what it last said. */
  activity: string | null;
  mode: "run" | "terminal";
  agent: string;
  /** The herdr pane it runs in, on this machine; null when it has no terminal here. */
  pane: string | null;
  threadId: string | null;
  prUrl: string | null;
  worktree: string | null;
  startedAt: number;
}

/** A plain terminal the window opened: a herdr pane of the person's, with no ticket or code-link session behind it. */
export interface TerminalRow {
  id: string;
  title: string;
  cwd: string;
  /** Null while herdr is still opening it. */
  pane: string | null;
  startedAt: number;
  /** The code session its agent claimed a ticket for: the cell shows that session, on the same pane. */
  sessionId: string | null;
  /** Why it stays a plain terminal although an agent claimed a ticket, when Tomrade cannot tell which terminal that was. */
  note: string | null;
}

/** A folder a new terminal can start in: the project's repository, or one of its worktrees. */
export interface TerminalPlace {
  label: string;
  cwd: string;
}

/** A cell of the window's layout: one session or terminal (by its id), or a split of two. */
export type Layout = { type: "leaf"; id: string; sessionId: string | null } | { type: "split"; id: string; direction: "row" | "column"; ratio: number; a: Layout; b: Layout };

/** What the window shows, set as its whole state. */
export interface WindowState {
  projectId: string;
  projectName: string;
  /** The app's language, so the window speaks it even before the main window says how it looks. */
  locale: string;
  bridge: HerdrBridge;
  /** How herdr installs here, when it is missing: the command shown on the button, or only the guide. */
  install: { command: string | null; guide: string } | null;
  /** The code-link terminal setting is not herdr, and the person has not yet been asked to switch it. */
  askSwitch: boolean;
  /** The terminal setting, as code link reads it on this machine. */
  terminal: string;
  sessions: SessionRow[];
  /** Said above the cells when the sessions could not be read; terminals still open. */
  warning: string | null;
  terminals: TerminalRow[];
  /** Where a new terminal can start, the repository first. */
  places: TerminalPlace[];
  layout: Layout;
}

/** What the window asks for. */
export type WindowMessage =
  | { type: "attach"; cell: string; sessionId: string; cols: number; rows: number }
  /** The window names the new terminal's id, so its cell shows it before herdr has opened it. */
  | { type: "newTerminal"; terminalId: string; cwd: string | null }
  | { type: "closeTerminal"; terminalId: string }
  | { type: "detach"; cell: string }
  | { type: "input"; cell: string; data: string }
  | { type: "resize"; cell: string; cols: number; rows: number }
  | ({ type: "scroll"; cell: string } & TerminalScroll)
  | ({ type: "mouse"; cell: string } & TerminalMouse)
  | { type: "layout"; layout: Layout }
  | { type: "continue"; sessionId: string }
  | { type: "openThread"; sessionId: string }
  | { type: "openWorktree"; sessionId: string }
  | { type: "openPr"; sessionId: string }
  | { type: "focusHerdr"; sessionId: string }
  | { type: "install" }
  | { type: "openGuide" }
  | { type: "switchTerminal"; switch: boolean }
  | { type: "refresh" };

/** What the plugin posts to the window, one by one. */
export type WindowPost =
  | { type: "frame"; cell: string; seq: number; width: number; height: number; full: boolean; bytes: Uint8Array }
  | { type: "closed"; cell: string; reason: string | null }
  | { type: "toast"; text: string };
