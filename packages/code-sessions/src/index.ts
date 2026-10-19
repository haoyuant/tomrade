import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/db";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/items";
import type {} from "@tomradex/settings";
import type { CodeLink } from "@tomradex/code-link";
import type { DesktopSurface } from "@tomradex/desktop-surface";
import type { HerdrBridge, TerminalStream } from "@tomradex/herdr";
import type { Layout, SessionRow, WindowMessage, WindowPost, WindowState } from "./protocol.js";
import { CODE_SESSIONS_WORDS } from "./words.js";

export type * from "./protocol.js";

export const Config = z.object({
  /** The window's page: the renderer's `code-sessions.html`. */
  document: z.string(),
  /** Where each project's layout, and whether the person was asked to switch to herdr, are kept on this machine. */
  stateFile: z.string().optional()
});
export type Config = z.infer<typeof Config>;

/** Ended sessions stay listed this long, so the last look at one is a click away. */
export const ENDED_SHOWN_MS = 24 * 60 * 60 * 1000;
/** How often an open window asks herdr how it is, besides every session change. */
export const BRIDGE_POLL_MS = 10_000;

interface Saved {
  asked?: boolean;
  layouts?: Record<string, Layout>;
}

const fresh = (): Layout => ({ type: "leaf", id: "c1", sessionId: null });

const stateOf = (file: string | undefined): Saved => {
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Saved;
  } catch {
    return {};
  }
};

const save = (file: string | undefined, patch: Saved) => {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...stateOf(file), ...patch }));
  } catch {
    // The layout comes back as one cell next time; nothing else depends on it.
  }
};

/** A project's code sessions as the window lists them: live ones first, then the ones ended in the last day. */
export function sessionRows(codeLink: Pick<CodeLink, "sessionsOf" | "links">, items: { get(projectId: string, id: string): { key: string; title: string } | null | undefined }, projectId: string, now = Date.now()): SessionRow[] {
  const prs = new Map(codeLink.links(projectId).filter((l) => l.prUrl).map((l) => [l.branch, l.prUrl]));
  return codeLink
    .sessionsOf(projectId)
    .filter((s) => (s.state !== "ended" && s.state !== "lost") || now - (s.endedAt ?? s.lastEventAt ?? s.startedAt) < ENDED_SHOWN_MS)
    .map((s): SessionRow => {
      const itemId = s.itemIds[0] ?? null;
      const item = itemId ? items.get(projectId, itemId) : null;
      const live = s.state !== "ended" && s.state !== "lost";
      return {
        id: s.id,
        itemId,
        key: item?.key ?? null,
        title: item?.title ?? null,
        branch: s.branch,
        state: s.state,
        needsYou: s.state === "waiting" && !!s.blocked,
        activity: s.activity ?? s.summary,
        mode: s.mode === "headless" ? "run" : "terminal",
        agent: s.agent,
        pane: live ? s.herdrPane : null,
        threadId: s.threadId,
        prUrl: prs.get(s.branch) ?? null,
        worktree: s.worktree,
        startedAt: s.startedAt
      };
    })
    .sort((a, b) => Number(b.state !== "ended" && b.state !== "lost") - Number(a.state !== "ended" && a.state !== "lost") || Number(b.needsYou) - Number(a.needsYou) || b.startedAt - a.startedAt);
}

/** One open window: its surface, and the terminals its cells show. */
interface Open {
  surface: DesktopSurface;
  terminals: Map<string, TerminalStream>;
  /** Each cell's latest attach or detach: an attach that resolves after a newer one lets its stream go. */
  turns: Map<string, number>;
  timer: NodeJS.Timeout;
  closed: boolean;
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

  const bridge = async (): Promise<HerdrBridge> => (await ctx.get("herdr")?.bridge()) ?? { state: "notInstalled" };

  const state = async (projectId: string): Promise<WindowState> => {
    const b = await bridge();
    const setting = terminal();
    return {
      projectId,
      projectName: projectName(projectId),
      locale: ctx.settings.locale(),
      bridge: b,
      install: b.state === "notInstalled" ? await ctx.codeLink.herdrInstall() : null,
      // "auto" lands in herdr once it is installed; only a terminal named otherwise keeps sessions out of it.
      askSwitch: setting !== "herdr" && setting !== "auto" && !stateOf(config.stateFile).asked,
      terminal: setting,
      sessions: sessionRows(ctx.codeLink, ctx.items, projectId),
      layout: stateOf(config.stateFile).layouts?.[projectId] ?? fresh()
    };
  };

  const refresh = async (projectId: string) => {
    const win = open.get(projectId);
    if (!win || win.closed) return;
    const next = await state(projectId);
    if (!win.closed) win.surface.setState(next);
  };

  const post = (win: Open, message: WindowPost) => {
    if (!win.closed) win.surface.post(message);
  };

