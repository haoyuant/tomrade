import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Context } from "cordis";
import type { CliHandler } from "@tomradex/mcp";
import type {} from "@tomradex/code-link";
import type {} from "@tomradex/desktop-surface";
import type {} from "@tomradex/herdr";
import type {} from "@tomradex/items";
import type { Layout } from "./protocol.js";
import type { CodeSessionsWords } from "./words.js";

const run = promisify(execFile);

/** How long an answer waits for the window to put what it opened in a cell, to name that cell. */
export const PLACED_MS = 6_000;

type Leaf = Extract<Layout, { type: "leaf" }>;
const leaves = (layout: Layout): Leaf[] => (layout.type === "leaf" ? [layout] : [...leaves(layout.a), ...leaves(layout.b)]);

/** What the `tomrade term` command reaches of the Terminal window. */
export interface TermWindow {
  /** The project the window opened for last. */
  lastProject(): string | undefined;
  name(projectId: string): string;
  /** The project's window, opened or brought forward. */
  show(projectId: string): Promise<void>;
  /** A plain terminal in that folder, brought into a cell of the project's window: its id once it runs, null when none opened. */
  openTerminal(projectId: string, cwd: string): Promise<string | null>;
  /** The layout the project's window saved last. */
  layout(projectId: string): Layout | null;
  /** A terminal the window opened, by its id. */
  terminal(projectId: string, id: string): { title: string; cwd: string; pane: string } | undefined;
  /** Hear each layout a window saves. */
  onLayout(listener: (projectId: string, layout: Layout) => void): () => void;
  /** The cell streams its terminal again: the person's own terminal let it go. */
  reattach(projectId: string, cell: string): void;
}

/** One cell as the command lists it: its number in reading order, as the window shows it. */
export interface TermCell {
  n: number;
  /** The window's own id for it. */
  cell: string;
  /** The pane its terminal runs in; null for an empty cell or one whose session ended. */
  pane: string | null;
  label: string;
  ended: boolean;
}

