import type { TerminalBridge, TerminalKey, TerminalMouse, TerminalScroll, TerminalScrollPosition } from "@tomradex/contracts";

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
  /** The agent's own name (Claude Code, Codex…), for a session with no ticket to go by; null when Tomrade does not know it. */
  agentName: string | null;
  /** What the agent herdr sees in the session's pane calls the conversation; null without one, or when a terminal row speaks for it. */
  agentTitle: string | null;
  /** What the conversation was called, kept after it ended: the agent's title, its pane's, or its first prompt. */
  conversation: string | null;
  /** The folder the agent ran in, as its hooks said. */
  cwd: string | null;
  /** Someone spoke to it. */
  prompted: boolean;
  /** Its agent can take it up again by its id in a new terminal. */
  resumable: boolean;
  /** The herdr pane it runs in, on this machine; null when it has no terminal here. */
  pane: string | null;
  /** Where its terminal is: a herdr pane here, another terminal app here, another computer, or Tomrade running it. */
  where: "herdr" | "outside" | "elsewhere" | "tomrade";
  /** The terminal app it runs in, by name (iTerm2, Terminal, VS Code…); null when its hooks did not say. */
  terminal: string | null;
  /** That app can be brought forward from here. */
  switchable: boolean;
  threadId: string | null;
  prUrl: string | null;
  worktree: string | null;
  startedAt: number;
  /** When it ended; null while it lives. */
  endedAt: number | null;
  /** Ended while its pane goes on here as another of the window's rows (another ticket of the same agent): that row's id; null otherwise. */
  continuedIn: string | null;
  /** The herdr pane it ran in, kept once it ended (`pane` is only while it lives); null outside herdr. */
  ranIn: string | null;
  /** A ticket session's conversation was saved on this machine as it ended: all of it, or only its end. */
  recordSaved: "whole" | "end" | null;
}

/** A plain terminal the window opened: a herdr pane of the person's, with no ticket or code-link session behind it. */
export interface TerminalRow {
  id: string;
  title: string;
  cwd: string;
  /** Null while herdr is still opening it. */
  pane: string | null;
  startedAt: number;
  /** What the agent herdr sees in it calls the conversation; null without one. */
  agentTitle: string | null;
  /** How herdr reads that agent; null without one, or when herdr cannot tell. */
  agentStatus: "working" | "blocked" | "idle" | "done" | null;
  /** With no agent in it: what runs in its foreground when that is not the shell, else the title its shell set. */
  running: string | null;
  /** The code session its agent claimed a ticket for: the cell shows that session, on the same pane. */
  sessionId: string | null;
  /** Why it stays a plain terminal although an agent claimed a ticket, when Tomrade cannot tell which terminal that was. */
  note: string | null;
}

/** A folder a new terminal can start in: the project's repository, or one of its worktrees. */
/** One line of a conversation read back: what the person said, what the agent answered, a tool call with its input and output. */
export interface ConversationLine {
  who: "person" | "agent" | "tool";
  text: string;
  detail?: { input: string; output?: string };
}

export interface TerminalPlace {
  label: string;
  cwd: string;
}

/** A layout the person saved under a name: its shape and ratios, every cell empty. */
export interface LayoutPreset {
  id: string;
  name: string;
  layout: Layout;
}

/** A cell of the window's layout: one session or terminal (by its id), or a split of two. */
/** A leaf `locked` keeps its session until the person unlocks or closes it. */
export type Layout = { type: "leaf"; id: string; sessionId: string | null; locked?: true } | { type: "split"; id: string; direction: "row" | "column"; ratio: number; a: Layout; b: Layout };

/**
 * What the window shows, set as its whole state. `sessions` holds the live ones and the ended ones a cell still
 * shows; the rest are in `archive`.
 */
export interface WindowState {
  projectId: string;
  projectName: string;
  /** The app's language, so the window speaks it even before the main window says how it looks. */
  locale: string;
  bridge: TerminalBridge;
  /** Which backend the panes are on: herdr, Tomrade's own terminal host (native Windows), or none. */
  provider: "herdr" | "builtin" | null;
  /** A herdr client of its own runs on this machine: "Show in herdr" has a window to show the pane in. */
  herdrClient: boolean;
  /** herdr's server went away under this window's terminals: being started again, or that did not work (the person can retry). */
  revive: "starting" | "failed" | null;
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
  presets: LayoutPreset[];
  /** The preset a project's window opens with while it has no layout of its own. */
  defaultPreset: string | null;
  /** New sessions and terminals go to the first empty cell. */
  autoPlace: boolean;
  /** A session asked to be shown, from outside the window: put in a cell and selected once; `at` tells a new ask from one done. */
  reveal: { sessionId: string; at: number } | null;
  /** Ended sessions, put away: how many, and the rows themselves only while the window has the archive open, newest first. */
  archive: { count: number; rows: SessionRow[] | null };
  /** By a pane this window shows: the sessions that ended in it before, oldest first. */
  history: Record<string, SessionRow[]>;
  /** The sidebar folded to a strip, as this project's window was left. */
  folded: boolean;
}