  const sessionOf = (projectId: string, id: string) => ctx.codeLink.sessionsOf(projectId).find((s) => s.id === id);

  const turn = (win: Open, cell: string) => {
    const next = (win.turns.get(cell) ?? 0) + 1;
    win.turns.set(cell, next);
    return next;
  };

  const detach = (win: Open, cell: string) => {
    turn(win, cell);
    const stream = win.terminals.get(cell);
    win.terminals.delete(cell);
    stream?.close();
  };

  const attach = async (projectId: string, win: Open, cell: string, sessionId: string, cols: number, rows: number) => {
    detach(win, cell);
    const mine = turn(win, cell);
    const pane = sessionOf(projectId, sessionId)?.herdrPane;
    const herdr = ctx.get("herdr");
    if (!pane || !herdr) return post(win, { type: "closed", cell, reason: words()("noTerminal") });
    let stream: TerminalStream;
    try {
      stream = await herdr.terminal(pane, { cols, rows });
    } catch (error) {
      return post(win, { type: "closed", cell, reason: error instanceof Error ? error.message : String(error) });
    }
    if (win.closed || win.turns.get(cell) !== mine) return stream.close();
    win.terminals.set(cell, stream);
    stream.onFrame((f) => post(win, { type: "frame", cell, seq: f.seq, width: f.width, height: f.height, full: f.full, bytes: f.bytes }));
    stream.onClose((reason) => {
      if (win.terminals.get(cell) !== stream) return;
      win.terminals.delete(cell);
      post(win, { type: "closed", cell, reason });
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

  const onMessage = async (projectId: string, win: Open, m: WindowMessage) => {
    switch (m.type) {
      case "attach":
        return attach(projectId, win, m.cell, m.sessionId, m.cols, m.rows);
      case "detach":
        return detach(win, m.cell);
      case "input":
        return win.terminals.get(m.cell)?.input(m.data);
      case "resize":
        return win.terminals.get(m.cell)?.resize(m.cols, m.rows);
      case "scroll":
        return win.terminals.get(m.cell)?.scroll(m);
      case "mouse":
        return win.terminals.get(m.cell)?.mouse(m);
      case "layout":
        return save(config.stateFile, { layouts: { ...stateOf(config.stateFile).layouts, [projectId]: m.layout } });
      case "continue":
        return command(projectId, win, "code-link.start-terminal", m.sessionId);
      case "openThread": {
        const s = sessionOf(projectId, m.sessionId);
        if (s?.threadId) return void ctx.emit("desktop/open", { projectId, threadId: s.threadId });
        return command(projectId, win, "code-link.open-thread", m.sessionId);
      }
      case "focusHerdr":
        return command(projectId, win, "code-link.open-terminal", m.sessionId);
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
        const r = await ctx.codeLink.installHerdr().catch((error: unknown) => ({ launched: false, command: error instanceof Error ? error.message : String(error) }));
        return post(win, { type: "toast", text: r.launched ? words()("installing") : words()("installYourself", { command: r.command }) });
      }
      case "openGuide":
        return void ctx.emit("desktop/open-external", (await ctx.codeLink.herdrInstall()).guide);
      case "switchTerminal": {
        save(config.stateFile, { asked: true });
        if (m.switch) {
          const settings = ctx.settings.get();
          ctx.settings.set({ ...settings, codeLink: { ...(settings.codeLink as object), terminal: "herdr" } });
        }
        return refresh(projectId);
      }
      case "refresh":
        return refresh(projectId);
    }
  };

  const show = async (projectId: string) => {
    const already = open.get(projectId);
    if (already && !already.closed) return void already.surface.setState(await state(projectId));
    const w = words();
    const win: Open = { surface: null as unknown as DesktopSurface, terminals: new Map(), turns: new Map(), timer: setInterval(() => void refresh(projectId), BRIDGE_POLL_MS), closed: false };
    win.timer.unref?.();
    open.set(projectId, win);
    win.surface = ctx.desktopSurfaces.open({
      id: `code-sessions.${projectId}`,
      title: w("windowTitle", { project: projectName(projectId) }),
      url: config.document,
      kind: "window",
      width: 1200,
      height: 760,
      minWidth: 640,
      minHeight: 400,
      initialState: await state(projectId),
      onMessage: (message) => void onMessage(projectId, win, message as WindowMessage).catch((error: unknown) => {
        ctx.logger.warn(`code sessions: ${(message as { type?: string }).type ?? "message"} failed: ${error instanceof Error ? error.message : String(error)}`);
        post(win, { type: "toast", text: error instanceof Error ? error.message : String(error) });
      }),
      onClose: () => {
        win.closed = true;
        clearInterval(win.timer);
        for (const cell of [...win.terminals.keys()]) detach(win, cell);
        if (open.get(projectId) === win) open.delete(projectId);
      }
    });
  };

  ctx.on("codeLink/changed", (projectId) => void refresh(projectId));
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