/** What the command is answered: said as it is, and what it goes on with. */
export interface TermAnswer {
  ok: boolean;
  text: string;
  cells?: string[];
  /** `--attach`: herdr's own client, run in the person's terminal on that terminal. */
  attach?: { herdr: string; socket: string; terminal: string };
  projectId?: string;
  cell?: string;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The coding agent a person names on the command line: by id or name ("codex", "claude", "Claude Code"), whole first, then the start of one. */
export function engineNamed<E extends { id: string; title: string }>(engines: E[], name: string): E | undefined {
  const want = squash(name);
  if (!want) return undefined;
  return engines.find((e) => squash(e.id) === want || squash(e.title) === want) ?? engines.find((e) => squash(e.id).startsWith(want) || squash(e.title).startsWith(want));
}

const within = (dir: string, root: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** The checkout a folder's git worktree belongs to: the parent of git's common folder; null outside git. */
async function checkoutOf(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--git-common-dir"], { cwd, timeout: 3000 });
    const common = path.resolve(cwd, stdout.trim());
    return path.basename(common) === ".git" ? path.dirname(common) : null;
  } catch {
    return null;
  }
}

/** A folder and the one its symlinks resolve to, for matching either way. */
const both = (dir: string): string[] => {
  try {
    const real = fs.realpathSync(dir);
    return real === dir ? [dir] : [dir, real];
  } catch {
    return [dir];
  }
};

const tilde = (dir: string) => {
  const home = os.homedir();
  return dir === home || dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
};

/**
 * `tomrade term`, from the person's own terminal over the MCP port: open a terminal in a folder, start a ticket with an
 * agent through code link's Start, or hand a cell's herdr terminal to the person's terminal. Cells are numbered in
 * reading order, as the window numbers them.
 */
export function serveTerm(ctx: Context, win: TermWindow, words: () => CodeSessionsWords): CliHandler {
  const folder = (value: unknown): string | null => {
    const dir = typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : null;
    try {
      return dir && fs.statSync(dir).isDirectory() ? dir : null;
    } catch {
      return null;
    }
  };

  /** The project whose repository holds the folder (its checkout or a worktree of it); else the window's last, else the first. */
  const projectAt = async (cwd: string | null): Promise<string | null> => {
    const ids = ctx.db.openIds();
    const places = cwd ? [...both(cwd), ...[await checkoutOf(cwd)].filter((p): p is string => !!p)] : [];
    let best: { id: string; depth: number } | null = null;
    for (const id of places.length ? ids : []) {
      let roots: string[] = [];
      try {
        roots = ctx.codeLink.repositoryFoldersOf(id).map((f) => f.path);
      } catch {
        // No repository to hold it to.
      }
      for (const root of roots) if (places.some((p) => both(root).some((r) => within(p, r))) && (!best || root.length > best.depth)) best = { id, depth: root.length };
    }
    if (best) return best.id;
    const last = win.lastProject();
    return last && ids.includes(last) ? last : (ids[0] ?? null);
  };

  const cellsOf = (projectId: string): TermCell[] => {
    const w = words();
    let sessions: ReturnType<typeof ctx.codeLink.sessionsOf> = [];
    try {
      sessions = ctx.codeLink.sessionsOf(projectId);
    } catch {
      // Cells with sessions read as empty.
    }
    const layout = win.layout(projectId);
    return (layout ? leaves(layout) : [{ type: "leaf" as const, id: "c1", sessionId: null }]).map((leaf, i) => {
      const id = leaf.sessionId;
      const s = id ? sessions.find((x) => x.id === id) : undefined;
      const t = id ? win.terminal(projectId, id) : undefined;
      const live = !!s && s.state !== "ended" && s.state !== "lost";
      let label = w("cliCellEmpty");
      if (s) {
        const item = s.itemIds[0] ? ctx.items.get(projectId, s.itemIds[0]) : null;
        const agent = ctx.get("agent")?.engineOf(s.agent)?.title ?? s.agent;
        label = [item?.key, agent, item?.title ?? s.title ?? s.branch, live ? null : w("cliCellEnded")].filter(Boolean).join(" · ");
      } else if (t) label = `${t.title} · ${tilde(t.cwd)}`;
      return { n: i + 1, cell: leaf.id, pane: (live ? s.herdrPane : null) ?? t?.pane ?? null, label, ended: !!s && !live };
    });
  };
  const lines = (cells: TermCell[]) => cells.map((c) => `${c.n}  ${c.label}`);

  /** The number of the cell the window put `id` in, once it saved that layout; null when it did not in time. */
  const placed = (projectId: string, id: string): Promise<number | null> =>
    new Promise((resolve) => {
      const at = (layout: Layout | null) => {
        const i = layout ? leaves(layout).findIndex((l) => l.sessionId === id) : -1;
        return i >= 0 ? i + 1 : null;
      };
      const now = at(win.layout(projectId));
      if (now) return resolve(now);
      const done = (n: number | null) => {
        clearTimeout(timer);
        off();
        resolve(n);
      };
      const timer = setTimeout(() => done(null), PLACED_MS);
      const off = win.onLayout((p, layout) => {
        const n = p === projectId ? at(layout) : null;
        if (n) done(n);
      });
    });

  const no = (text: string, more: Partial<TermAnswer> = {}): TermAnswer => ({ ok: false, text, ...more });
  const yes = (text: string, more: Partial<TermAnswer> = {}): TermAnswer => ({ ok: true, text, ...more });

  const open = async (cwd: string | null): Promise<TermAnswer> => {
    const w = words();
    if (!cwd) return no(w("cliNoFolder"));
    const projectId = await projectAt(cwd);
    if (!projectId) return no(w("openProject"));
    ctx.emit("desktop/activate");
    // Without a backend the window says how to get one.
    if (!ctx.get("terminals")) return win.show(projectId).then(() => no(w("cliNoBackend")));
    const id = await win.openTerminal(projectId, cwd);
    if (!id) return no(w(ctx.get("terminals")?.kind === "builtin" ? "hostTerminalFailed" : "terminalFailed"));
    const n = await placed(projectId, id);
    return yes(n ? w("cliOpened", { n, cwd: tilde(cwd) }) : w("cliOpenedNoCell", { cwd: tilde(cwd) }));
  };

  const start = async (cwd: string | null, key: string, agent: string | null): Promise<TermAnswer> => {
    const w = words();
    const near = await projectAt(cwd);
    const ids = ctx.db.openIds();
    const found = (near ? [near, ...ids.filter((id) => id !== near)] : ids).flatMap((projectId) => {
      const item = ctx.items.getByKey(projectId, key);
      return item ? [{ projectId, item }] : [];
    })[0];
    if (!found) return no(w("cliNoTicket", { key }));
    const engines = ctx.get("agent")?.codeEngines() ?? [];
    const named = agent ? engineNamed(engines, agent) : undefined;
    if (agent && !named) return no(w("cliNoAgent", { agent, agents: engines.map((e) => e.id).join(", ") }));
    // Unnamed, it is the one Start would pick: the one last started with, and that one's options.
    const remembered = ctx.codeLink.startDefaults();
    const engine = named?.id ?? remembered?.engine;
    const options = engine && remembered?.engine === engine ? remembered.options : undefined;
    const { projectId, item } = found;
    const result = await ctx.codeLink.start(projectId, item.id, { mode: "terminal", ...(engine ? { engine } : {}), ...(options ? { options } : {}) });
    ctx.emit("desktop/activate");
    if (!result.ok) {
      // The ticket comes forward in Tomrade, where its Start says what to fix.
      ctx.emit("desktop/open", { projectId, itemId: item.id });
      return no(w("cliStartStopped", { key: item.key, reason: result.message }));
    }
    const who = engines.find((e) => e.id === result.engine)?.title ?? result.engine;
    if (result.mode === "terminal" && !result.launched) return yes(w("cliRunThis", { key: item.key, agent: who, command: result.command ?? "" }));
    const shown = result.mode === "terminal" && !!result.pane && (await ctx.codeLink.showSession(projectId, result.sessionId));
    const n = shown ? await placed(projectId, result.sessionId) : null;
    return yes(n ? w("cliStarted", { n, key: item.key, agent: who, branch: result.branch }) : w("cliStartedElsewhere", { key: item.key, agent: who, branch: result.branch }));
  };

  const attach = async (cwd: string | null, n: number | null): Promise<TermAnswer> => {
    const w = words();
    // Only herdr's own client attaches a terminal to another: the pty host on Windows has none.
    if (process.platform === "win32" || ctx.get("terminals")?.kind === "builtin") return no(w("cliAttachUnsupported"));
    const projectId = await projectAt(cwd);
    if (!projectId) return no(w("openProject"));
    const cells = cellsOf(projectId);
    const list = { cells: lines(cells) };
    const project = win.name(projectId);
    if (n === null) return yes(w("cliCells", { project }), list);
    const cell = cells.find((c) => c.n === n);
    if (!cell) return no(w("cliNoCell", { n, project }), list);
    if (!cell.pane) return no(w(cell.ended ? "cliCellOver" : "cliCellNoTerminal", { n }), list);
    const herdr = ctx.get("herdr");
    const bin = herdr?.binary();
    if (!herdr || !bin) return no(w("cliNoBackend"));
    let terminal: string | undefined;
    try {
      terminal = (await herdr.call<{ pane?: { terminal_id?: string } }>("pane.get", { pane_id: cell.pane })).pane?.terminal_id;
    } catch {
      // gone with its pane, or herdr's server with it
    }
    if (!terminal) return no(w("cliCellNoTerminal", { n }), list);
    return yes(w("cliAttach", { n, what: cell.label }), { attach: { herdr: bin, socket: herdr.socketPath(), terminal }, projectId, cell: cell.cell });
  };

  return async (request): Promise<TermAnswer> => {
    const cwd = folder(request.cwd);
    switch (request.op) {
      case "open":
        return open(cwd);
      case "start":
        return typeof request.key === "string" && request.key ? start(cwd, request.key.toUpperCase(), typeof request.agent === "string" && request.agent.trim() ? request.agent.trim() : null) : no(words()("cliNoTicket", { key: "" }));
      case "attach": {
        const n = typeof request.cell === "number" && Number.isSafeInteger(request.cell) && request.cell > 0 ? request.cell : null;
        return attach(cwd, n);
      }
      case "detached":
        if (typeof request.projectId === "string" && typeof request.cell === "string") win.reattach(request.projectId, request.cell);
        return yes("");
      default:
        return no(`unknown request ${String(request.op)}`);
    }
  };
}