/** What the window asks for. */
export type WindowMessage =
  | { type: "attach"; cell: string; sessionId: string; cols: number; rows: number }
  /** The window names the new terminal's id, so its cell shows it before herdr has opened it. */
  /** The ended session a cell shows: its conversation, read from its agent's own record; `before` an earlier read's `start`, what came before it. */
  | { type: "conversation"; cell: string; sessionId: string; before?: number }
  /** `resume`: a conversation's session, taken up again in the new terminal by its agent. */
  | { type: "newTerminal"; terminalId: string; cwd: string | null; resume?: string }
  | { type: "closeTerminal"; terminalId: string }
  /** Where herdr cannot show a terminal here: open one in the system terminal, in this folder. */
  | { type: "openOutside"; cwd: string | null }
  | { type: "savePreset"; name: string; layout: Layout }
  | { type: "renamePreset"; id: string; name: string }
  | { type: "deletePreset"; id: string }
  | { type: "defaultPreset"; id: string | null }
  | { type: "autoPlace"; on: boolean }
  /** The archive opened or closed: its rows come with the state while it is open. */
  | { type: "archive"; open: boolean }
  /** Which archived conversations said this: answered with `archiveFound`. */
  | { type: "archiveSearch"; query: string }
  | { type: "fold"; folded: boolean }
  | { type: "detach"; cell: string }
  | { type: "input"; cell: string; data: string }
  | { type: "key"; cell: string; key: TerminalKey }
  /** Files dropped onto a cell's terminal, by their paths on disk: typed into it as a paste. */
  | { type: "drop"; cell: string; paths: string[] }
  | { type: "resize"; cell: string; cols: number; rows: number }
  | ({ type: "scroll"; cell: string } & TerminalScroll)
  /** Dragging the cell's scrollbar: its pane's view, this many rows above the bottom of the scrollback. */
  | { type: "scrollTo"; cell: string; offset: number }
  | ({ type: "mouse"; cell: string } & TerminalMouse)
  | { type: "layout"; layout: Layout }
  | { type: "continue"; sessionId: string }
  | { type: "openThread"; sessionId: string }
  | { type: "openWorktree"; sessionId: string }
  | { type: "openPr"; sessionId: string }
  | { type: "focusHerdr"; sessionId: string }
  /** Bring forward the terminal app an outside session runs in. */
  | { type: "switchTo"; sessionId: string }
  | { type: "install" }
  | { type: "openGuide" }
  /** A link clicked in a terminal: opened in the system browser. */
  | { type: "openLink"; url: string }
  | { type: "switchTerminal"; switch: boolean }
  /** Start herdr's server again after it would not come up. */
  | { type: "startHerdr" }
  | { type: "refresh" };

/** What the plugin posts to the window, one by one. */
export type WindowPost =
  | { type: "frame"; cell: string; seq: number; width: number; height: number; full: boolean; bytes: Uint8Array }
  | { type: "closed"; cell: string; reason: string | null }
  /** Where the cell's pane is in its scrollback, in rows, for its scrollbar. */
  | ({ type: "scrolled"; cell: string } & TerminalScrollPosition)
  /** herdr's server is back: attach the cell's pane again. */
  | { type: "reattach"; cell: string }
  /**
   * A session's conversation, read-only; `lines` null when its agent's record cannot be read. `before` echoes the
   * request; `start`, while `cut`, is what to ask before for the stretch that came earlier.
   */
  | { type: "conversation"; cell: string; sessionId: string; lines: ConversationLine[] | null; cut: boolean; start: number | null; before: number | null }
  /** The pane the cell asked for streams in `other` already: one pane, one cell. */
  | { type: "shownIn"; cell: string; other: string }
  | { type: "toast"; text: string }
  /** The archived sessions whose conversation says the query, from what their agents recorded. */
  | { type: "archiveFound"; query: string; ids: string[] };
