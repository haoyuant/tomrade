import type { ChangedFile, ChangeFileOptions, ChangesOptions, ChangesView, Editor, ReviewCursor, ReviewPage, ReviewSaid, SessionAsk, SessionOutcome } from "@tomradex/code-link";
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
  /** The tool whose call just failed, for the window to word ("" when its hook named none); null otherwise. */
  failedTool: string | null;
  /** What it waits on the person for, as a structure the window words: a tool's permission, a question; null otherwise. */
  ask: SessionAsk | null;
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
  /** Its agent declared the keys that answer its permission prompt: Allow and Deny on its card press them in its pane. */
  approval: boolean;
  /**
   * What its screen asks that its card answers now: a permission prompt with yes under the cursor, one with no, a
   * folder's trust (Trust and continue or Exit, picked with arrows and Enter), the menu of the question its hook told of
   * (its `ask.options`, picked the same way), or nothing that could safely be answered.
   */
  prompt: "allow" | "deny" | "trust" | "choice" | null;
  /** When its hooks last spoke; what the session bar orders waiting and idle rows by. */
  lastEventAt: number | null;
  /** Ended, and what its pane showed while it ran was recorded here: its raw output can be played back. */
  rawOutput: boolean;
  /** Ended and listed: what came of it, the look back's way (its pull request, commits, asks, last word); null otherwise. */
  outcome: SessionOutcome | null;
  /** Live in a pane here: the pane's last lines that say something, as the bar's card shows them; null otherwise. */
  tail: string[] | null;
  /** On no ticket: the open one what the person first said to it sounds like; null without a guess. */
  guess: { key: string; title: string } | null;
}

/** A plain terminal closed here whose output was recorded: in History, to play back. */
export interface ClosedTerminalRow {
  id: string;
  title: string;
  cwd: string;
  pane: string;
  startedAt: number;
  endedAt: number;
}

/** One entry of a pane's timeline: a session that ran in it, or manual work done there between sessions (raw output only). */
export type TimelineEntry = { kind: "session"; id: string; from: number; to: number | null; session: SessionRow } | { kind: "manual"; id: string; from: number; to: number; bytes: number };

/** One frame of a recording played back: when it was painted, the screen's size, whether it paints the whole screen (a snapshot the window took, `key`, after a reset). */
export interface ReplayRecord {
  t: number;
  w: number;
  h: number;
  full: boolean;
  key: boolean;
  bytes: Uint8Array;
}

/** A conversation of the assistant panel's, the built-in assistant's among them: in the session bar beside the sessions, with no pane here. */
export interface ThreadRow {
  id: string;
  title: string;
  engine: string;
  /** The engine's own name; null when Tomrade does not know it. */
  engineName: string | null;
  itemId: string | null;
  key: string | null;
  ticketTitle: string | null;
  /** The conversation it was opened under, to write its code in the background: it sits under that one in the bar. */
  parentId: string | null;
  running: boolean;
  /** Its ticket is done: as in the assistant panel, it reads as finished once nothing runs in it. */
  ticketDone: boolean;
  /**
   * What it waits on the person for, and since when this window has seen it wait in that way; with the question's id
   * and the choices its card answers with (null when it offers none, or takes several at once).
   */
  wait: { kind: "permission" | "question"; text: string | null; since: number; questionId: string | null; options: string[] | null } | null;
  createdAt: number;
  updatedAt: number;
}

/** A ticket ⌘K can start in a new cell: one of the project's open ones. */
export interface TicketRow {
  id: string;
  key: string;
  title: string;
  status: string;
}

