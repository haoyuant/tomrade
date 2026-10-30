import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/db";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/items";
import type {} from "@tomradex/settings";
import { BUILTIN_TERMINAL, MCP_AGENT, RECENT_ENDED_MAX, RECENT_ENDED_MS, WINDOWS_TERMINAL, panesOf, resumeCommand, type CodeLink, type ReviewRow } from "@tomradex/code-link";
import { PROMPT_LINES, promptOnScreen } from "@tomradex/code-link/prompt";
import { PANEL_SURFACES } from "@tomradex/agent";
import type { DesktopSurface } from "@tomradex/desktop-surface";
import type {} from "@tomradex/herdr";
import type {} from "@tomradex/mcp";
import type { TerminalBridge, TerminalPaneInfo, TerminalProvider, TerminalStream } from "@tomradex/contracts";
import { randomUUID } from "node:crypto";
import { serveTerm, type TermWindow } from "./cli.js";
import { droppedPaste, readableDrops } from "./drop.js";
import { manualStretches, Recorder, RECORDING_SECTION, RecordingSettings, type Recording } from "./recorder.js";
import type { ClosedTerminalRow, Layout, LayoutPreset, ReviewHit, SessionRow, TerminalPlace, TerminalRow, ThreadRow, TicketRow, TimelineEntry, WindowMessage, WindowPost, WindowState } from "./protocol.js";
import { CODE_SESSIONS_WORDS } from "./words.js";
import { errorMessage } from "@tomradex/contracts";

export type * from "./protocol.js";
export { Recorder, Recording, RECORDING_SECTION, RecordingSettings, REPLAY_MAX, SEGMENT_MAX, manualStretches, parseSegment, sliceOf } from "./recorder.js";

export const Config = z.object({
  /** The window's page: the renderer's `code-sessions.html`. */
  document: z.string(),
  /** Where each project's layout, and whether the person was asked to switch to herdr, are kept on this machine. */
  stateFile: z.string().optional(),
  /** Where what the panes showed is recorded, on this machine; without it nothing is recorded. */
  recordingsDir: z.string().optional()
});
export type Config = z.infer<typeof Config>;

/** A session that ended in herdr this recently may come back with herdr's server: the window starts it for them. */
export const RECENTLY_ENDED_MS = 24 * 60 * 60 * 1000;
/** How often an open window asks herdr how it is, besides every session change. */
export const BRIDGE_POLL_MS = 10_000;
/** The most typing a cell holds while its terminal attaches. */
export const HELD_INPUT_MAX = 64 * 1024;
/** How long a cell's frames wait to go to the window as one: a busy pane paints more often than a screen shows. */
const FRAME_BATCH_MS = 16;
/** A batch past this goes at once, so a pane painting without pause cannot grow it without end. */
const FRAME_BATCH_MAX = 256 * 1024;
/** How soon after a keystroke the next frame of its cell still counts as its echo, and skips the batch. */
const ECHO_MS = 100;
/** How soon a waiting session whose screen showed no prompt is looked at again. */
const PROMPT_RECHECK_MS = 2000;
/** How long events settle before the window's state is computed for them: a turn ends in a burst of them. */
const REFRESH_SETTLE_MS = 100;
/** The least time between two states computed for events that change no session's standing: a busy agent's stream of them costs one a second. */
const REFRESH_GAP_MS = 1000;
/** How soon what is recorded in the background is looked at again after something changed: changes come in bursts. */
const BACKGROUND_SETTLE_MS = 250;
/** How long a pane whose observer would not open is left alone before it is tried again. */
const BACKGROUND_RETRY_MS = 30_000;
/** The size a pane is watched at when nothing here attached it and herdr does not say: herdr's own default. */
const DEFAULT_SIZE = { cols: 120, rows: 40 };
/** How many panes' sizes the saved state keeps. */
const SIZES_MAX = 100;

/** How many lines of each pane the overview reads. */
const TAIL_LINES = 8;
/** The most of a question an assistant card carries. */
const WAIT_TEXT_MAX = 160;
/** The tickets ⌘K can start from the window: open ones, the latest changed first, this many at most. */
const OPEN_TICKET = new Set(["backlog", "todo", "doing", "verifying"]);
const TICKETS_LISTED = 100;

interface Saved {
  asked?: boolean;
  layouts?: Record<string, Layout>;
  /** Each project's plain terminals, by the herdr pane they run in. */
  terminals?: Record<string, SavedTerminal[]>;
  presets?: LayoutPreset[];
  defaultPreset?: string | null;
  autoPlace?: boolean;
  /** Each project's window with its sidebar folded. */
  folded?: Record<string, boolean>;
  overviewAll?: Record<string, boolean>;
  /** The project the window last opened for: where a start that names none goes. */
  lastProject?: string;
  /** When each project's window was last opened or brought forward: the Dock's and the jump list's order. */
  used?: Record<string, number>;
  /** Each project's closed terminals whose output was recorded, oldest first. */
  closed?: Record<string, ClosedTerminalRow[]>;
  /** The size each pane was last attached at here, which it keeps after the cell lets go: what it is watched at. */
  sizes?: Record<string, { cols: number; rows: number }>;
}

/** How many closed terminals a project's History keeps. */
export const CLOSED_TERMINALS_MAX = 50;

type SavedTerminal = Omit<TerminalRow, "sessionId" | "note" | "agentTitle" | "agentStatus" | "running" | "shell"> & { pane: string };
type StartingTerminal = Omit<SavedTerminal, "pane"> & { pane: null };

const run = promisify(execFile);

/** Coding agents' commands, as they show in a terminal's foreground process. */
const AGENT_COMMAND = /(?:^|[\s/])(?:gemini|qwen|cursor-agent|claude|codex|opencode|droid|copilot|kimi|amp|codebuddy)(?:\s|$)/;

const within = (dir: string, root: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** A login or interactive shell, as a foreground command's first word (Windows' among them). */
const SHELL = /^-?(?:.*\/)?(zsh|bash|fish|sh|dash|ksh|tcsh|nu|login|pwsh|powershell|cmd)$/;

/** Where a pane's agent runs, when one does: the backend sees it, or the foreground command names one. Null otherwise. */
async function agentIn(terminals: TerminalProvider, seen: TerminalPaneInfo | undefined, pane: string, cwd: string): Promise<string | null> {
  const info = await terminals.processes(pane).catch(() => []);
  const named = info.find((p) => p.cmdline && AGENT_COMMAND.test(p.cmdline));
  if (!seen?.agent && !named) return null;
  return named?.cwd ?? info[0]?.cwd ?? cwd;
}
/** A repository's worktrees besides the checkout itself, as `git worktree list` gives them; none when git cannot say. */
async function worktreesOf(repo: string): Promise<TerminalPlace[]> {
  try {
    const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: repo, timeout: 3000 });
    return stdout
      .split("\n\n")
      .map((block) => ({ dir: /^worktree (.+)$/m.exec(block)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] }))
      .filter((w): w is { dir: string; branch: string | undefined } => !!w.dir && path.resolve(w.dir) !== path.resolve(repo) && fs.existsSync(w.dir))
      .map((w) => ({ label: w.branch ?? path.basename(w.dir), cwd: w.dir }));
  } catch {
    return [];
  }
}

const fresh = (): Layout => ({ type: "leaf", id: "c1", sessionId: null });

/** Whether a stored value is a layout the window can draw. */
export function isLayout(value: unknown): value is Layout {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string") return false;
  if (v.type === "leaf") return (v.sessionId === null || typeof v.sessionId === "string") && (v.locked === undefined || v.locked === true);
  return v.type === "split" && (v.direction === "row" || v.direction === "column") && typeof v.ratio === "number" && isLayout(v.a) && isLayout(v.b);
}

/** Every cell of a layout in the window's order, empty ones too: the window numbers its cells this way, from 1. */
const cellsIn = (layout: Layout): Extract<Layout, { type: "leaf" }>[] => (layout.type === "leaf" ? [layout] : [...cellsIn(layout.a), ...cellsIn(layout.b)]);

/**
 * Which cell shows each session, by its number: the session or terminal a cell holds, the session a terminal's agent
 * claimed, and every live session on that terminal's pane (one agent working several tickets there).
 */
export function cellNumbers(layout: Layout, terminals: Pick<TerminalRow, "id" | "pane" | "sessionId">[], sessions: Pick<SessionRow, "id" | "pane" | "endedAt">[]): Record<string, number> {
  const out: Record<string, number> = {};
  cellsIn(layout).forEach((cell, i) => {
    if (!cell.sessionId) return;
    out[cell.sessionId] = i + 1;
    const terminal = terminals.find((t) => t.id === cell.sessionId);
    if (terminal?.sessionId) out[terminal.sessionId] = i + 1;
    const pane = terminal?.pane ?? sessions.find((s) => s.id === cell.sessionId)?.pane;
    if (pane) for (const s of sessions) if (s.endedAt === null && s.pane === pane && !(s.id in out)) out[s.id] = i + 1;
  });
  return out;
}

const leafIds = (layout: Layout): string[] => (layout.type === "leaf" ? (layout.sessionId ? [layout.sessionId] : []) : [...leafIds(layout.a), ...leafIds(layout.b)]);

/** The cell of that id in a saved layout, if the layout has it. */
const leafOf = (layout: Layout | undefined, cell: string): Extract<Layout, { type: "leaf" }> | undefined => {
  if (!layout || !isLayout(layout)) return undefined;
  if (layout.type === "leaf") return layout.id === cell ? layout : undefined;
  return leafOf(layout.a, cell) ?? leafOf(layout.b, cell);
};

const emptied = (layout: Layout): Layout => (layout.type === "leaf" ? { type: "leaf", id: layout.id, sessionId: null } : { ...layout, a: emptied(layout.a), b: emptied(layout.b) });

/**
 * The saved state, kept in memory: read once, and again only when something else wrote the file (its time or size
 * moved); every save writes through. `broken`: the file is there but cannot be read — it starts over, and the window says so.
 */
function savedState(file: string | undefined) {
  let held: { stamp: string; saved: Saved; broken: boolean } | null = null;
  const stampOf = (): string | null => {
    try {
      const s = fs.statSync(file!);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  };
  const read = (): { saved: Saved; broken: boolean } => {
    if (!file) return { saved: {}, broken: false };
    const stamp = stampOf() ?? "none";
    if (held?.stamp === stamp) return held;
    let next: { saved: Saved; broken: boolean };
    if (stamp === "none") next = { saved: {}, broken: false };
    else {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        next = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { saved: parsed as Saved, broken: false } : { saved: {}, broken: true };
      } catch {
        next = { saved: {}, broken: true };
      }
    }
    held = { stamp, ...next };
    return held;
  };
  const save = (patch: Saved) => {
    if (!file) return;
    const saved = { ...read().saved, ...patch };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(saved));
      held = { stamp: stampOf() ?? "none", saved, broken: false };
    } catch {
      // The layout comes back as one cell next time; nothing else depends on it.
    }
  };
  return { read, save };
}

/** Terminal apps by `TERM_PROGRAM`: the name the window shows, and the macOS app that brings it forward, where there is one. */
const TERMINAL_APPS: Record<string, { name: string; app?: string }> = {
  "iTerm.app": { name: "iTerm2", app: "iTerm" },
  Apple_Terminal: { name: "Terminal", app: "Terminal" },
  vscode: { name: "VS Code", app: "Visual Studio Code" },
  WarpTerminal: { name: "Warp", app: "Warp" },
  ghostty: { name: "Ghostty", app: "Ghostty" },
  WezTerm: { name: "WezTerm", app: "WezTerm" },
  Hyper: { name: "Hyper", app: "Hyper" },
  Tabby: { name: "Tabby", app: "Tabby" },
  kitty: { name: "kitty", app: "kitty" },
  alacritty: { name: "Alacritty", app: "Alacritty" },
  [WINDOWS_TERMINAL]: { name: "Windows Terminal" },
  mintty: { name: "Git Bash" }
};

/**
 * Where a new terminal opens when herdr cannot show one in a pane (native Windows): Windows Terminal in
 * the folder, or a PowerShell window there when it is not installed. Resolves with the app it opened.
 * That window allows scripts for itself alone: npm's `.ps1` shims (`pnpm.ps1`, …) win over the `.cmd`, and the
 * default policy refuses them.
 */
