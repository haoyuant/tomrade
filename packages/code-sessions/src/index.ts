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
import { BUILTIN_TERMINAL, MCP_AGENT, WINDOWS_TERMINAL, panesOf, resumeCommand, type CodeLink } from "@tomradex/code-link";
import type { DesktopSurface } from "@tomradex/desktop-surface";
import type {} from "@tomradex/herdr";
import type { TerminalBridge, TerminalPaneInfo, TerminalProvider, TerminalStream } from "@tomradex/contracts";
import { randomUUID } from "node:crypto";
import { droppedPaste, readableDrops } from "./drop.js";
import type { Layout, LayoutPreset, SessionRow, TerminalPlace, TerminalRow, WindowMessage, WindowPost, WindowState } from "./protocol.js";
import { CODE_SESSIONS_WORDS } from "./words.js";
import { errorMessage } from "@tomradex/contracts";

export type * from "./protocol.js";

export const Config = z.object({
  /** The window's page: the renderer's `code-sessions.html`. */
  document: z.string(),
  /** Where each project's layout, and whether the person was asked to switch to herdr, are kept on this machine. */
  stateFile: z.string().optional()
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
}

type SavedTerminal = Omit<TerminalRow, "sessionId" | "note" | "agentTitle" | "agentStatus" | "running"> & { pane: string };
type StartingTerminal = Omit<SavedTerminal, "pane"> & { pane: null };

const run = promisify(execFile);

/** Coding agents' commands, as they show in a terminal's foreground process. */
const AGENT_COMMAND = /(?:^|[\s/])(?:gemini|qwen|cursor-agent|claude|codex|opencode|droid|copilot|kimi|amp|codebuddy)(?:\s|$)/;

const within = (dir: string, root: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** A login or interactive shell, as a foreground command's first word. */
const SHELL = /^-?(?:.*\/)?(zsh|bash|fish|sh|dash|ksh|tcsh|nu|login)$/;

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

const leafIds = (layout: Layout): string[] => (layout.type === "leaf" ? (layout.sessionId ? [layout.sessionId] : []) : [...leafIds(layout.a), ...leafIds(layout.b)]);

/** The cell of that id in a saved layout, if the layout has it. */
const leafOf = (layout: Layout | undefined, cell: string): Extract<Layout, { type: "leaf" }> | undefined => {
  if (!layout || !isLayout(layout)) return undefined;
  if (layout.type === "leaf") return layout.id === cell ? layout : undefined;
  return leafOf(layout.a, cell) ?? leafOf(layout.b, cell);
};

const emptied = (layout: Layout): Layout => (layout.type === "leaf" ? { type: "leaf", id: layout.id, sessionId: null } : { ...layout, a: emptied(layout.a), b: emptied(layout.b) });

/** The saved state, and whether the file is there but cannot be read: then it starts over, and the window says so. */
const readState = (file: string | undefined): { saved: Saved; broken: boolean } => {
  if (!file || !fs.existsSync(file)) return { saved: {}, broken: false };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { saved: parsed as Saved, broken: false } : { saved: {}, broken: true };
  } catch {
    return { saved: {}, broken: true };
  }
};

const stateOf = (file: string | undefined): Saved => readState(file).saved;

const save = (file: string | undefined, patch: Saved) => {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...stateOf(file), ...patch }));
  } catch {
    // The layout comes back as one cell next time; nothing else depends on it.
  }
};

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