/** An ended conversation the look back found for ⌘K's history, searched by what was said. */
export interface ReviewHit {
  id: string;
  /** An ended coding session, an assistant conversation put away, or one left idle (still open in the app window). */
  kind: "session" | "thread" | "idle";
  /** The ticket it went by, when it worked one. */
  key: string | null;
  title: string;
  /** Its agent's own name; null when Tomrade does not know it. */
  agent: string | null;
  /** Its own last word on where it got to. */
  said: string | null;
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
  /** Nothing runs in it but its shell: no agent, no other command in its foreground. */
  shell: boolean;
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
 * shows; the rest are History's, read a page at a time (`historyList`).
 */
export interface WindowState {
  projectId: string;
  projectName: string;
  /** The app's language, so the window speaks it even before the main window says how it looks. */
  locale: string;
  /** The commands the person rebound (settings "keybindings".overrides), so the window's copy and paste keys are theirs. */
  keybindings?: Record<string, string[]>;
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
  /** The assistant panel's conversations, read when they change rather than with every state. */
  threads: ThreadRow[];
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
  /** Closed terminals a cell shows the recording of; the rest wait in History. */
  closedTerminals: ClosedTerminalRow[];
  /** By a pane this window shows: the sessions that ended in it before, oldest first. */
  history: Record<string, SessionRow[]>;
  /** The sidebar folded to a strip, as this project's window was left. */
  folded: boolean;
  /** The overview shows every row, not only what is active, as this project's window was left. */
  overviewAll: boolean;
  /** The project's open tickets, the latest changed first: ⌘K starts one in a new cell. */
  tickets: TicketRow[];
  /** The agent a ticket started from here runs, by name: the one Start would pick; null when none can run in a terminal. */
  startAgent: string | null;
}

/** What the window asks for. */
export type WindowMessage =
  | { type: "attach"; cell: string; sessionId: string; cols: number; rows: number }
  /** The window names the new terminal's id, so its cell shows it before herdr has opened it. */
  /** The ended session a cell shows: its conversation, read from its agent's own record; `before` an earlier read's `start`, what came before it. */
  | { type: "conversation"; cell: string; sessionId: string; before?: number }
  /**
   * `resume`: a conversation's session, taken up again in the new terminal by its agent. `from`: the pane of the cell it
   * was split off, whose shell's folder it starts in when that is known (the shell may have moved since `cwd`).
   */
  | { type: "newTerminal"; terminalId: string; cwd: string | null; resume?: string; from?: string }
  | { type: "closeTerminal"; terminalId: string }
  /** Where herdr cannot show a terminal here: open one in the system terminal, in this folder. */
  | { type: "openOutside"; cwd: string | null }
  | { type: "savePreset"; name: string; layout: Layout }
  | { type: "renamePreset"; id: string; name: string }
  | { type: "deletePreset"; id: string }
  /** A deleted layout's Undo: back where it was in the list, the default again if it was. */
  | { type: "restorePreset"; preset: LayoutPreset; at: number; isDefault: boolean }
  | { type: "defaultPreset"; id: string | null }
  | { type: "autoPlace"; on: boolean }
  /** History opened or closed: while it is open, a change to the conversations is said with `historyChanged`. */
  | { type: "history"; open: boolean }
  /** One page of History, the assistant panel's list: the newest, the one past `before`, or the newest matches of `query`; answered with `historyPage`. */
  | { type: "historyList"; token: number; before?: ReviewCursor | null; query?: string }
  /** Which ended conversations said this, from their agents' records; answered with `historySaid`. */
  | { type: "historySaid"; token: number; query: string }
  | { type: "fold"; folded: boolean }
  | { type: "overviewAll"; all: boolean }
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
  /** An assistant conversation, shown in the app window: it has no pane here. */
  | { type: "showThread"; threadId: string }
  /** A ticket, opened in the app window. */
  | { type: "openItem"; itemId: string }
  /** The app's main window brought forward, on this project. */
  | { type: "mainWindow" }
  /** The person's answer to a ticketless session's guess: take that ticket, or go on without one. */
  | { type: "takeGuess"; sessionId: string }
  | { type: "noTicket"; sessionId: string }
  /** The session's permission prompt answered from its card: the keys its agent declared, pressed in its pane. */
  | { type: "answer"; sessionId: string; which: "allow" | "deny"; token?: number }
  /** The folder's trust its screen asks answered from its card: the cursor moved to that option, then Enter. */
  | { type: "trust"; sessionId: string; which: "trust" | "exit"; token?: number }
  /** The session's question answered from its card with one of its choices, picked on its pane's menu. */
  | { type: "choose"; sessionId: string; choice: string; token?: number }
  /** An assistant conversation's question answered from its card with one of its choices. */
  | { type: "answerThread"; threadId: string; questionId: string; value: string; token?: number }
  /** The last lines of every pane this window lists, for the overview: answered with `tails`. */
  | { type: "tails" }
  /** The recording of an ended session, a closed terminal or a stretch of manual work a cell shows: answered with `replay`. */
  | { type: "replay"; cell: string; id: string }
  /** What happened in a pane from early to late, for the cell's timeline: answered with `timeline`. */
  | { type: "timeline"; cell: string; pane: string }
  /** The cell's screen as asked for by `snapshot`: serialized by the window, as of the last frame it had drawn (`seq`). */
  | { type: "snapshot"; cell: string; token: number; seq: number; width: number; height: number; bytes: Uint8Array }
  | { type: "openWorktree"; sessionId: string }
  | { type: "openPr"; sessionId: string }
  /** What a session's ticket changed, for the diff its cell opens: answered with `changesRead`. */
  | { type: "changes"; token: number; itemId: string; opts: ChangesOptions }
  /** One file of those changes with every hunk: answered with `changeFileRead`. */
  | { type: "changeFile"; token: number; itemId: string; opts: ChangesOptions & ChangeFileOptions }
  /** One changed file opened in an editor, or by the system when none is on PATH: answered with `changedOpened`. */
  | { type: "openChanged"; token: number; itemId: string; linkId?: string; path: string }
  | { type: "focusHerdr"; sessionId: string }
  /** Bring forward the terminal app an outside session runs in. */
  | { type: "switchTo"; sessionId: string }
  | { type: "install" }
  | { type: "openGuide" }
  /** A link clicked in a terminal: opened in the system browser. `or` comes with a path read over two rows: the first row's part, opened when the whole is no file. */
  | { type: "openLink"; url: string; or?: string }
  | { type: "switchTerminal"; switch: boolean }
  /** Start herdr's server again after it would not come up. */
  | { type: "startHerdr" }
  /** A ticket started with the agent Start would pick, in a new cell of this window. */
  | { type: "startTicket"; itemId: string }
  /** The look back searched for ⌘K's history, as the app window's ⌘K does: answered with `reviewFound`. */
  | { type: "reviewSearch"; query: string }
  /** An ended session the look back found, put in a cell to read. */
  | { type: "show"; sessionId: string }
  | { type: "refresh" }
  /** Whether anyone can see the window (not minimised, hidden or covered): while nobody can, herdr is not asked for it and it hears no state. */
  | { type: "visible"; visible: boolean };

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
  /** A card's answer went, or failed to: its buttons may be pressed again. Echoes the answer's token. */
  | { type: "answered"; token: number }
  /**
   * A page of History: its rows, and with them the session rows behind the coding sessions on it (so one picked goes
   * into a cell), the agents' names by id, and — with the first page — the closed terminals whose output was recorded.
   */
  | { type: "historyPage"; token: number; page: ReviewPage; sessions: SessionRow[]; agents: Record<string, string>; terminals: ClosedTerminalRow[] | null }
  /** The ended conversations that said the query, each with the line that says it; the session rows and agents' names as with a page. */
  | { type: "historySaid"; token: number; found: ReviewSaid; sessions: SessionRow[]; agents: Record<string, string> }
  | { type: "changesRead"; token: number; view: ChangesView | null }
  | { type: "changeFileRead"; token: number; file: ChangedFile | null }
  /** Where the changed file went; null when it is not on this machine. */
  | { type: "changedOpened"; token: number; where: Editor | "system" | null }
  /** A session ended or a conversation moved while History is open: its first page is read again. */
  | { type: "historyChanged" }
  /** What the look back found for ⌘K's history. */
  | { type: "reviewFound"; query: string; rows: ReviewHit[] }
  /** Each listed pane's last lines, styling stripped; null for a pane that is gone. */
  | { type: "tails"; panes: Record<string, string | null> }
  /** The recording asks the cell for its screen as it is, to begin a new stretch of the recording with. */
  | { type: "snapshot"; cell: string; token: number }
  /**
   * What was recorded of the session or terminal: the records before `at` bring the screen to its start and are not
   * shown. `cut`: its start did not fit; `clean`: the first record paints the whole screen. None recorded: no records.
   * `keep`: how long and how much of a pane the recordings are kept, as the settings say.
   */
  | { type: "replay"; cell: string; id: string; records: ReplayRecord[]; at: number; cut: boolean; clean: boolean; from: number; to: number; keep: { days: number; mb: number } }
  /** A pane's sessions and the manual work between them, oldest first; `keep` as for a replay. */
  | { type: "timeline"; cell: string; pane: string; entries: TimelineEntry[]; keep: { days: number; mb: number } };