export function openSystemTerminal(cwd: string, platform: NodeJS.Platform = process.platform, launch: typeof spawn = spawn): Promise<string> {
  if (platform !== "win32") return Promise.reject(new Error(`no system terminal fallback on ${platform}`));
  const start = (command: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = launch(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  return start("wt.exe", ["-d", cwd]).then(
    () => "Windows Terminal",
    () => start("powershell.exe", ["-NoExit", "-ExecutionPolicy", "Bypass"]).then(() => "PowerShell")
  );
}

const isLive = (s: { state: string }) => s.state !== "ended" && s.state !== "lost";
type SessionView = ReturnType<CodeLink["sessionsOf"]>[number];

/** How many of a project's sessions wait on the person: the sidebar's count, without building every row. */
export function needingYou(codeLink: Pick<CodeLink, "sessionsOf">, projectId: string): number {
  return codeLink.sessionsOf(projectId, undefined, { live: true }).filter((s) => isLive(s) && !!s.blocked).length;
}

/** A project's code sessions (`sessions`, else every one code link keeps), live ones first and needs-you before the rest, then the ended ones. */
export function sessionRows(codeLink: Pick<CodeLink, "sessionsOf" | "links">, items: { get(projectId: string, id: string): { key: string; title: string } | null | undefined }, projectId: string, now = Date.now(), device?: string, platform: NodeJS.Platform = process.platform, sessions?: ReturnType<CodeLink["sessionsOf"]>): SessionRow[] {
  const prs = new Map(codeLink.links(projectId).filter((l) => l.prUrl).map((l) => [l.branch, l.prUrl]));
  // Code link keeps every ended session, and many of them name the same ticket.
  const known = new Map<string, { key: string; title: string } | null | undefined>();
  const itemOf = (id: string) => {
    if (!known.has(id)) known.set(id, items.get(projectId, id));
    return known.get(id);
  };
  return (sessions ?? codeLink.sessionsOf(projectId))
    .map((s): SessionRow => {
      const itemId = s.itemIds[0] ?? null;
      const item = itemId ? itemOf(itemId) : null;
      const live = isLive(s);
      const app = s.terminal ? TERMINAL_APPS[s.terminal] : undefined;
      const where = s.mode === "headless" ? "tomrade" : device && s.device && s.device !== device ? "elsewhere" : s.herdrPane ? "herdr" : "outside";
      return {
        id: s.id,
        itemId,
        key: item?.key ?? null,
        title: item?.title ?? null,
        branch: s.branch,
        state: s.state,
        needsYou: live && !!s.blocked,
        activity: s.activity ?? s.summary,
        failedTool: live ? s.failedTool : null,
        ask: live && s.state === "waiting" ? s.ask : null,
        mode: s.mode === "headless" ? "run" : "terminal",
        agent: s.agent,
        agentName: null,
        agentTitle: null,
        conversation: s.title ?? null,
        cwd: s.cwd ?? null,
        prompted: !!s.prompted,
        resumable: !!resumeCommand(s.agent, s.externalId),
        pane: live ? s.herdrPane : null,
        where,
        terminal: app?.name ?? s.terminal ?? null,
        switchable: where === "outside" && !!app?.app && platform === "darwin",
        threadId: s.threadId,
        prUrl: prs.get(s.branch) ?? null,
        worktree: s.worktree,
        startedAt: s.startedAt,
        endedAt: live ? null : (s.endedAt ?? s.lastEventAt ?? s.startedAt),
        continuedIn: null,
        recordSaved: s.recordSavedAt ? (s.recordCut ? "end" : "whole") : null,
        ranIn: s.herdrPane ?? null,
        approval: false,
        prompt: null,
        lastEventAt: s.lastEventAt ?? null,
        rawOutput: false,
        outcome: null,
        tail: null,
        guess: null
      };
    })
    .sort((a, b) => Number(b.state !== "ended" && b.state !== "lost") - Number(a.state !== "ended" && a.state !== "lost") || Number(b.needsYou) - Number(a.needsYou) || b.startedAt - a.startedAt);
}

/** How many earlier sessions a pane's history keeps, newest kept. */
export const PANE_HISTORY_MAX = 20;

/** The ended sessions of each of these panes, oldest first: what ran in a pane before what it shows now. */
export function paneHistory(ended: SessionRow[], panes: (string | null)[]): Record<string, SessionRow[]> {
  const wanted = new Set(panes.filter((p): p is string => !!p));
  const out: Record<string, SessionRow[]> = {};
  for (const s of ended) if (s.ranIn && wanted.has(s.ranIn)) (out[s.ranIn] ??= []).push(s);
  for (const pane of Object.keys(out)) out[pane] = out[pane]!.sort((a, b) => a.startedAt - b.startedAt).slice(-PANE_HISTORY_MAX);
  return out;
}

/**
 * The row an ended session's pane goes on as, when it does: a terminal opened here on it, else the newest live session
 * on it — the agent working another ticket in the same pane. Null once nothing of the window runs there.
 */
export function continuedIn(pane: string | null, sessions: SessionRow[], terminals: TerminalRow[]): string | null {
  if (!pane) return null;
  const terminal = terminals.find((t) => t.pane === pane);
  if (terminal) return terminal.id;
  return sessions.filter((s) => s.endedAt === null && s.pane === pane).sort((a, b) => b.startedAt - a.startedAt)[0]?.id ?? null;
}

/** One open window: its surface, and the terminals its cells show. */
interface Open {
  surface: DesktopSurface;
  terminals: Map<string, TerminalStream>;
  /** Each cell's latest attach or detach: an attach that resolves after a newer one lets its stream go. */
  turns: Map<string, number>;
  /** Cells showing a terminal that ended or never attached: attached again once herdr's server is back. */
  detached: Set<string>;
  /** What was typed into each cell while its terminal attached, sent once it is live; `over` once some did not fit. */
  held: Map<string, { text: string; over: boolean }>;
  /** The poll of herdr's state, while the window can be seen. */
  timer: NodeJS.Timeout | null;
  closed: boolean;
  /** The latest ask to show a session, kept in every state so a window that opens late still sees it. */
  reveal: WindowState["reveal"];
  /** History is open: a change to the conversations is said, so it reads its first page again. */
  history: boolean;
  /** States begun, and the newest one shown: one that finishes after a newer one is not shown. */
  states: { begun: number; shown: number };
  /** The panes of its terminals followed in herdr, so an agent's status there shows as it changes. */
  follows: Map<string, () => void>;
  /** Frames waiting to go to the window, one batch per cell. */
  frames: Map<string, PendingFrames>;
  /** When each cell was last typed into, until its next frame: that frame is the echo, and goes at once. */
  typed: Map<string, number>;
  /** What each attached cell's pane shows, being recorded. */
  recordings: Map<string, Recording>;
  /** The newest live session on each attached cell's pane, as last seen: another one appearing asks the cell for a snapshot. */
  onPane: Map<string, string | null>;
  /** A recording failed and the window was told; the next failure is only logged. */
  warnedRecording: boolean;
  /** Which cell shows each session, as the last state laid them out; what the panel names a session's cell by. */
  cells: Record<string, number>;
  /** The terminals and sessions of the last state, to number the cells again when only the layout changes. */
  shown: { terminals: TerminalRow[]; sessions: PaneSession[] } | null;
  /** The state computed for events: its settle timer and when it is due, one being computed, another asked for meanwhile. */
  soon: { timer: NodeJS.Timeout | null; due: number; running: boolean; again: boolean; urgent: boolean; last: number };
  /** The window says nobody can see it (minimised, hidden, covered): nothing is asked of herdr for it or sent to it, but cells' frames. */
  hidden: boolean;
  /** The last state sent, as JSON: one that comes out the same is not sent again. */
  sent: string | null;
  /** The sessions' standing as the last session event found it: an event that changes it is shown without waiting. */
  standing: string;
}

/** What numbering cells and following new sessions on a pane needs of a session. */
type PaneSession = Pick<SessionRow, "id" | "pane" | "endedAt" | "startedAt">;

/** A pane recorded with no cell on it: herdr's observer stream of it, and the newest session it had when watching began. */
interface Watched {
  stream: TerminalStream | null;
  recording: Recording | null;
  closed: boolean;
  session: string | null;
}

/** A stretch of manual work in a pane, as a cell names it to play it back. */
const MANUAL_ID = /^manual:(\d+):(\d+):(.+)$/;
const manualId = (pane: string, from: number, to: number) => `manual:${from}:${to}:${pane}`;

/** Frames of one cell while its batch is open: the ANSI bytes in order, and the frame that began it. */
interface PendingFrames {
  bytes: Uint8Array[];
  size: number;
  seq: number;
  width: number;
  height: number;
  full: boolean;
  timer: NodeJS.Timeout;
}

/**
 * A window per project for its code sessions: the list with live status, and
 * their terminals side by side — streamed from herdr's panes through core,
 * drawn by the window. Closing a cell or the window lets go of the pane; the
 * agent keeps running in herdr.
 */
function apply(ctx: Context, config: Config) {
  const words = () => CODE_SESSIONS_WORDS(ctx.settings.locale());
  const open = new Map<string, Open>();
  const { read: readState, save } = savedState(config.stateFile);
  const stateOf = (): Saved => readState().saved;

  const projectName = (projectId: string) => (ctx.db.for(projectId).prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? projectId;
  const terminal = () => (ctx.settings.get().codeLink as { terminal?: string } | undefined)?.terminal ?? "auto";

  /** The terminal backend: herdr, or Tomrade's own pty host on native Windows. */
  const backend = () => ctx.get("terminals");
  const builtin = () => backend()?.kind === "builtin";
  // Without a backend on Windows, a new terminal opens in the system terminal; elsewhere herdr is what is missing.
  const bridge = async (): Promise<TerminalBridge> => (await backend()?.bridge()) ?? (process.platform === "win32" ? { state: "unsupported" } : { state: "notInstalled" });

  const recordingSettings = () => RecordingSettings.parse(ctx.settings.get().terminalRecording ?? {});
  /** What the panes show, recorded while a cell shows them and, by the setting, while none does; off by the setting, or without a folder to record in. */
  const recorder = new Recorder({
    dir: config.recordingsDir ?? null,
    settings: recordingSettings,
    warn: (message) => ctx.logger.warn(message)
  });
  ctx.settings.register(RECORDING_SECTION);

  /** What code link guesses a live session on no ticket works on, from what the person first said to it. */
  const guessOf = (projectId: string, r: SessionRow): SessionRow["guess"] => {
    if (r.endedAt !== null || r.itemId) return null;
    const guess = ctx.codeLink.guessOf?.(projectId, r.id);
    return guess ? { key: guess.key, title: guess.title } : null;
  };

  /** The sessions to list (`pick` reads which; every one without it); when they cannot be read the window says so and its terminals work on. */
  const listed = (projectId: string, pick?: () => SessionView[]): { sessions: SessionRow[]; warning: string | null } => {
    try {
      const agents = ctx.get("agent");
      const rows = sessionRows(ctx.codeLink, ctx.items, projectId, Date.now(), ctx.get("hub")?.deviceId, process.platform, pick?.());
      return {
        sessions: rows.map((r) => ({ ...r, agentName: agents?.engineOf(r.agent)?.title ?? null, approval: !!agents?.engineOf(r.agent)?.local?.approval, rawOutput: r.endedAt !== null && !!r.ranIn && recorder.has(r.ranIn, r.startedAt, r.endedAt), guess: guessOf(projectId, r) })),
        warning: null
      };
    } catch (error) {
      ctx.logger.warn(`code sessions: listing sessions failed: ${errorMessage(error)}`);
      return { sessions: [], warning: words()("sessionsUnreadable") };
    }
  };

  /**
   * Each open window's assistant conversations, kept from the last time they changed: a state is built far more often
   * than a conversation moves (every pane event, every poll), and reading the thread list and its questions each time
   * would cost more than the sessions themselves. Dropped when the assistant says something changed, or the window closes.
   */
  const threadsOf = new Map<string, ThreadRow[]>();
  /** Windows whose conversations changed since they were read: read again with the next state, against the rows they had. */
  const staleThreads = new Set<string>();
  const clip = (text: string | null | undefined): string | null => {
    const line = text?.replace(/\s+/g, " ").trim();
    return line ? (line.length > WAIT_TEXT_MAX ? `${line.slice(0, WAIT_TEXT_MAX - 1)}…` : line) : null;
  };
  const threadRows = (projectId: string): ThreadRow[] => {
    const agent = ctx.get("agent");
    if (!agent) return [];
    const was = new Map((threadsOf.get(projectId) ?? []).map((t) => [t.id, t.wait]));
    const now = Date.now();
    try {
      const running = new Set(agent.activeRuns().map((a) => a.thread.id));
      const pending = new Map(agent.activities().flatMap((a) => (a.projectId === projectId && a.pending ? [[a.threadId, a.pending] as const] : [])));
      // Several conversations about one ticket read it once.
      const known = new Map<string, { key: string; title: string } | null | undefined>();
      const itemOf = (id: string) => {
        if (!known.has(id)) known.set(id, ctx.items.get(projectId, id));
        return known.get(id);
      };
      return agent.store.threads(projectId, PANEL_SURFACES).map((th): ThreadRow => {
        const asked = pending.get(th.id);
        const kind = asked ? (asked.kind === "permission" ? "permission" : "question") : null;
        const before = was.get(th.id);
        const item = th.itemId ? itemOf(th.itemId) : null;
        return {
          id: th.id,
          title: th.title,
          engine: th.engine,
          engineName: agent.engineOf(th.engine)?.title ?? null,
          itemId: th.itemId,
          key: item?.key ?? null,
          ticketTitle: item?.title ?? null,
          parentId: th.parentId,
          running: running.has(th.id),
          ticketDone: false,
          wait: kind ? { kind, text: clip(asked?.question.text), since: before?.kind === kind ? before.since : now, questionId: asked?.question.id ?? null, options: asked && !asked.question.multiple && asked.question.options?.length ? asked.question.options : null } : null,
          createdAt: th.createdAt,
          updatedAt: th.updatedAt
        };
      });
    } catch (error) {
      ctx.logger.warn(`code sessions: listing assistant conversations failed: ${errorMessage(error)}`);
      return threadsOf.get(projectId) ?? [];
    }
  };
  const threads = (projectId: string): ThreadRow[] => {
    const rows = threadsOf.get(projectId);
    if (rows && !staleThreads.has(projectId)) return rows;
    staleThreads.delete(projectId);
    const next = threadRows(projectId);
    threadsOf.set(projectId, next);
    return next;
  };
  /** Whether each conversation's ticket is done, read with every state: a ticket finishes without its conversation moving. */
  const ticketsDone = (projectId: string, rows: ThreadRow[]): ThreadRow[] => {
    const done = new Map<string, boolean>();
    const isDone = (id: string) => {
      if (!done.has(id)) done.set(id, ctx.items.get(projectId, id)?.status === "done");
      return done.get(id)!;
    };
    return rows.map((t) => (t.itemId && isDone(t.itemId) !== t.ticketDone ? { ...t, ticketDone: !t.ticketDone } : t));
  };
  /** The project's assistant conversations changed: its window reads them again, once the burst settles. */
  const threadsChanged = (projectId: string) => {
    if (!open.has(projectId)) return;
    staleThreads.add(projectId);
    historyChanged(projectId);
    refreshSoon(projectId, true);
  };

  /**
   * The window's state computed again for events, never two at once: a burst settles first, an event arriving while one
   * is computed is noted and one more follows it. One that changes no session's standing (`urgent` false: an agent's
   * activity, the poll) waits REFRESH_GAP_MS after the last. The person's own actions call `refresh` and go at once.
   */
  const refreshSoon = (projectId: string, urgent: boolean) => {
    const win = open.get(projectId);
    if (!win || win.closed) return;
    const soon = win.soon;
    soon.urgent ||= urgent;
    if (soon.running) {
      soon.again = true;
      return;
    }
    const now = Date.now();
    const wait = soon.urgent ? REFRESH_SETTLE_MS : Math.max(REFRESH_SETTLE_MS, soon.last + REFRESH_GAP_MS - now);
    if (soon.timer) {
      if (soon.due <= now + wait) return;
      clearTimeout(soon.timer);
    }
    soon.due = now + wait;
    soon.timer = setTimeout(() => {
      soon.timer = null;
      soon.urgent = false;
      soon.running = true;
      void refresh(projectId)
        .catch((error: unknown) => ctx.logger.warn(`code sessions: refreshing the window failed: ${errorMessage(error)}`))
        .finally(() => {
          soon.running = false;
          if (!soon.again) return;
          soon.again = false;
          refreshSoon(projectId, false);
        });
    }, wait);
    soon.timer.unref?.();
  };

  /** What a session event may change that the person waits on: which sessions are live, how each stands, where, on which ticket. */
  const standing = (projectId: string): string => {
    try {
      const live = ctx.codeLink.store?.sessions?.(projectId, { live: true }) ?? ctx.codeLink.sessionsOf(projectId);
      return live
        .filter(isLive)
        .map((s) => `${s.id}:${s.state}:${s.blocked ? 1 : 0}:${s.herdrPane ?? ""}:${s.itemIds[0] ?? ""}`)
        .join("|");
    } catch {
      return "";
    }
  };

  /** Who hears each layout a window saves: the `tomrade` command, waiting to say which cell it opened. */
  const laidOut = new Set<(projectId: string, layout: Layout) => void>();

  /** Terminals herdr is still opening, by project: shown as starting, never saved. */
  const pending = new Map<string, Map<string, StartingTerminal>>();
  const savedTerminals = (projectId: string) => stateOf().terminals?.[projectId] ?? [];
  const saveTerminals = (projectId: string, list: SavedTerminal[]) => save({ terminals: { ...stateOf().terminals, [projectId]: list } });

  /** A project's closed terminals with a recording still there to play back. */
  const closedTerminals = (projectId: string): ClosedTerminalRow[] => (stateOf().closed?.[projectId] ?? []).filter((t) => recorder.has(t.pane, t.startedAt, t.endedAt));
  /** A terminal that went: kept for History when its pane was recorded, the oldest making room past CLOSED_TERMINALS_MAX. */
  const rememberClosed = (projectId: string, gone: SavedTerminal[], endedAt = Date.now()) => {
    const kept = gone.filter((t) => recorder.has(t.pane, t.startedAt, endedAt)).map((t): ClosedTerminalRow => ({ id: t.id, title: t.title, cwd: t.cwd, pane: t.pane, startedAt: t.startedAt, endedAt }));
    if (!kept.length) return;
    const saved = stateOf();
    save({ closed: { ...saved.closed, [projectId]: [...(saved.closed?.[projectId] ?? []), ...kept].slice(-CLOSED_TERMINALS_MAX) } });
  };

  /**
   * The project's terminals; one whose pane herdr no longer has is forgotten. While herdr does not answer, they all stay.
   * An agent herdr sees in one lends the terminal the title it gave the conversation.
   */
  const terminals = async (projectId: string): Promise<TerminalRow[]> => {
    const provider = backend();
    // Read together, before herdr is asked: a terminal that finishes opening meanwhile is in one or the other.
    const saved = savedTerminals(projectId);
    const opening = [...(pending.get(projectId)?.values() ?? [])];
    const panes = provider && saved.length ? await provider.panes().catch(() => null) : null;
    const byPane = new Map((panes ?? []).map((p) => [p.paneId, p]));
    const gone = new Set(panes ? saved.filter((t) => !byPane.has(t.pane)).map((t) => t.id) : []);
    // Only those go: the list as it is now, which may have gained a terminal while herdr answered.
    if (gone.size) {
      rememberClosed(projectId, saved.filter((t) => gone.has(t.id)));
      saveTerminals(projectId, savedTerminals(projectId).filter((t) => !gone.has(t.id)));
    }
    const agentTitle = (pane: string | null) => {
      const info = pane ? byPane.get(pane) : undefined;
      return info?.agent ? info.title : null;
    };
    const agentStatus = (pane: string | null): TerminalRow["agentStatus"] => {
      const info = pane ? byPane.get(pane) : undefined;
      return info?.agent && info.status !== "unknown" ? info.status : null;
    };
    // A terminal with no agent goes by what runs in it: its foreground command, else what its shell calls it.
    const running = async (pane: string | null): Promise<{ running: string | null; shell: boolean }> => {
      const info = pane ? byPane.get(pane) : undefined;
      if (!provider || !pane || !info || info.agent) return { running: null, shell: false };
      const fg = await provider.processes(pane).catch(() => []);
      const command = fg.map((p) => p.cmdline?.trim() ?? "").find((c) => c && !SHELL.test(c.split(/\s+/)[0]!));
      return command ? { running: command.slice(0, 80), shell: false } : { running: info.title, shell: true };
    };
    const rows = [...saved.filter((t) => !gone.has(t.id)), ...opening];
    const runs = await Promise.all(rows.map((t) => running(t.pane)));
    return rows.map((t, i) => ({ ...t, agentTitle: agentTitle(t.pane), agentStatus: agentStatus(t.pane), running: runs[i]?.running ?? null, shell: runs[i]?.shell ?? false, sessionId: null, note: null }));
  };

  /**
   * A session with no ticket, in a herdr pane this window did not open, goes by what its agent calls the conversation.
   * One in a terminal opened here needs none: that terminal's row speaks for it.
   */
  const titled = async (sessions: SessionRow[], saved: SavedTerminal[]): Promise<SessionRow[]> => {
    const provider = backend();
    const terminalPanes = new Set(saved.map((t) => t.pane));
    const loose = sessions.filter((s) => !s.itemId && s.pane && !terminalPanes.has(s.pane));
    if (!provider || !loose.length) return sessions;
    const panes = await provider.panes().catch(() => null);
    if (!panes) return sessions;
    const byPane = new Map(panes.map((p) => [p.paneId, p]));
    return sessions.map((s) => {
      const info = loose.includes(s) ? byPane.get(s.pane!) : undefined;
      return info?.agent && info.title ? { ...s, agentTitle: info.title } : s;
    });
  };

  /**
   * A terminal whose agent claimed a ticket shows as that session. Agents with hooks report their pane. For one known
   * only by its MCP connection (Gemini CLI, any MCP client), the pane is taken only when exactly one terminal without
   * a session runs an agent — herdr sees one, or its foreground command names one — inside the session's worktree, or
   * the project's repository when it names none. Anything less certain stays a plain terminal, with a note.
   */
  const fold = async (projectId: string, sessions: SessionRow[], list: TerminalRow[]): Promise<TerminalRow[]> => {
    const claimed = sessions.filter((s) => s.itemId && s.state !== "ended" && s.state !== "lost");
    const owner = (pane: string | null) => (pane ? claimed.filter((s) => s.pane === pane).sort((a, b) => b.startedAt - a.startedAt)[0]?.id ?? null : null);
    const out = list.map((t) => ({ ...t, sessionId: owner(t.pane) }));
    const unplaced = claimed.filter((s) => s.agent === MCP_AGENT && !s.pane);
    const provider = backend();
    if (!unplaced.length || !provider) return out;
    const free = out.filter((t) => t.pane && !t.sessionId);
    const seen = new Map(((await provider.panes().catch(() => null)) ?? []).map((p) => [p.paneId, p]));
    const where = await Promise.all(free.map((t) => agentIn(provider, seen.get(t.pane!), t.pane!, t.cwd)));
    const running = free.flatMap((t, i) => (where[i] ? [{ t, cwd: where[i] }] : []));
    let repos: string[] = [];
    try {
      repos = ctx.codeLink.repositoriesOf(projectId).flatMap((r) => (r.path ? [r.path] : []));
    } catch {
      // No repository to hold it to.
    }
    if (unplaced.length === 1) {
      const s = unplaced[0]!;
      const roots = s.worktree ? [s.worktree] : repos;
      const fits = running.filter((r) => !roots.length || roots.some((root) => within(r.cwd, root)));
      if (fits.length === 1) {
        const only = fits[0]!.t;
        try {
          // A state computed alongside this one may have linked it already.
          if (!sessionOf(projectId, s.id)?.herdrPane) ctx.codeLink.store.patchSession(projectId, s.id, { herdrPane: only.pane! });
        } catch (error) {
          ctx.logger.warn(`code sessions: could not link a claim to its terminal: ${errorMessage(error)}`);
        }
        return out.map((t) => (t === only ? { ...t, sessionId: s.id } : t));
      }
    }
    const note = words()("unmatched");
    return out.map((t) => (running.some((r) => r.t === t) ? { ...t, note } : t));
  };

  /** The project's repositories on this machine and their worktrees; the home folder when it has none here. */
  const places = async (projectId: string): Promise<TerminalPlace[]> => {
    let repos: { name: string; path: string | null }[] = [];
    try {
      repos = ctx.codeLink.repositoryFoldersOf(projectId);
    } catch {
      // No repository to read: the home folder will do.
    }
    const found: TerminalPlace[] = [];
    for (const repo of repos) {
      if (!repo.path || found.some((p) => p.cwd === repo.path)) continue;
      found.push({ label: repo.name, cwd: repo.path });
    }
    for (const repo of repos) {
      if (!repo.path) continue;
      for (const place of await worktreesOf(repo.path)) {
        if (!found.some((p) => p.cwd === place.cwd)) found.push(place);
      }
    }
    return found.length ? found : [{ label: "~", cwd: os.homedir() }];
  };

  /** herdr's server being started again for the windows, and whether the last start did not work (then only the person's retry tries again). */
  let reviving: Promise<void> | null = null;
  let reviveFailed = false;
  /** The pty host's pipe refused this app when last read: once it lets the app in, the cells cut off attach again. */
  let shutOut = false;

  /** A window with saved terminals, or sessions that run or lately ran in herdr, has panes to bring back. */
  const wantsHerdr = (projectId: string, sessions: SessionRow[]) =>
    savedTerminals(projectId).length > 0 || sessions.some((s) => s.where === "herdr" && (s.endedAt === null || Date.now() - s.endedAt < RECENTLY_ENDED_MS));

  const serverGone = async () => (await backend()?.serverGone().catch(() => false)) ?? false;

  /**
   * Start herdr's server again, once for every window: herdr brings back its panes with their ids and resumes their
   * agents, and the cells cut off attach again. herdr's own limit keeps a server that keeps dying from being started
   * over and over; Tomrade never stops it.
   */
  const revive = (force = false) => {
    const provider = backend();
    if (!provider || reviving || (!force && reviveFailed)) return;
    reviving = (async () => {
      const result = await provider.revive(force).catch(() => "failed" as const);
      reviveFailed = result === "failed" || result === "held";
      if (result === "failed" || result === "held") ctx.logger.warn(`code sessions: the terminal backend did not come back (${result})`);
      if (result !== "started" && result !== "running") return;
      for (const win of open.values()) {
        // A started server means every old stream is gone, a frozen one too.
        const cells = new Set([...win.detached, ...(result === "started" ? win.terminals.keys() : [])]);
        win.detached.clear();
        for (const cell of cells) post(win, { type: "reattach", cell });
      }
    })().finally(() => {
      reviving = null;
      void refreshAll();
    });
    void refreshAll();
  };

  /**
   * What each waiting session's screen asks, read only for those whose agent declared its keys: a prompt seen stays
   * known until the session's next event, none is looked for again at most every PROMPT_RECHECK_MS.
   */
  const prompts = new Map<string, { at: number; event: number | null; prompt: SessionRow["prompt"] }>();
  const withPrompts = async (rows: SessionRow[]): Promise<SessionRow[]> => {
    const provider = backend();
    const now = Date.now();
    return Promise.all(
      rows.map(async (r) => {
        if (!provider || !r.approval || r.endedAt !== null || !r.pane || r.state !== "waiting" || r.ask?.kind !== "permission") {
          prompts.delete(r.id);
          return r;
        }
        const known = prompts.get(r.id);
        if (known && known.event === r.lastEventAt && (known.prompt || now - known.at < PROMPT_RECHECK_MS)) return { ...r, prompt: known.prompt };
        const seen = promptOnScreen((await provider.readTail(r.pane, PROMPT_LINES).catch(() => null)) ?? "");
        const prompt = seen ? (seen.allows ? "allow" : "deny") : null;
        prompts.set(r.id, { at: now, event: r.lastEventAt, prompt });
        return { ...r, prompt };
      })
    );
  };

  /** The agent a ticket started here runs, as Start picks it: the one last started with, else the first that runs in a terminal. */
  const startEngine = (): { id: string; title: string; options?: Record<string, unknown> } | null => {
    try {
      const engines = (ctx.get("agent")?.codeEngines() ?? []).filter((e) => e.terminal?.mode !== "none");
      const remembered = ctx.codeLink.startDefaults();
      const engine = engines.find((e) => e.id === remembered?.engine) ?? engines[0];
      if (!engine) return null;
      return { id: engine.id, title: engine.title, ...(remembered?.engine === engine.id && remembered.options ? { options: remembered.options } : {}) };
    } catch (error) {
      // only names the agent ⌘K starts tickets with: a window without it still lists and shows everything else
      ctx.logger.warn(`code sessions: the agent to start with could not be read: ${errorMessage(error)}`);
      return null;
    }
  };
  /** What ⌘K can start: the project's open tickets, the latest changed first. */
  const openTickets = (projectId: string): TicketRow[] =>
    ctx.items
      .list({ projectId })
      .filter((i) => i.kind === "ticket" && OPEN_TICKET.has(i.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, TICKETS_LISTED)
      .map((i) => ({ id: i.id, key: i.key, title: i.title, status: i.status }));

  /** The project's layout as saved, else the default preset's, else one cell; and the presets that are layouts. */
  const layoutOf = (saved: Saved, projectId: string) => {
    const remembered = saved.layouts?.[projectId];
    const presets = (saved.presets ?? []).filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && isLayout(p.layout));
    const preset = presets.find((p) => p.id === saved.defaultPreset);
    return { remembered, presets, preset, layout: isLayout(remembered) ? remembered : preset ? preset.layout : fresh() };
  };

  const state = async (projectId: string): Promise<WindowState> => {
    const b = await bridge();
    const setting = terminal();
    const { saved, broken } = readState();
    const { remembered, presets, preset, layout } = layoutOf(saved, projectId);
    // An ended session stays with the state while a cell shows it; the rest wait in History.
    const inCells = new Set(leafIds(layout));
    const win = open.get(projectId);
    // Only the sessions a state uses are read: the ended ones code link keeps grow by the day.
    const shown = listed(projectId, () => shownSessions(projectId, [...inCells, ...(win?.reveal?.sessionId ? [win.reveal.sessionId] : [])]));
    if (b.state === "ready") reviveFailed = false;
    if ((b.state === "notRunning" && wantsHerdr(projectId, shown.sessions)) || (b.state === "ready" && shutOut)) revive();
    shutOut = b.state === "forbidden";
    // after the start is decided: the bridge read above must not go stale across this await
    if (b.state === "ready") shown.sessions = await withPrompts(shown.sessions);
    const warning = [shown.warning, broken || (remembered !== undefined && !isLayout(remembered)) ? words()("stateUnreadable") : null].filter(Boolean).join(" · ") || null;
    // Ticket work, and conversations someone had; a start nobody spoke to is not kept.
    const ended = shown.sessions.filter((s) => s.endedAt !== null && (s.itemId || s.conversation || s.prompted));
    // What ended lately stays in the bar's ended group for a day, as in the assistant panel, cell or no cell.
    const recent = new Set(ended.filter((s) => Date.now() - s.endedAt! < RECENT_ENDED_MS).sort((a, b) => b.endedAt! - a.endedAt!).slice(0, RECENT_ENDED_MAX).map((s) => s.id));
    const listedNow = await titled(shown.sessions.filter((s) => s.endedAt === null || inCells.has(s.id) || recent.has(s.id) || s.id === win?.reveal?.sessionId), savedTerminals(projectId));
    const endedIds = listedNow.flatMap((s) => (s.endedAt !== null ? [s.id] : []));
    const outcomes = endedIds.length ? ctx.codeLink.sessionOutcomes(projectId, endedIds) : null;
    // A card's last lines of its pane, from the glance the assistant panel's cards share: read on a session's events, not per card.
    const paned = b.state === "ready" ? listedNow.flatMap((s) => (s.endedAt === null && s.pane ? [s.id] : [])) : [];
    const glances = paned.length ? await ctx.codeLink.sessionGlances(projectId, paned).catch(() => null) : null;
    const sent = listedNow.map((s) => {
      const outcome = outcomes?.get(s.id);
      const tail = glances?.get(s.id)?.tail;
      return outcome || tail ? { ...s, ...(outcome ? { outcome } : {}), ...(tail ? { tail } : {}) } : s;
    });
    const opened = await fold(projectId, shown.sessions, await terminals(projectId));
    // What ran before in the panes now open, also when it ended longer ago than the sessions read above.
    const panes = [...opened.map((t) => t.pane), ...sent.map((r) => r.pane)];
    const before = new Set(ended.map((s) => s.id));
    const earlier = listed(projectId, () => ctx.codeLink.sessionsOf(projectId, undefined, { panes: panes.filter((p): p is string => !!p) }))
      .sessions.filter((s) => !before.has(s.id) && s.endedAt !== null && (s.itemId || s.conversation || s.prompted));
    return {
      projectId,
      projectName: projectName(projectId),
      locale: ctx.settings.locale(),
      keybindings: (ctx.settings.get().keybindings as { overrides?: Record<string, string[]> } | undefined)?.overrides ?? {},
      bridge: b,
      provider: backend()?.kind ?? null,
      herdrClient: b.state === "ready" && !builtin() && ((await ctx.get("herdr")?.clientAttached().catch(() => false)) ?? false),
      revive: reviving ? "starting" : reviveFailed && b.state === "notRunning" ? "failed" : null,
      install: b.state === "notInstalled" && !builtin() ? await ctx.codeLink.herdrInstall() : null,
      // "auto" lands in the panes once they can open; only a terminal named otherwise keeps sessions out of them.
      askSwitch: setting !== "auto" && !panesOf(setting) && !saved.asked && !!backend(),
      terminal: setting,
      // An ended one asked for from outside (a ticket's earlier session) comes along, so the window can put it in a cell.
      // An ended one a cell shows says where its pane goes on, so the cell can follow it there.
      sessions: sent.map((s) => (s.endedAt !== null && inCells.has(s.id) ? { ...s, continuedIn: continuedIn(sessionOf(projectId, s.id)?.herdrPane ?? null, shown.sessions, opened) } : s)),
      threads: ticketsDone(projectId, threads(projectId)),
      warning,
      terminals: opened,
      places: await places(projectId),
      layout,
      presets,
      defaultPreset: preset?.id ?? null,
      autoPlace: saved.autoPlace !== false,
      reveal: win?.reveal ?? null,
      closedTerminals: closedTerminals(projectId).filter((t) => inCells.has(t.id)),
      history: paneHistory([...ended, ...earlier], panes),
      folded: saved.folded?.[projectId] === true,
      overviewAll: saved.overviewAll?.[projectId] === true,
      tickets: openTickets(projectId),
      startAgent: startEngine()?.title ?? null
    };
  };

  /**
   * The sessions a state reads, newest first as code link keeps them: every live one; those that ended within a day
   * (the bar's ended group, and whether herdr is wanted); and those a cell or a reveal shows. The ended ones of the
   * panes now open are read once those are known; every other ended session waits in History.
   */
  const shownSessions = (projectId: string, ids: string[]): SessionView[] => {
    const read = (filter: Parameters<CodeLink["sessionsOf"]>[2]) => ctx.codeLink.sessionsOf(projectId, undefined, filter);
    const since = Date.now() - Math.max(RECENT_ENDED_MS, RECENTLY_ENDED_MS);
    const all = new Map<string, SessionView>();
    for (const s of [...read({ live: true }), ...read({ endedSince: since }), ...read({ ids })]) all.set(s.id, s);
    return [...all.values()].sort((a, b) => b.startedAt - a.startedAt);
  };

  /** Follow the panes of the terminals a window shows, and only those; one herdr stopped following is followed afresh. */
  const follow = (win: Open, list: TerminalRow[]) => {
    const provider = backend();
    const wanted = new Set(win.closed || !provider ? [] : list.flatMap((t) => (t.pane ? [t.pane] : [])));
    for (const [pane, release] of win.follows) {
      if (wanted.has(pane)) continue;
      release();
      win.follows.delete(pane);
    }
    if (!provider) return;
    const watching = new Set(provider.watching());
    for (const pane of wanted) if (!win.follows.has(pane) || !watching.has(pane)) win.follows.set(pane, provider.watch(pane));
  };

  const refresh = async (projectId: string) => {
    watchSoon();
    const win = open.get(projectId);
    if (!win || win.closed || !win.surface) return;
    if (win.hidden) return unseen(projectId, win);
    const turn = ++win.states.begun;
    win.soon.last = Date.now();
    const next = await state(projectId);
    if (win.closed || turn < win.states.shown) return;
    win.states.shown = turn;
    follow(win, next.terminals);
    win.shown = { terminals: next.terminals, sessions: next.sessions };
    renumber(projectId, win, next.layout);
    // Hidden meanwhile: it is computed again when shown.
    const sent = win.hidden ? null : JSON.stringify(next);
    if (sent !== null && sent !== win.sent) {
      win.sent = sent;
      win.surface.setState(next);
    }
    snapshotNewSessions(win, next.sessions);
  };

  /**
   * A refresh while nobody can see the window: herdr is not asked and the window hears nothing. The cells are numbered
   * again for the panel, and a session beginning on a cell's pane still marks its recording, from code link alone.
   */
  const unseen = (projectId: string, win: Open) => {
    // Numbering reads the cells' own sessions and the live ones on their panes; a new session is a live one.
    const layout = layoutOf(stateOf(), projectId).layout;
    const ids = layout ? leafIds(layout) : [];
    const read = new Map([...ctx.codeLink.sessionsOf(projectId, undefined, { live: true }), ...ctx.codeLink.sessionsOf(projectId, undefined, { ids })].map((s) => [s.id, s]));
    const sessions = [...read.values()].sort((a, b) => b.startedAt - a.startedAt).map((s): PaneSession => ({ id: s.id, pane: isLive(s) ? s.herdrPane : null, endedAt: isLive(s) ? null : (s.endedAt ?? s.lastEventAt ?? s.startedAt), startedAt: s.startedAt }));
    win.shown = { terminals: win.shown?.terminals ?? [], sessions };
    renumber(projectId, win, layout);
    snapshotNewSessions(win, sessions);
  };

  /** The cells numbered again for a layout; the panel hears of it only when a session's cell changed. Before the first state, by what the cells hold. */
  const renumber = (projectId: string, win: Open, layout: Layout | null) => {
    const cells = layout && !win.closed ? cellNumbers(layout, win.shown?.terminals ?? [], win.shown?.sessions ?? []) : {};
    const same = Object.keys(cells).length === Object.keys(win.cells).length && Object.entries(cells).every(([id, n]) => win.cells[id] === n);
    win.cells = cells;
    if (!same) ctx.codeLink.cellsChanged(projectId);
  };

  /** The newest live session on a pane, by when it started; null with none. */
  const newestOn = (sessions: { id: string; endedAt: number | null; pane: string | null; startedAt: number }[], pane: string): string | null => sessions.filter((s) => s.endedAt === null && s.pane === pane).sort((a, b) => b.startedAt - a.startedAt)[0]?.id ?? null;

  /**
   * A session beginning on a pane a cell shows (another agent, or the same one again): the recording asks the cell
   * for its screen, so the session's replay can begin there rather than catch up from where the cell attached.
   */
  const snapshotNewSessions = (win: Open, sessions: PaneSession[]) => {
    for (const [cell, stream] of win.terminals) {
      const id = newestOn(sessions, stream.paneId);
      const before = win.onPane.get(cell);
      win.onPane.set(cell, id);
      if (id && before !== undefined && before !== id) requestSnapshot(win, cell);
    }
  };

  const requestSnapshot = (win: Open, cell: string) => {
    const recording = win.recordings.get(cell);
    if (!recording || recording.closed || win.closed) return;
    post(win, { type: "snapshot", cell, token: recording.hold() });
  };

  const stopRecording = (win: Open, cell: string) => {
    win.recordings.get(cell)?.close();
    win.recordings.delete(cell);
    win.onPane.delete(cell);
    // The pane may go on in the background.
    watchSoon();
  };

  /**
   * Panes no cell shows are recorded too, through herdr's observer stream: it watches beside whoever holds the pane and
   * never takes it over or resizes it (TOM-412). One observer per pane of a live session on this machine or a terminal
   * the window opened, while no cell attaches it: a cell attaching takes over, and the observer comes back once the cell
   * lets go. Each is a `herdr terminal session observe` process; herdr sends it what changed on the screen, not every
   * byte, so a busy pane costs little more than an idle one.
   */
  const background = new Map<string, Watched>();
  /** Panes whose observer would not open, and when: not tried again before BACKGROUND_RETRY_MS. */
  const unwatchable = new Map<string, number>();
  /** The size each pane was last attached at here: a controller's size stays with the pane after it leaves. */
  const sizes = new Map<string, { cols: number; rows: number }>(Object.entries(stateOf().sizes ?? {}));
  const keepSize = (pane: string) => {
    const size = sizes.get(pane);
    if (!size) return;
    const kept = Object.entries({ ...stateOf().sizes, [pane]: size }).slice(-SIZES_MAX);
    save({ sizes: Object.fromEntries(kept) });
  };

  /** The panes to record with no cell on them, each with the newest live session in it: a new one there begins a new stretch. */
  const watchable = (): Map<string, string | null> => {
    const device = ctx.get("hub")?.deviceId;
    const out = new Map<string, { id: string | null; at: number }>();
    let projects: string[] = [];
    try {
      projects = ctx.db.openIds();
    } catch {
      // no project open: only the terminals
    }
    for (const projectId of projects) {
      let live: { id: string; herdrPane: string | null; device: string | null; startedAt: number; state: string }[] = [];
      try {
        live = ctx.codeLink.store?.sessions?.(projectId, { live: true }) ?? ctx.codeLink.sessionsOf(projectId);
      } catch {
        continue;
      }
      for (const s of live) {
        if (!isLive(s) || !s.herdrPane || (device && s.device && s.device !== device)) continue;
        const known = out.get(s.herdrPane);
        if (!known || known.at < s.startedAt) out.set(s.herdrPane, { id: s.id, at: s.startedAt });
      }
    }
    for (const list of Object.values(stateOf().terminals ?? {})) for (const t of list) if (!out.has(t.pane)) out.set(t.pane, { id: null, at: 0 });
    return new Map([...out].map(([pane, s]) => [pane, s.id]));
  };

  /** The size a pane is: as it was last attached here, else the rectangle herdr lays it out in. */
  const sizeOf = async (pane: string): Promise<{ cols: number; rows: number }> => {
    const known = sizes.get(pane);
    if (known) return known;
    try {
      const { layout } = (await ctx.get("herdr")?.call<{ layout: { panes: { pane_id: string; rect: { width: number; height: number } }[] } }>("pane.layout", { pane_id: pane })) ?? { layout: { panes: [] } };
      const rect = layout.panes.find((p) => p.pane_id === pane)?.rect;
      if (rect?.width && rect.height) return { cols: rect.width, rows: rect.height };
    } catch {
      // herdr's own default
    }
    return DEFAULT_SIZE;
  };

  const watch = async (pane: string, session: string | null) => {
    const provider = backend();
    if (!provider) return;
    const watched: Watched = { stream: null, recording: null, closed: false, session };
    background.set(pane, watched);
    let stream: TerminalStream;
    try {
      stream = await provider.terminal(pane, { mode: "observe", ...(await sizeOf(pane)) });
    } catch (error) {
      if (background.get(pane) === watched) background.delete(pane);
      unwatchable.set(pane, Date.now());
      ctx.logger.debug(`code sessions: pane ${pane} cannot be watched: ${errorMessage(error)}`);
      return;
    }
    if (watched.closed || background.get(pane) !== watched) return stream.close();
    const recording = recorder.open(pane, {
      // A stretch past SEGMENT_MAX: watched afresh, so the next stretch begins with the whole screen.
      needKeyframe: () => {
        if (background.get(pane) !== watched) return;
        unwatch(pane);
        void watch(pane, session);
      },
      warn: (reason) => ctx.logger.warn(`code sessions: recording pane ${pane} in the background failed: ${reason}`)
    });
    if (!recording) {
      background.delete(pane);
      return stream.close();
    }
    watched.stream = stream;
    watched.recording = recording;
    stream.onFrame((frame) => recording.write(frame));
    stream.onClose(() => {
      recording.close();
      if (background.get(pane) !== watched) return;
      background.delete(pane);
      unwatchable.set(pane, Date.now());
      watchSoon();
    });
  };

  const unwatch = (pane: string) => {
    const watched = background.get(pane);
    if (!watched) return;
    background.delete(pane);
    watched.closed = true;
    watched.recording?.close();
    watched.stream?.close();
  };

  /** Every pane that should be recorded with no cell on it is, and no other: herdr only, and while the settings say so. */
  const rewatch = async () => {
    const provider = backend();
    const settings = recordingSettings();
    const on = recorder.enabled() && settings.background && provider?.kind === "herdr" && !disposed && (await bridge()).state === "ready";
    const wanted = on ? watchable() : new Map<string, string | null>();
    for (const win of open.values()) for (const stream of win.terminals.values()) wanted.delete(stream.paneId);
    for (const pane of [...background.keys()]) if (!wanted.has(pane)) unwatch(pane);
    for (const [pane, session] of wanted) {
      const watched = background.get(pane);
      // A session beginning there: watched afresh, so its stretch begins with the whole screen.
      if (watched && session && watched.session !== session) unwatch(pane);
      if (!background.has(pane) && Date.now() - (unwatchable.get(pane) ?? 0) > BACKGROUND_RETRY_MS) void watch(pane, session);
    }
  };
  let watchTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  const watchSoon = () => {
    if (watchTimer || disposed) return;
    watchTimer = setTimeout(() => {
      watchTimer = null;
      void rewatch().catch((error: unknown) => ctx.logger.warn(`code sessions: background recording: ${errorMessage(error)}`));
    }, BACKGROUND_SETTLE_MS);
    watchTimer.unref?.();
  };

  // Presets and the auto-place switch belong to every project's window.
  const refreshAll = async () => {
    await Promise.all([...open.keys()].map((projectId) => refresh(projectId)));
  };

  const send = (win: Open, message: WindowPost) => {
    if (!win.closed) win.surface.post(message);
  };

  /**
   * A batch on its way: its bytes joined in the order the pane painted them, under the first frame's
   * paint (`full`) and the last frame's place. Nothing between the two is dropped, so the screen the
   * window ends up with is the one the pane painted.
   */
  const flushFrames = (win: Open, cell: string) => {
    const pending = win.frames.get(cell);
    if (!pending) return;
    win.frames.delete(cell);
    clearTimeout(pending.timer);
    if (!pending.size) return;
    const bytes = pending.bytes.length === 1 ? pending.bytes[0]! : Buffer.concat(pending.bytes, pending.size);
    send(win, { type: "frame", cell, seq: pending.seq, width: pending.width, height: pending.height, full: pending.full, bytes });
    // The same batch, after the window has it: the recording queues it for the disk and never waits on it.
    win.recordings.get(cell)?.write({ seq: pending.seq, width: pending.width, height: pending.height, full: pending.full, bytes });
  };

  /** Everything waiting goes, in cell order, before a message that is not a frame. */
  const flushFramesOf = (win: Open) => {
    for (const cell of [...win.frames.keys()]) flushFrames(win, cell);
  };

  /** A cell's batch is let go without being drawn: its stream is going, and a new one paints afresh. */
  const dropFrames = (win: Open, cell: string) => {
    const pending = win.frames.get(cell);
    if (!pending) return;
    win.frames.delete(cell);
    clearTimeout(pending.timer);
  };

  const dropFramesOf = (win: Open) => {
    for (const cell of [...win.frames.keys()]) dropFrames(win, cell);
  };

  const post = (win: Open, message: WindowPost) => {
    if (win.closed) return;
    // Whatever else the window hears comes after the bytes already painted, never before them.
    if (message.type !== "frame") flushFramesOf(win);
    send(win, message);
  };

  /**
   * What goes with a page of History or a search's finds: the window's rows for the coding sessions among them, so
   * one picked goes into a cell as an ended session; and the agents' names, which the panel's rows carry only by id.
   */
  const historyRows = (projectId: string, rows: ReviewRow[]): { sessions: SessionRow[]; agents: Record<string, string> } => {
    const wanted = new Set(rows.filter((r) => r.kind === "session").map((r) => r.id));
    const sessions = wanted.size ? listed(projectId, () => ctx.codeLink.sessionsOf(projectId, undefined, { ids: [...wanted] })).sessions.filter((s) => wanted.has(s.id)) : [];
    const engines = ctx.get("agent");
    const agents: Record<string, string> = {};
    for (const r of rows) {
      const title = engines?.engineOf(r.agent)?.title;
      if (title) agents[r.agent] = title;
    }
    return { sessions, agents };
  };
  /** A session ended, or a conversation moved, while a window has History open: it reads its first page again. */
  const historyChanged = (projectId: string) => {
    const win = open.get(projectId);
    if (win && !win.closed && win.surface && win.history) post(win, { type: "historyChanged" });
  };

  /**
   * One frame joins its cell's batch. A pane can paint faster than a screen shows — a burst of frames
   * becomes one message, its bytes unchanged and in order. The built-in host paces its paints itself (slower in a flood):
   * its frames are `paced` and go at once, since a batch would only hold each one back a frame (TOM-841).
   */
  const pushFrame = (win: Open, cell: string, frame: { seq: number; width: number; height: number; full: boolean; bytes: Uint8Array }, paced = false) => {
    if (win.closed || !frame.bytes.length) return;
    const pending = win.frames.get(cell);
    // Another size paints a screen the open batch no longer fits: what waits goes first.
    if (pending && (pending.width !== frame.width || pending.height !== frame.height)) flushFrames(win, cell);
    const batch = win.frames.get(cell);
    if (!batch) {
      const typedAt = win.typed.get(cell);
      win.typed.delete(cell);
      const timer = setTimeout(() => flushFrames(win, cell), FRAME_BATCH_MS);
      timer.unref?.();
      win.frames.set(cell, { bytes: [frame.bytes], size: frame.bytes.length, seq: frame.seq, width: frame.width, height: frame.height, full: frame.full, timer });
      // The first frame after a keystroke goes at once: herdr may already have held it for its next paint (other panes
      // watched in the background keep it painting), and a batch on top of that is felt as lag (TOM-713).
      if (paced || (typedAt !== undefined && Date.now() - typedAt <= ECHO_MS)) flushFrames(win, cell);
      return;
    }
    batch.bytes.push(frame.bytes);
    batch.size += frame.bytes.length;
    batch.seq = frame.seq;
    if (batch.size >= FRAME_BATCH_MAX) flushFrames(win, cell);
  };

  /** What a session goes by in a toast: its ticket, else its conversation's title, else its agent. */
  const nameOf = (projectId: string, id: string): string => {
    const s = sessionOf(projectId, id);
    const itemId = s?.itemIds[0];
    return (itemId ? ctx.items.get(projectId, itemId)?.key : null) ?? s?.title ?? s?.agent ?? id;
  };
  const sessionOf = (projectId: string, id: string) => ctx.codeLink.sessionsOf(projectId, undefined, { ids: [id] }).find((s) => s.id === id);

  const turn = (win: Open, cell: string) => {
    const next = (win.turns.get(cell) ?? 0) + 1;
    win.turns.set(cell, next);
    return next;
  };

  const detach = (win: Open, cell: string) => {
    turn(win, cell);
    win.detached.delete(cell);
    // Its stream is going: what it painted and has not sent belongs to a screen that is being replaced.
    dropFrames(win, cell);
    stopRecording(win, cell);
    const stream = win.terminals.get(cell);
    win.terminals.delete(cell);
    stream?.close();
    if (stream) keepSize(stream.paneId);
  };

  /** The herdr pane a cell's id stands for: a session's, or a terminal's. */
  const paneOf = (projectId: string, id: string): string | undefined => sessionOf(projectId, id)?.herdrPane ?? savedTerminals(projectId).find((t) => t.id === id)?.pane;

  /** Typing a cell held for a terminal that will not come: said, never dropped without a word. */
  const letGoHeld = (win: Open, cell: string) => {
    const held = win.held.get(cell);
    win.held.delete(cell);
    if (held?.text || held?.over) post(win, { type: "toast", text: words()("notSent") });
  };

  const attach = async (projectId: string, win: Open, cell: string, sessionId: string, cols: number, rows: number) => {
    detach(win, cell);
    const mine = turn(win, cell);
    const pane = paneOf(projectId, sessionId);
    const provider = backend();
    if (!pane || !provider) return post(win, { type: "closed", cell, reason: words()("noTerminal") });
    const restarting = words()(provider.kind === "builtin" ? "hostRestarting" : "herdrRestarting");
    // One pane, one cell: a second attach would take it over and knock the other cell off. A cell the saved layout no
    // longer shows it in is a move, and lets go.
    const other = [...win.terminals].find(([c, stream]) => c !== cell && stream.paneId === pane)?.[0];
    if (other) {
      const still = leafOf(stateOf().layouts?.[projectId], other)?.sessionId;
      if (still && paneOf(projectId, still) === pane) return post(win, { type: "shownIn", cell, other });
      detach(win, other);
    }
    // Typing while herdr attaches waits for the terminal; a newer attach of the cell takes it over.
    if (!win.held.has(cell)) win.held.set(cell, { text: "", over: false });
    let stream: TerminalStream;
    try {
      stream = await provider.terminal(pane, { cols, rows });
    } catch (error) {
      if (win.turns.get(cell) !== mine) return;
      letGoHeld(win, cell);
      win.detached.add(cell);
      if ((error as { code?: unknown } | null)?.code === "notRunning") {
        post(win, { type: "closed", cell, reason: restarting });
        return revive();
      }
      // Starting another host would not help: the one holding the pipe stays until someone ends it.
      if ((error as { code?: unknown } | null)?.code === "forbidden") return post(win, { type: "closed", cell, reason: words()("hostForbidden") });
      // The pty host names a pane it no longer has; herdr's own words come as they are.
      return post(win, { type: "closed", cell, reason: (error as { code?: unknown } | null)?.code === "pane_not_found" ? words()("paneEnded") : errorMessage(error) });
    }
    if (win.closed || win.turns.get(cell) !== mine) return stream.close();
    sizes.set(pane, { cols, rows });
    win.terminals.set(cell, stream);
    win.detached.delete(cell);
    const held = win.held.get(cell);
    win.held.delete(cell);
    if (held?.text) stream.input(held.text);
    if (held?.over) post(win, { type: "toast", text: words()("notSent") });
    record(projectId, win, cell, pane);
    const paced = provider.kind === "builtin";
    stream.onFrame((f) => pushFrame(win, cell, f, paced));
    stream.onClose(provider.onScroll(pane, (s) => win.terminals.get(cell) === stream && post(win, { type: "scrolled", cell, ...s })));
    stream.onClose((reason) => {
      if (win.terminals.get(cell) !== stream) return;
      stopRecording(win, cell);
      win.terminals.delete(cell);
      win.detached.add(cell);
      // The server going away is not the pane ending: it is started again and the cell comes back on its own.
      void serverGone().then((gone) => {
        if (win.turns.get(cell) !== mine) return;
        post(win, { type: "closed", cell, reason: gone ? restarting : provider.kind !== "builtin" ? reason : reason === "exited" ? words()("paneEnded") : reason === "taken_over" ? words()("takenOver") : reason });
        if (gone) revive();
      });
    });
  };

  /** The cell's stream recorded from its first frame; a failure is said once per window and leaves the cell as it is. */
  const record = (projectId: string, win: Open, cell: string, pane: string) => {
    // The cell records it now: the observer goes, so one pane is never written twice.
    unwatch(pane);
    const recording = recorder.open(pane, {
      needKeyframe: () => requestSnapshot(win, cell),
      warn: (reason) => {
        ctx.logger.warn(`code sessions: recording pane ${pane} failed: ${reason}`);
        if (win.warnedRecording) return;
        win.warnedRecording = true;
        post(win, { type: "toast", text: words()("recordingFailed", { reason }) });
      }
    });
    if (!recording) return;
    win.recordings.set(cell, recording);
    // Whatever runs there now is not new: only a session beginning after this asks for a snapshot.
    win.onPane.set(cell, newestOn(ctx.codeLink.sessionsOf(projectId, undefined, { live: true }).map((s) => ({ id: s.id, endedAt: isLive(s) ? null : (s.endedAt ?? 0), pane: s.herdrPane, startedAt: s.startedAt })), pane));
  };

  /**
   * The stretch of its pane's recording a session or a closed terminal plays back: the session's, between when its
   * hooks said it started and ended, cut short where the next session on the pane began (an end reported late must
   * not take the next agent's output along).
   */
  const replayBounds = (projectId: string, id: string): { pane: string; from: number; to: number } | null => {
    const manual = MANUAL_ID.exec(id);
    if (manual) return { pane: manual[3]!, from: Number(manual[1]), to: Number(manual[2]) };
    const closed = closedTerminals(projectId).find((t) => t.id === id);
    if (closed) return { pane: closed.pane, from: closed.startedAt, to: closed.endedAt };
    const s = sessionOf(projectId, id);
    if (!s?.herdrPane) return null;
    const pane = s.herdrPane;
    const next = ctx.codeLink
      .sessionsOf(projectId, undefined, { panes: [pane] })
      .filter((o) => o.id !== s.id && o.herdrPane === pane && o.startedAt > s.startedAt)
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    const ended = isLive(s) ? Date.now() : (s.endedAt ?? s.lastEventAt ?? Date.now());
    return { pane, from: s.startedAt, to: next ? Math.min(ended, next.startedAt) : ended };
  };

  const replay = async (projectId: string, win: Open, cell: string, id: string) => {
    const bounds = replayBounds(projectId, id);
    const slice = bounds ? await recorder.slice(bounds.pane, bounds.from, bounds.to) : { records: [], at: 0, cut: false, clean: false };
    post(win, { type: "replay", cell, id, ...slice, from: bounds?.from ?? 0, to: bounds?.to ?? 0, keep: keeping() });
  };

  /** How long and how much of each pane the recordings are kept, for the words beside a replay. */
  const keeping = () => {
    const settings = recordingSettings();
    return { days: settings.keepDays, mb: settings.maxPaneMB };
  };

  /** A pane's history from early to late: the sessions that ran in it, and the manual work between them as it was recorded. */
  const timeline = async (projectId: string, pane: string): Promise<TimelineEntry[]> => {
    const rows = listed(projectId, () => ctx.codeLink.sessionsOf(projectId, undefined, { panes: [pane] })).sessions.filter((s) => s.ranIn === pane);
    const manual = manualStretches(await recorder.activity(pane), rows.map((s) => ({ from: s.startedAt, to: s.endedAt })), Date.now());
    return [
      ...rows.map((s): TimelineEntry => ({ kind: "session", id: s.id, from: s.startedAt, to: s.endedAt, session: s })),
      ...manual.map((m): TimelineEntry => ({ kind: "manual", id: manualId(pane, m.from, m.to), from: m.from, to: m.to, bytes: m.bytes }))
    ].sort((a, b) => a.from - b.from);
  };

  /** A code-link command on the session's ticket, its toast told in the window; a conversation it names opens in the app window. */
  const command = async (projectId: string, win: Open, id: string, sessionId: string) => {
    const itemId = sessionOf(projectId, sessionId)?.itemIds[0];
    if (!itemId) return post(win, { type: "toast", text: words()("noTicket") });
    const result = await ctx.contributions.run(id, { projectId, itemId });
    if (result.showThread) ctx.emit("desktop/open", { projectId, threadId: result.showThread });
    if (result.toast) post(win, { type: "toast", text: result.toast });
  };

  /** A plain shell in a new tab of the project's workspace (herdr's, or a pane of the pty host). It needs nothing of code link: only the backend has to answer. */
  const newTerminal = async (projectId: string, win: Open, id: string, cwd: string | null, resume?: string, from?: string) => {
    // Split off a cell: where its shell is now, as iTerm does, else the folder the window knows it by.
    const live = from ? (await backend()?.processes(from).catch(() => []))?.find((p) => p.cwd && fs.existsSync(p.cwd))?.cwd : undefined;
    const asked = live ?? cwd;
    const where = asked && fs.existsSync(asked) ? asked : (await places(projectId))[0]!.cwd;
    // A conversation taken up again: its agent, by its id, in the folder it ran in.
    const talk = resume ? sessionOf(projectId, resume) : undefined;
    const command = talk ? resumeCommand(talk.agent, talk.externalId) : null;
    const row: StartingTerminal = { id, title: path.basename(where) || where, cwd: where, pane: null, startedAt: Date.now() };
    const starting = pending.get(projectId) ?? new Map<string, StartingTerminal>();
    pending.set(projectId, starting.set(id, row));
    void refresh(projectId);
    try {
      const launched = await backend()?.launch({ cwd: where, label: talk?.title ?? row.title, workspace: { key: projectId, label: projectName(projectId) }, ...(command ? { command } : {}) });
      if (!launched) return post(win, { type: "toast", text: words()(builtin() ? "hostTerminalFailed" : "terminalFailed") });
      saveTerminals(projectId, [...savedTerminals(projectId), { ...row, pane: launched.paneId }]);
    } finally {
      starting.delete(id);
      await refresh(projectId);
    }
  };

  const closeTerminal = async (projectId: string, win: Open, id: string) => {
    const t = savedTerminals(projectId).find((x) => x.id === id);
    if (!t) return;
    for (const [cell, stream] of win.terminals) if (stream.paneId === t.pane) detach(win, cell);
    const gone = (await backend()?.closePane(t.pane)) ?? false;
    if (!gone) return post(win, { type: "toast", text: words()(builtin() ? "hostCloseFailed" : "closeFailed") });
    rememberClosed(projectId, [t]);
    saveTerminals(projectId, savedTerminals(projectId).filter((x) => x.id !== id));
    await refresh(projectId);
  };

  // A card's answer to a terminal session's prompt, pressed in its pane.
  const answerSession = async (win: Open, projectId: string, m: Extract<WindowMessage, { type: "answer" }>) => {
    const result = await ctx.codeLink.sessionAnswer(projectId, m.sessionId, m.which).catch(() => "failed" as const);
    // answered or not, what the screen asks is read again for the next state
    prompts.delete(m.sessionId);
    if (result === "answered") {
      // answered from its card: the cells stay as they were, and the window says so
      post(win, { type: "toast", text: words()(m.which === "allow" ? "allowedStay" : "deniedStay", { name: nameOf(projectId, m.sessionId) }) });
      return void refresh(projectId);
    }
    // Nothing pressed: whatever it asks is answered in its pane, which comes into a cell for that.
    if (result === "notPrompt") await show(projectId, m.sessionId);
    return post(win, { type: "toast", text: words()(result === "notPrompt" ? "answerInPane" : "answerNotTaken") });
  };
  // A card's choice for an assistant conversation's question.
  const answerThread = async (win: Open, projectId: string, m: Extract<WindowMessage, { type: "answerThread" }>) => {
    const agent = ctx.get("agent");
    if (!agent) return;
    await agent.send(projectId, m.threadId, { kind: "answer", questionId: m.questionId, value: m.value });
    const thread = threads(projectId).find((t) => t.id === m.threadId);
    return post(win, { type: "toast", text: words()("answeredStay", { name: thread?.key ?? (thread?.title || m.threadId) }) });
  };
  const onMessage = async (projectId: string, win: Open, m: WindowMessage) => {
    switch (m.type) {
      case "attach":
        return attach(projectId, win, m.cell, m.sessionId, m.cols, m.rows);
      case "detach":
        letGoHeld(win, m.cell);
        return detach(win, m.cell);
      case "openOutside": {
        const where = m.cwd && fs.existsSync(m.cwd) ? m.cwd : (await places(projectId))[0]!.cwd;
        try {
          return post(win, { type: "toast", text: words()("openedOutside", { app: await openSystemTerminal(where) }) });
        } catch (error) {
          return post(win, { type: "toast", text: words()("outsideFailed", { reason: errorMessage(error) }) });
        }
      }
      case "newTerminal":
        return newTerminal(projectId, win, m.terminalId, m.cwd, m.resume, typeof m.from === "string" ? m.from : undefined);
      case "conversation": {
        const before = typeof m.before === "number" && Number.isSafeInteger(m.before) && m.before >= 0 ? m.before : undefined;
        const read = ctx.codeLink.conversation?.(projectId, m.sessionId, before) ?? null;
        return post(win, { type: "conversation", cell: m.cell, sessionId: m.sessionId, lines: read?.lines ?? null, cut: read?.cut ?? false, start: read?.cut ? (read.start ?? null) : null, before: before ?? null });
      }
      case "closeTerminal":
        return closeTerminal(projectId, win, m.terminalId);
      case "replay":
        return replay(projectId, win, m.cell, m.id);
      case "timeline":
        return post(win, { type: "timeline", cell: m.cell, pane: m.pane, entries: await timeline(projectId, m.pane), keep: keeping() });
      case "snapshot":
        return win.recordings.get(m.cell)?.keyframe(m.token, m.seq, m.width, m.height, m.bytes);
      case "savePreset": {
        if (!isLayout(m.layout)) return;
        const preset = { id: randomUUID(), name: m.name.trim() || words()("presetName"), layout: emptied(m.layout) };
        save({ presets: [...(stateOf().presets ?? []), preset] });
        return refreshAll();
      }
      case "renamePreset":
        save({ presets: (stateOf().presets ?? []).map((p) => (p.id === m.id && m.name.trim() ? { ...p, name: m.name.trim() } : p)) });
        return refreshAll();
      case "deletePreset": {
        const saved = stateOf();
        save({ presets: (saved.presets ?? []).filter((p) => p.id !== m.id), ...(saved.defaultPreset === m.id ? { defaultPreset: null } : {}) });
        return refreshAll();
      }
      case "restorePreset": {
        const saved = stateOf();
        const presets = saved.presets ?? [];
        if (!isLayout(m.preset.layout) || presets.some((p) => p.id === m.preset.id)) return;
        save({ presets: [...presets.slice(0, m.at), m.preset, ...presets.slice(m.at)], ...(m.isDefault ? { defaultPreset: m.preset.id } : {}) });
        return refreshAll();
      }
      case "defaultPreset":
        save({ defaultPreset: m.id });
        return refreshAll();
      case "autoPlace":
        save({ autoPlace: m.on });
        return refreshAll();
      case "history":
        win.history = m.open;
        // Conversations from before titles were kept get theirs from the agent's transcript, once, before the first page is read.
        if (m.open) ctx.codeLink.findTitles?.(projectId);
        return;
      case "historyList": {
        const before = m.before ?? null;
        const query = typeof m.query === "string" ? m.query : undefined;
        const page = ctx.codeLink.review.list(projectId, { before, query });
        // The closed terminals go with the first page: few, and the window filters them itself.
        const terminals = before ? null : closedTerminals(projectId).sort((a, b) => b.endedAt - a.endedAt);
        return post(win, { type: "historyPage", token: m.token, page, ...historyRows(projectId, page.rows), terminals });
      }
      case "historySaid": {
        const found = await ctx.codeLink.review.saidIn(projectId, typeof m.query === "string" ? m.query : "");
        if (win.closed) return;
        return post(win, { type: "historySaid", token: m.token, found, ...historyRows(projectId, found.rows) });
      }
      case "fold":
        save({ folded: { ...stateOf().folded, [projectId]: m.folded } });
        return refresh(projectId);
      case "overviewAll":
        save({ overviewAll: { ...stateOf().overviewAll, [projectId]: m.all } });
        return refresh(projectId);
      case "input": {
        const stream = win.terminals.get(m.cell);
        if (stream) {
          win.typed.set(m.cell, Date.now());
          return stream.input(m.data);
        }
        const held = win.held.get(m.cell);
        if (!held) return;
        if (held.text.length + m.data.length > HELD_INPUT_MAX) held.over = true;
        else held.text += m.data;
        return;
      }
      case "key": {
        const stream = win.terminals.get(m.cell);
        if (stream?.key) {
          win.typed.set(m.cell, Date.now());
          return stream.key(m.key);
        }
        return onMessage(projectId, win, { type: "input", cell: m.cell, data: "\r" });
      }
      case "drop": {
        // Copies go to the temp folder, which the system clears of what has not been used for a while.
        const text = droppedPaste(await readableDrops(m.paths, path.join(os.tmpdir(), "tomrade-drops")));
        if (text) win.terminals.get(m.cell)?.input(text);
        return;
      }
      case "resize": {
        const stream = win.terminals.get(m.cell);
        if (stream) sizes.set(stream.paneId, { cols: m.cols, rows: m.rows });
        return stream?.resize(m.cols, m.rows);
      }
      case "scroll":
        return win.terminals.get(m.cell)?.scroll(m);
      case "scrollTo": {
        const pane = win.terminals.get(m.cell)?.paneId;
        if (pane) void backend()?.scrollTo(pane, m.offset).catch(() => undefined);
        return;
      }
      case "mouse":
        return win.terminals.get(m.cell)?.mouse(m);
      case "layout":
        if (!isLayout(m.layout)) return;
        save({ layouts: { ...stateOf().layouts, [projectId]: m.layout } });
        for (const listener of laidOut) listener(projectId, m.layout);
        renumber(projectId, win, m.layout);
        return;
      case "continue":
        return command(projectId, win, "code-link.start-terminal", m.sessionId);
      // ⌘K: a ticket with the agent Start would pick, in a new cell here, as `tomrade term --agent` starts one.
      case "startTicket": {
        const item = ctx.items.get(projectId, m.itemId);
        if (!item) return;
        const engine = startEngine();
        const result = await ctx.codeLink.start(projectId, item.id, { mode: "terminal", ...(engine ? { engine: engine.id } : {}), ...(engine?.options ? { options: engine.options } : {}) });
        if (!result.ok) {
          // The ticket comes forward in Tomrade, where its Start says what to fix.
          ctx.emit("desktop/open", { projectId, itemId: item.id });
          return post(win, { type: "toast", text: words()("cliStartStopped", { key: item.key, reason: result.message }) });
        }
        if (result.pane) return show(projectId, result.sessionId);
        const who = engine?.title ?? result.engine;
        return post(win, { type: "toast", text: result.launched ? words()("cliStartedElsewhere", { key: item.key, agent: who, branch: result.branch }) : words()("cliRunThis", { key: item.key, agent: who, command: result.command ?? "" }) });
      }
      case "reviewSearch": {
        const query = m.query.trim();
        if (query.length < 2) return;
        const agents = ctx.get("agent")?.codeEngines() ?? [];
        const page = await ctx.codeLink.review.list(projectId, { query, limit: 8 });
        const rows: ReviewHit[] = page.rows.map((r) => ({ id: r.id, kind: r.kind, key: r.tickets[0]?.key ?? null, title: r.title, agent: agents.find((e) => e.id === r.agent)?.title ?? null, said: r.said }));
        return post(win, { type: "reviewFound", query: m.query, rows });
      }
      case "show":
        return show(projectId, m.sessionId);
      case "openThread": {
        const s = sessionOf(projectId, m.sessionId);
        if (s?.threadId) return void ctx.emit("desktop/open", { projectId, threadId: s.threadId });
        return command(projectId, win, "code-link.open-thread", m.sessionId);
      }
      // The app window comes forward on it, the way a notification's click or a tomrade:// link brings it up.
      case "showThread":
        return void ctx.emit("desktop/open", { projectId, threadId: m.threadId });
      case "mainWindow":
        return void ctx.emit("desktop/open", { projectId });
      case "takeGuess": {
        const taken = ctx.codeLink.takeGuess?.(projectId, m.sessionId) ?? null;
        await refresh(projectId);
        return post(win, { type: "toast", text: taken ? words()("guessTaken", { key: taken.key }) : words()("guessGone") });
      }
      case "noTicket": {
        const done = ctx.codeLink.goWithoutTicket?.(projectId, m.sessionId, words()("noTicketChosen")) ?? false;
        await refresh(projectId);
        return post(win, { type: "toast", text: words()(done ? "noTicketTaken" : "guessGone") });
      }
      case "answer": {
        try {
          return await answerSession(win, projectId, m);
        } finally {
          if (m.token !== undefined) post(win, { type: "answered", token: m.token });
        }
      }
      case "answerThread": {
        try {
          return await answerThread(win, projectId, m);
        } finally {
          if (m.token !== undefined) post(win, { type: "answered", token: m.token });
        }
      }
      case "tails": {
        if (win.hidden) return;
        const provider = backend();
        const panes = [...new Set([...ctx.codeLink.sessionsOf(projectId, undefined, { live: true }).flatMap((s) => (isLive(s) && s.herdrPane ? [s.herdrPane] : [])), ...savedTerminals(projectId).map((t) => t.pane)])];
        const read = provider ? await Promise.all(panes.map((pane) => provider.readTail(pane, TAIL_LINES).catch(() => null))) : [];
        return post(win, { type: "tails", panes: Object.fromEntries(panes.map((pane, i) => [pane, read[i] ?? null])) });
      }
      case "switchTo": {
        const s = sessionOf(projectId, m.sessionId);
        const app = s?.terminal ? TERMINAL_APPS[s.terminal]?.app : undefined;
        if (!app || process.platform !== "darwin") return;
        return void run("open", ["-a", app]).catch(() => post(win, { type: "toast", text: words()("switchFailed", { app }) }));
      }
      case "focusHerdr": {
        // herdr's own client, asked for by name: not this window, which shows the pane already.
        const itemId = sessionOf(projectId, m.sessionId)?.itemIds[0];
        const said = itemId ? await ctx.codeLink.showInHerdr(projectId, itemId) : null;
        return said ? post(win, { type: "toast", text: said }) : command(projectId, win, "code-link.open-terminal", m.sessionId);
      }
      case "openWorktree": {
        const s = sessionOf(projectId, m.sessionId);
        const where = s?.worktree ?? (s?.itemIds[0] ? ctx.codeLink.worktreeOf(projectId, s.itemIds[0]) : null);
        if (where) return void ctx.emit("desktop/reveal", where);
        return post(win, { type: "toast", text: words()("noWorktree") });
      }
      case "openPr": {
        const s = sessionOf(projectId, m.sessionId);
        const itemId = s?.itemIds[0];
        if (!s || !itemId) return post(win, { type: "toast", text: words()("noTicket") });
        const existing = ctx.codeLink.links(projectId, itemId).find((l) => l.branch === s.branch && l.prUrl)?.prUrl;
        if (existing) return void ctx.emit("desktop/open-external", existing);
        const opened = await ctx.codeLink.openPr(projectId, itemId);
        if (opened.url) ctx.emit("desktop/open-external", opened.url);
        return post(win, { type: "toast", text: opened.message });
      }
      case "install": {
        const r = await ctx.codeLink.installHerdr().catch((error: unknown) => ({ launched: false, command: errorMessage(error) }));
        return post(win, { type: "toast", text: r.launched ? words()("installing") : words()("installYourself", { command: r.command }) });
      }
      case "openGuide":
        return void ctx.emit("desktop/open-external", (await ctx.codeLink.herdrInstall()).guide);
      case "openLink": {
        if (/^https?:\/\//i.test(m.url)) return void ctx.emit("desktop/open-external", m.url);
        let target = m.url;
        try {
          if (/^file:/i.test(target)) target = fileURLToPath(target);
        } catch {
          return;
        }
        if (target.startsWith("~/")) target = path.join(os.homedir(), target.slice(2));
        // Source references often carry a line and column; the system app opens the file itself.
        target = target.replace(/:\d+(?::\d+)?$/, "");
        if (path.isAbsolute(target)) ctx.emit("desktop/open-path", target);
        return;
      }
      case "switchTerminal": {
        save({ asked: true });
        if (m.switch) {
          const settings = ctx.settings.get();
          ctx.settings.set({ ...settings, codeLink: { ...(settings.codeLink as object), terminal: builtin() ? BUILTIN_TERMINAL : "herdr" } });
        }
        return refresh(projectId);
      }
      case "startHerdr":
        reviveFailed = false;
        return revive(true);
      case "refresh":
        return refresh(projectId);
      case "visible":
        if (seen(projectId, win, m.visible) && m.visible) return refresh(projectId);
        return;
    }
  };

  /** herdr asked how it is every BRIDGE_POLL_MS, besides every session change, while the window can be seen. */
  const poll = (projectId: string) => {
    const timer = setInterval(() => refreshSoon(projectId, false), BRIDGE_POLL_MS);
    timer.unref?.();
    return timer;
  };
  const stopTimers = (win: Open) => {
    if (win.timer) clearInterval(win.timer);
    win.timer = null;
    if (win.soon.timer) clearTimeout(win.soon.timer);
    win.soon.timer = null;
  };
  /** The window seen again, or no longer: the poll runs only while it can be. Says whether that changed. */
  const seen = (projectId: string, win: Open, visible: boolean): boolean => {
    if (win.closed || win.hidden === !visible) return false;
    win.hidden = !visible;
    if (win.timer) clearInterval(win.timer);
    win.timer = visible ? poll(projectId) : null;
    return true;
  };

  let asks = 0;
  const show = async (projectId: string, reveal?: string) => {
    const asked = reveal ? { sessionId: reveal, at: ++asks } : null;
    const used = () => ({ used: { ...stateOf().used, [projectId]: Date.now() } });
    const already = open.get(projectId);
    if (already && !already.closed) {
      save(used());
      if (asked) already.reveal = asked;
      // Still opening: that call brings it up.
      if (!already.surface) return;
      seen(projectId, already, true);
      already.surface.focus();
      return refresh(projectId);
    }
    const w = words();
    const win: Open = { surface: null as unknown as DesktopSurface, terminals: new Map(), turns: new Map(), detached: new Set(), held: new Map(), timer: poll(projectId), closed: false, reveal: asked, history: false, states: { begun: 0, shown: 0 }, follows: new Map(), frames: new Map(), typed: new Map(), recordings: new Map(), onPane: new Map(), warnedRecording: false, cells: {}, shown: null, soon: { timer: null, due: 0, running: false, again: false, urgent: false, last: 0 }, hidden: false, sent: null, standing: standing(projectId) };
    open.set(projectId, win);
    try {
      await opening(projectId, win, w);
      // after the state is read, so a file that could not be read is still said to be unreadable
      save({ lastProject: projectId, ...used() });
    } catch (error) {
      // A failed open leaves nothing behind, so the next try opens afresh.
      win.closed = true;
      stopTimers(win);
      follow(win, []);
      if (open.get(projectId) === win) open.delete(projectId);
      ctx.logger.warn(`code sessions: window did not open: ${errorMessage(error)}`);
      throw error;
    }
  };

  const opening = async (projectId: string, win: Open, w: ReturnType<typeof words>) => {
    const initialState = await state(projectId);
    follow(win, initialState.terminals);
    win.shown = { terminals: initialState.terminals, sessions: initialState.sessions };
    renumber(projectId, win, initialState.layout);
    win.sent = JSON.stringify(initialState);
    win.surface = ctx.desktopSurfaces.open({
      id: `code-sessions.${projectId}`,
      title: w("windowTitle", { project: projectName(projectId) }),
      url: config.document,
      kind: "window",
      width: 1200,
      height: 760,
      minWidth: 640,
      minHeight: 400,
      initialState,
      onMessage: (message) => void onMessage(projectId, win, message as WindowMessage).catch((error: unknown) => {
        ctx.logger.warn(`code sessions: ${(message as { type?: string }).type ?? "message"} failed: ${errorMessage(error)}`);
        post(win, { type: "toast", text: errorMessage(error) });
      }),
      onClose: () => {
        win.closed = true;
        stopTimers(win);
        renumber(projectId, win, null);
        dropFramesOf(win);
        follow(win, []);
        for (const cell of [...win.terminals.keys()]) detach(win, cell);
        if (open.get(projectId) === win) {
          open.delete(projectId);
          threadsOf.delete(projectId);
          staleThreads.delete(projectId);
        }
      }
    });
  };

  ctx.on("codeLink/changed", (projectId) => {
    historyChanged(projectId);
    watchSoon();
    const win = open.get(projectId);
    if (!win || win.closed) return;
    // A session beginning, ending, waiting or claiming a ticket shows at once; its activity can wait for the next.
    const now = standing(projectId);
    const urgent = now !== win.standing;
    win.standing = now;
    refreshSoon(projectId, urgent);
  });
  // A question asked or answered, a run beginning or ending: what a conversation's card shows. Not each message or
  // streamed word. The event names only the thread: a conversation no window lists yet comes in with its run's start.
  ctx.on("agent/event", (threadId, event) => {
    if (event.type !== "pending" && event.type !== "done") return;
    const projectId = [...threadsOf].find(([, rows]) => rows.some((t) => t.id === threadId))?.[0];
    if (projectId) threadsChanged(projectId);
  });
  ctx.on("agent/run-started", (_run, thread) => threadsChanged(thread.projectId));
  ctx.on("agent/run-ended", (_run, thread) => threadsChanged(thread.projectId));
  // An agent in a terminal changing how it stands, or the terminal ending, shows at once.
  ctx.inject(["terminals"], (ctx) => {
    ctx.terminals.onPane((event) => {
      for (const [projectId, win] of open) if (win.follows.has(event.paneId)) refreshSoon(projectId, true);
      if (event.kind === "exited") watchSoon();
    });
  });
  // Code link's starts and "open in terminal" land here while this window can show the backend's panes.
  const showable = async () => ["ready", "notRunning"].includes((await bridge()).state);
  ctx.on("codeLink/terminal-window", async () => (await showable()) || undefined);
  ctx.on("codeLink/session-cells", (projectId) => {
    const win = open.get(projectId);
    return win && !win.closed ? win.cells : undefined;
  });
  ctx.on("codeLink/show-session", async (projectId, sessionId) => {
    const session = sessionOf(projectId, sessionId);
    // A live one shows its pane; an ended one, its conversation, read-only.
    const ended = session?.state === "ended" || session?.state === "lost";
    if (!session || (!session.herdrPane && !ended) || !(await showable())) return;
    await show(projectId, sessionId);
    return true;
  });
  // The look back's "go on in a terminal cell": a new terminal here, in the folder it ran in, its agent resuming the conversation.
  ctx.on("codeLink/resume-session", async (projectId, sessionId) => {
    const session = sessionOf(projectId, sessionId);
    if (!session || isLive(session) || !resumeCommand(session.agent, session.externalId) || !(await showable())) return;
    await show(projectId);
    const win = open.get(projectId);
    if (!win || win.closed) return;
    await newTerminal(projectId, win, randomUUID(), session.cwd ?? session.worktree, sessionId);
    return true;
  });
  // The look back's raw output: the recording of the session's pane, where this machine kept one.
  ctx.on("codeLink/raw-output-there", (projectId, sessionId) => {
    const bounds = replayBounds(projectId, sessionId);
    return !!bounds && recorder.has(bounds.pane, bounds.from, bounds.to);
  });
  ctx.on("codeLink/raw-output", async (projectId, sessionId) => {
    const bounds = replayBounds(projectId, sessionId);
    if (!bounds || !recorder.has(bounds.pane, bounds.from, bounds.to)) return null;
    return recorder.slice(bounds.pane, bounds.from, bounds.to);
  });
  // Projects with a window before `used` was kept count as used long ago, the last one opened first.
  ctx.on("codeLink/terminal-windows", () => {
    const saved = stateOf();
    const ids = new Set([...Object.keys(saved.used ?? {}), ...Object.keys(saved.layouts ?? {}), ...(saved.lastProject ? [saved.lastProject] : [])]);
    const openIds = ctx.db.openIds();
    const usedAt = (id: string) => saved.used?.[id] ?? (id === saved.lastProject ? 1 : 0);
    return [...ids]
      .filter((id) => openIds.includes(id))
      .map((id) => {
        const layout = saved.layouts?.[id];
        return { projectId: id, cells: isLayout(layout) ? cellsIn(layout).length : 1, usedAt: usedAt(id) };
      })
      .sort((a, b) => b.usedAt - a.usedAt);
  });
  ctx.on("codeLink/new-terminal", async (projectId) => {
    if (!(await showable())) return;
    return !!(await term.openTerminal(projectId, ""));
  });
  ctx.on("settings/changed", () => {
    // Turned off: what is being recorded stops here; a cap lowered takes effect on what is kept.
    if (!recorder.enabled()) for (const win of open.values()) for (const cell of [...win.recordings.keys()]) stopRecording(win, cell);
    else void recorder.cleanup();
    watchSoon();
    for (const projectId of open.keys()) void refresh(projectId);
  });
  // What runs in herdr is recorded from the start, the window open or not.
  watchSoon();

  ctx.contributions.command({
    id: "code-sessions.open",
    title: () => words()("open"),
    group: () => words()("group"),
    run: async ({ projectId }) => {
      // Asked without a project (a start that opens this window first): the one it showed last, else one on this machine.
      const open = ctx.db.openIds();
      const last = stateOf().lastProject;
      const target = projectId ?? (last && open.includes(last) ? last : open[0]);
      if (!target) return { toast: words()("openProject") };
      await show(target);
      return {};
    }
  });
  ctx.contributions.sidebarModule({
    id: "code-sessions",
    title: () => words()("sidebar"),
    icon: "i-terminal",
    command: "code-sessions.open",
    count: ({ projectId }) => needingYou(ctx.codeLink, projectId) || null
  });

  // `tomrade term` in the person's own terminal, over the MCP port.
  const term: TermWindow = {
    lastProject: () => stateOf().lastProject,
    name: projectName,
    show: (projectId) => show(projectId),
    openTerminal: async (projectId, cwd) => {
      await show(projectId);
      const win = open.get(projectId);
      if (!win || win.closed) return null;
      const id = randomUUID();
      await newTerminal(projectId, win, id, cwd);
      if (!savedTerminals(projectId).some((t) => t.id === id)) return null;
      // Into a cell, as a start from outside is: an empty one, else a new one beside.
      win.reveal = { sessionId: id, at: ++asks };
      void refresh(projectId);
      return id;
    },
    layout: (projectId) => {
      const layout = stateOf().layouts?.[projectId];
      return isLayout(layout) ? layout : null;
    },
    terminal: (projectId, id) => savedTerminals(projectId).find((t) => t.id === id),
    onLayout: (listener) => {
      laidOut.add(listener);
      return () => laidOut.delete(listener);
    },
    reattach: (projectId, cell) => {
      const win = open.get(projectId);
      if (win) post(win, { type: "reattach", cell });
    }
  };
  ctx.inject(["mcp"], (ctx) => ctx.mcp.cli("term", serveTerm(ctx, term, words)));

  ctx.effect(() => () => {
    disposed = true;
    if (watchTimer) clearTimeout(watchTimer);
    for (const pane of [...background.keys()]) unwatch(pane);
    for (const win of open.values()) stopTimers(win);
    for (const win of open.values()) win.surface.close();
    recorder.closeAll();
  });
}

export default {
  name: "code-sessions",
  inject: ["codeLink", "items", "desktopSurfaces", "contributions", "settings", "db"],
  Config,
  apply
};