/** A project's code sessions, live ones first and needs-you before the rest, then every ended one code link keeps. */
export function sessionRows(codeLink: Pick<CodeLink, "sessionsOf" | "links">, items: { get(projectId: string, id: string): { key: string; title: string } | null | undefined }, projectId: string, now = Date.now(), device?: string, platform: NodeJS.Platform = process.platform): SessionRow[] {
  const prs = new Map(codeLink.links(projectId).filter((l) => l.prUrl).map((l) => [l.branch, l.prUrl]));
  return codeLink
    .sessionsOf(projectId)
    .map((s): SessionRow => {
      const itemId = s.itemIds[0] ?? null;
      const item = itemId ? items.get(projectId, itemId) : null;
      const live = s.state !== "ended" && s.state !== "lost";
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
        continuedIn: null
      };
    })
    .sort((a, b) => Number(b.state !== "ended" && b.state !== "lost") - Number(a.state !== "ended" && a.state !== "lost") || Number(b.needsYou) - Number(a.needsYou) || b.startedAt - a.startedAt);
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
  timer: NodeJS.Timeout;
  closed: boolean;
  /** The latest ask to show a session, kept in every state so a window that opens late still sees it. */
  reveal: WindowState["reveal"];
  /** The archive is open: its rows go with every state. */
  archive: boolean;
  /** States begun, and the newest one shown: one that finishes after a newer one is not shown. */
  states: { begun: number; shown: number };
  /** The panes of its terminals followed in herdr, so an agent's status there shows as it changes. */
  follows: Map<string, () => void>;
  /** Frames waiting to go to the window, one batch per cell. */
  frames: Map<string, PendingFrames>;
}

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

  const projectName = (projectId: string) => (ctx.db.for(projectId).prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? projectId;
  const terminal = () => (ctx.settings.get().codeLink as { terminal?: string } | undefined)?.terminal ?? "auto";

  /** The terminal backend: herdr, or Tomrade's own pty host on native Windows. */
  const backend = () => ctx.get("terminals");
  const builtin = () => backend()?.kind === "builtin";
  // Without a backend on Windows, a new terminal opens in the system terminal; elsewhere herdr is what is missing.
  const bridge = async (): Promise<TerminalBridge> => (await backend()?.bridge()) ?? (process.platform === "win32" ? { state: "unsupported" } : { state: "notInstalled" });

  /** The sessions to list; when they cannot be read the window says so and its terminals work on. */
  const listed = (projectId: string): { sessions: SessionRow[]; warning: string | null } => {
    try {
      const agents = ctx.get("agent");
      const rows = sessionRows(ctx.codeLink, ctx.items, projectId, Date.now(), ctx.get("hub")?.deviceId);
      return { sessions: rows.map((r) => ({ ...r, agentName: agents?.engineOf(r.agent)?.title ?? null })), warning: null };
    } catch (error) {
      ctx.logger.warn(`code sessions: listing sessions failed: ${errorMessage(error)}`);
      return { sessions: [], warning: words()("sessionsUnreadable") };
    }
  };

  /** Terminals herdr is still opening, by project: shown as starting, never saved. */
  const pending = new Map<string, Map<string, StartingTerminal>>();
  const savedTerminals = (projectId: string) => stateOf(config.stateFile).terminals?.[projectId] ?? [];
  const saveTerminals = (projectId: string, list: SavedTerminal[]) => save(config.stateFile, { terminals: { ...stateOf(config.stateFile).terminals, [projectId]: list } });

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
    if (gone.size) saveTerminals(projectId, savedTerminals(projectId).filter((t) => !gone.has(t.id)));
    const agentTitle = (pane: string | null) => {
      const info = pane ? byPane.get(pane) : undefined;
      return info?.agent ? info.title : null;
    };
    const agentStatus = (pane: string | null): TerminalRow["agentStatus"] => {
      const info = pane ? byPane.get(pane) : undefined;
      return info?.agent && info.status !== "unknown" ? info.status : null;
    };
    // A terminal with no agent goes by what runs in it: its foreground command, else what its shell calls it.
    const running = async (pane: string | null): Promise<string | null> => {
      const info = pane ? byPane.get(pane) : undefined;
      if (!provider || !pane || !info || info.agent) return null;
      const fg = await provider.processes(pane).catch(() => []);
      const command = fg.map((p) => p.cmdline?.trim() ?? "").find((c) => c && !SHELL.test(c.split(/\s+/)[0]!));
      return command ? command.slice(0, 80) : info.title;
    };
    const rows = [...saved.filter((t) => !gone.has(t.id)), ...opening];
    const runs = await Promise.all(rows.map((t) => running(t.pane)));
    return rows.map((t, i) => ({ ...t, agentTitle: agentTitle(t.pane), agentStatus: agentStatus(t.pane), running: runs[i] ?? null, sessionId: null, note: null }));
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

  const state = async (projectId: string): Promise<WindowState> => {
    const b = await bridge();
    const shown = listed(projectId);
    if (b.state === "ready") reviveFailed = false;
    if (b.state === "notRunning" && wantsHerdr(projectId, shown.sessions)) revive();
    const setting = terminal();
    const { saved, broken } = readState(config.stateFile);
    const remembered = saved.layouts?.[projectId];
    const presets = (saved.presets ?? []).filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && isLayout(p.layout));
    const preset = presets.find((p) => p.id === saved.defaultPreset);
    const warning = [shown.warning, broken || (remembered !== undefined && !isLayout(remembered)) ? words()("stateUnreadable") : null].filter(Boolean).join(" · ") || null;
    const layout = isLayout(remembered) ? remembered : preset ? preset.layout : fresh();
    // An ended session stays with the state while a cell shows it; the rest wait in the archive.
    const inCells = new Set(leafIds(layout));
    // Ticket work, and conversations someone had; a start nobody spoke to is not kept.
    const ended = shown.sessions.filter((s) => s.endedAt !== null && (s.itemId || s.conversation || s.prompted));
    const win = open.get(projectId);
    // Read with the layout, before anything is awaited: a state begun before a pick from the archive was saved must
    // still carry that session, or the window would drop it from the cell it was just put in.
    const archiveOpen = win?.archive ?? false;
    const sent = await titled(shown.sessions.filter((s) => s.endedAt === null || inCells.has(s.id) || s.id === win?.reveal?.sessionId), savedTerminals(projectId));
    const opened = await fold(projectId, shown.sessions, await terminals(projectId));
    return {
      projectId,
      projectName: projectName(projectId),
      locale: ctx.settings.locale(),
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
      warning,
      terminals: opened,
      places: await places(projectId),
      layout,
      presets,
      defaultPreset: preset?.id ?? null,
      autoPlace: saved.autoPlace !== false,
      reveal: win?.reveal ?? null,
      archive: { count: ended.length, rows: archiveOpen ? [...ended].sort((a, b) => b.endedAt! - a.endedAt!) : null },
      folded: saved.folded?.[projectId] === true
    };
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
    const win = open.get(projectId);
    if (!win || win.closed || !win.surface) return;
    const turn = ++win.states.begun;
    const next = await state(projectId);
    if (win.closed || turn < win.states.shown) return;
    win.states.shown = turn;
    follow(win, next.terminals);
    win.surface.setState(next);
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
    send(win, {
      type: "frame",
      cell,
      seq: pending.seq,
      width: pending.width,
      height: pending.height,
      full: pending.full,
      bytes: pending.bytes.length === 1 ? pending.bytes[0]! : Buffer.concat(pending.bytes, pending.size)
    });
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
   * One frame joins its cell's batch. A pane can paint faster than a screen shows — a burst of frames
   * becomes one message, its bytes unchanged and in order.
   */
  const pushFrame = (win: Open, cell: string, frame: { seq: number; width: number; height: number; full: boolean; bytes: Uint8Array }) => {
    if (win.closed || !frame.bytes.length) return;
    const pending = win.frames.get(cell);
    // Another size paints a screen the open batch no longer fits: what waits goes first.
    if (pending && (pending.width !== frame.width || pending.height !== frame.height)) flushFrames(win, cell);
    const batch = win.frames.get(cell);
    if (!batch) {
      const timer = setTimeout(() => flushFrames(win, cell), FRAME_BATCH_MS);
      timer.unref?.();
      win.frames.set(cell, { bytes: [frame.bytes], size: frame.bytes.length, seq: frame.seq, width: frame.width, height: frame.height, full: frame.full, timer });
      return;
    }
    batch.bytes.push(frame.bytes);
    batch.size += frame.bytes.length;
    batch.seq = frame.seq;
    if (batch.size >= FRAME_BATCH_MAX) flushFrames(win, cell);
  };

  const sessionOf = (projectId: string, id: string) => ctx.codeLink.sessionsOf(projectId).find((s) => s.id === id);

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
    const stream = win.terminals.get(cell);
    win.terminals.delete(cell);
    stream?.close();
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
      const still = leafOf(stateOf(config.stateFile).layouts?.[projectId], other)?.sessionId;
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
      // The pty host names a pane it no longer has; herdr's own words come as they are.
      return post(win, { type: "closed", cell, reason: (error as { code?: unknown } | null)?.code === "pane_not_found" ? words()("paneEnded") : errorMessage(error) });
    }
    if (win.closed || win.turns.get(cell) !== mine) return stream.close();
    win.terminals.set(cell, stream);
    win.detached.delete(cell);
    const held = win.held.get(cell);
    win.held.delete(cell);
    if (held?.text) stream.input(held.text);
    if (held?.over) post(win, { type: "toast", text: words()("notSent") });
    stream.onFrame((f) => pushFrame(win, cell, f));
    stream.onClose(provider.onScroll(pane, (s) => win.terminals.get(cell) === stream && post(win, { type: "scrolled", cell, ...s })));
    stream.onClose((reason) => {
      if (win.terminals.get(cell) !== stream) return;
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

  /** A code-link command on the session's ticket, its toast told in the window; a conversation it names opens in the app window. */
  const command = async (projectId: string, win: Open, id: string, sessionId: string) => {
    const itemId = sessionOf(projectId, sessionId)?.itemIds[0];
    if (!itemId) return post(win, { type: "toast", text: words()("noTicket") });
    const result = await ctx.contributions.run(id, { projectId, itemId });
    if (result.showThread) ctx.emit("desktop/open", { projectId, threadId: result.showThread });
    if (result.toast) post(win, { type: "toast", text: result.toast });
  };

  /** A plain shell in a new tab of the project's workspace (herdr's, or a pane of the pty host). It needs nothing of code link: only the backend has to answer. */
  const newTerminal = async (projectId: string, win: Open, id: string, cwd: string | null, resume?: string) => {
    const where = cwd && fs.existsSync(cwd) ? cwd : (await places(projectId))[0]!.cwd;
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
    saveTerminals(projectId, savedTerminals(projectId).filter((x) => x.id !== id));
    await refresh(projectId);
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
        return newTerminal(projectId, win, m.terminalId, m.cwd, m.resume);
      case "conversation": {
        const before = typeof m.before === "number" && Number.isSafeInteger(m.before) && m.before >= 0 ? m.before : undefined;
        const read = ctx.codeLink.conversation?.(projectId, m.sessionId, before) ?? null;
        return post(win, { type: "conversation", cell: m.cell, sessionId: m.sessionId, lines: read?.lines ?? null, cut: read?.cut ?? false, start: read?.cut ? (read.start ?? null) : null, before: before ?? null });
      }
      case "closeTerminal":
        return closeTerminal(projectId, win, m.terminalId);
      case "savePreset": {
        if (!isLayout(m.layout)) return;
        const preset = { id: randomUUID(), name: m.name.trim() || words()("presetName"), layout: emptied(m.layout) };
        save(config.stateFile, { presets: [...(stateOf(config.stateFile).presets ?? []), preset] });
        return refreshAll();
      }
      case "renamePreset":
        save(config.stateFile, { presets: (stateOf(config.stateFile).presets ?? []).map((p) => (p.id === m.id && m.name.trim() ? { ...p, name: m.name.trim() } : p)) });
        return refreshAll();
      case "deletePreset": {
        const saved = stateOf(config.stateFile);
        save(config.stateFile, { presets: (saved.presets ?? []).filter((p) => p.id !== m.id), ...(saved.defaultPreset === m.id ? { defaultPreset: null } : {}) });
        return refreshAll();
      }
      case "defaultPreset":
        save(config.stateFile, { defaultPreset: m.id });
        return refreshAll();
      case "autoPlace":
        save(config.stateFile, { autoPlace: m.on });
        return refreshAll();
      case "archive":
        win.archive = m.open;
        // Conversations from before titles were kept get theirs from the agent's transcript, once.
        if (m.open) ctx.codeLink.findTitles?.(projectId);
        return refresh(projectId);
      case "fold":
        save(config.stateFile, { folded: { ...stateOf(config.stateFile).folded, [projectId]: m.folded } });
        return refresh(projectId);
      case "input": {
        const stream = win.terminals.get(m.cell);
        if (stream) return stream.input(m.data);
        const held = win.held.get(m.cell);
        if (!held) return;
        if (held.text.length + m.data.length > HELD_INPUT_MAX) held.over = true;
        else held.text += m.data;
        return;
      }
      case "key": {
        const stream = win.terminals.get(m.cell);
        if (stream?.key) return stream.key(m.key);
        return onMessage(projectId, win, { type: "input", cell: m.cell, data: "\r" });
      }
      case "drop": {
        // Copies go to the temp folder, which the system clears of what has not been used for a while.
        const text = droppedPaste(await readableDrops(m.paths, path.join(os.tmpdir(), "tomrade-drops")));
        if (text) win.terminals.get(m.cell)?.input(text);
        return;
      }
      case "resize":
        return win.terminals.get(m.cell)?.resize(m.cols, m.rows);
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
        return save(config.stateFile, { layouts: { ...stateOf(config.stateFile).layouts, [projectId]: m.layout } });
      case "continue":
        return command(projectId, win, "code-link.start-terminal", m.sessionId);
      case "openThread": {
        const s = sessionOf(projectId, m.sessionId);
        if (s?.threadId) return void ctx.emit("desktop/open", { projectId, threadId: s.threadId });
        return command(projectId, win, "code-link.open-thread", m.sessionId);
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
        save(config.stateFile, { asked: true });
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
    }
  };

  let asks = 0;
  const show = async (projectId: string, reveal?: string) => {
    const asked = reveal ? { sessionId: reveal, at: ++asks } : null;
    const already = open.get(projectId);
    if (already && !already.closed) {
      if (asked) already.reveal = asked;
      // Still opening: that call brings it up.
      if (!already.surface) return;
      already.surface.focus();
      return refresh(projectId);
    }
    const w = words();
    const win: Open = { surface: null as unknown as DesktopSurface, terminals: new Map(), turns: new Map(), detached: new Set(), held: new Map(), timer: setInterval(() => void refresh(projectId), BRIDGE_POLL_MS), closed: false, reveal: asked, archive: false, states: { begun: 0, shown: 0 }, follows: new Map(), frames: new Map() };
    win.timer.unref?.();
    open.set(projectId, win);
    try {
      await opening(projectId, win, w);
    } catch (error) {
      // A failed open leaves nothing behind, so the next try opens afresh.
      win.closed = true;
      clearInterval(win.timer);
      follow(win, []);
      if (open.get(projectId) === win) open.delete(projectId);
      ctx.logger.warn(`code sessions: window did not open: ${errorMessage(error)}`);
      throw error;
    }
  };

  const opening = async (projectId: string, win: Open, w: ReturnType<typeof words>) => {
    const initialState = await state(projectId);
    follow(win, initialState.terminals);
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
        clearInterval(win.timer);
        dropFramesOf(win);
        follow(win, []);
        for (const cell of [...win.terminals.keys()]) detach(win, cell);
        if (open.get(projectId) === win) open.delete(projectId);
      }
    });
  };

  ctx.on("codeLink/changed", (projectId) => void refresh(projectId));
  // An agent in a terminal changing how it stands, or the terminal ending, shows at once.
  ctx.inject(["terminals"], (ctx) => {
    ctx.terminals.onPane((event) => {
      for (const [projectId, win] of open) if (win.follows.has(event.paneId)) void refresh(projectId);
    });
  });
  // Code link's starts and "open in terminal" land here while this window can show the backend's panes.
  const showable = async () => ["ready", "notRunning"].includes((await bridge()).state);
  ctx.on("codeLink/terminal-window", async () => (await showable()) || undefined);
  ctx.on("codeLink/show-session", async (projectId, sessionId) => {
    const session = sessionOf(projectId, sessionId);
    // A live one shows its pane; an ended one, its conversation, read-only.
    const ended = session?.state === "ended" || session?.state === "lost";
    if (!session || (!session.herdrPane && !ended) || !(await showable())) return;
    await show(projectId, sessionId);
    return true;
  });
  ctx.on("settings/changed", () => {
    for (const projectId of open.keys()) void refresh(projectId);
  });

  ctx.contributions.command({
    id: "code-sessions.open",
    title: () => words()("open"),
    group: () => words()("group"),
    run: async ({ projectId }) => {
      if (!projectId) return { toast: words()("openProject") };
      await show(projectId);
      return {};
    }
  });
  ctx.contributions.sidebarModule({
    id: "code-sessions",
    title: () => words()("sidebar"),
    icon: "i-terminal",
    command: "code-sessions.open",
    count: ({ projectId }) => sessionRows(ctx.codeLink, ctx.items, projectId).filter((s) => s.needsYou).length || null
  });

  ctx.effect(() => () => {
    for (const win of open.values()) win.surface.close();
  });
}

export default {
  name: "code-sessions",
  inject: ["codeLink", "items", "desktopSurfaces", "contributions", "settings", "db"],
  Config,
  apply
};
