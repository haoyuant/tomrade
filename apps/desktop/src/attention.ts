import { app, BrowserWindow, Notification } from "electron";
import type { Context } from "cordis";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/code-link";
import type {} from "@tomradex/ipc";

/** One thing an agent is waiting on the person for. */
export interface AttentionEntry {
  /** The thread when there is one, else the session: one entry per conversation. */
  key: string;
  projectId: string;
  threadId: string | null;
  itemId: string | null;
  itemKey: string | null;
  kind: "permission" | "question" | "waiting" | "stuck";
  /** Who is waiting: the coding agent's name, or null for the assistant. */
  who: string | null;
  /** The question, or what the agent last said. */
  text: string | null;
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** Everything an agent waits on the person for, across open projects. */
    "attention.list": () => AttentionEntry[];
  }
  interface Broadcasts {
    "attention.changed": (entries: AttentionEntry[]) => void;
    /** A notification was clicked: show its conversation. */
    "attention.open": (entry: AttentionEntry) => void;
  }
}

const WORDS = {
  en: {
    assistant: "The assistant",
    permission: "{who} needs your approval",
    question: "{who} is asking you something",
    waiting: "{who} is waiting for you",
    stuck: "{who} stopped"
  },
  zh: {
    assistant: "助手",
    permission: "{who} 需要你批准",
    question: "{who} 在问你问题",
    waiting: "{who} 在等你",
    stuck: "{who} 停下了"
  }
} as const;

const clip = (text: string | null | undefined, n = 160): string | null => {
  const line = text?.replace(/\s+/g, " ").trim();
  return line ? (line.length > n ? `${line.slice(0, n - 1)}…` : line) : null;
};

/**
 * Says when an agent is waiting on the person: a count on the Dock, a flash
 * of the taskbar, and — while no Tomrade window has focus — a notification
 * for each new thing, which opens its conversation when clicked. The renderer
 * reads the same list for the badges it draws.
 */
export const attention = {
  name: "attention",
  inject: ["ipc", "agent"],
  /** `notify: false` keeps the badges and drops the notifications — for checks that run with no window in front. */
  apply(ctx: Context, config: { notify?: boolean } = {}) {
    const notifies = config.notify !== false;
    let entries: AttentionEntry[] = [];
    let seen = new Map<string, AttentionEntry["kind"]>();
    let first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const words = () => {
      const pref = (ctx.get("settings")?.get() as { language?: string } | undefined)?.language;
      const lang = pref === "zh" || pref === "en" ? pref : app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en";
      return WORDS[lang];
    };

    const collect = (): AttentionEntry[] => {
      const out = new Map<string, AttentionEntry>();
      const itemOf = (projectId: string, itemId: string | null) => (itemId ? ctx.get("items")?.get(projectId, itemId)?.key ?? null : null);
      const codeLink = ctx.get("codeLink");
      const engineTitle = (id: string) => ctx.agent.codeEngines().find((e) => e.id === id)?.title ?? id;
      if (codeLink) {
        for (const projectId of ctx.get("db")?.openIds() ?? []) {
          for (const s of codeLink.sessionsOf(projectId)) {
            if (s.state !== "waiting" && s.state !== "error") continue;
            const key = s.threadId ? `thread:${s.threadId}` : `session:${s.id}`;
            const itemId = s.itemIds[0] ?? null;
            out.set(key, {
              key, projectId, threadId: s.threadId, itemId, itemKey: itemOf(projectId, itemId),
              kind: s.state === "error" ? "stuck" : "waiting",
              who: engineTitle(s.agent), text: clip(s.activity ?? s.summary)
            });
          }
        }
      }
      for (const a of ctx.agent.activities()) {
        if (!a.pending) continue;
        const key = `thread:${a.threadId}`;
        const thread = ctx.agent.store.thread(a.projectId, a.threadId);
        const itemId = thread?.itemId ?? null;
        const session = out.get(key);
        out.set(key, {
          key, projectId: a.projectId, threadId: a.threadId, itemId, itemKey: itemOf(a.projectId, itemId),
          kind: a.pending.kind === "permission" ? "permission" : "question",
          who: session?.who ?? (thread?.itemId ? engineTitle(thread.engine) : null),
          text: clip(a.pending.question.text)
        });
      }
      return [...out.values()].sort((x, y) => x.key.localeCompare(y.key));
    };

    const open = (entry: AttentionEntry) => {
      // the main window, not a plugin's surface (those never take focus)
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.getParentWindow() && w.isFocusable());
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      ctx.ipc.send("attention.open", entry);
    };

    const notify = (entry: AttentionEntry) => {
      if (!notifies || !Notification.isSupported()) return;
      const w = words();
      const title = [entry.itemKey, w[entry.kind].replace("{who}", entry.who ?? w.assistant)].filter(Boolean).join(" · ");
      const n = new Notification({ title, body: entry.text ?? "", silent: false });
      n.on("click", () => open(entry));
      n.show();
    };

    const refresh = () => {
      timer = undefined;
      const next = collect();
      const fresh = next.filter((e) => seen.get(e.key) !== e.kind);
      entries = next;
      seen = new Map(next.map((e) => [e.key, e.kind]));
      if (process.platform !== "win32") app.setBadgeCount(next.length);
      ctx.ipc.send("attention.changed", next);
      // what was already waiting when the app opened is on the badge, not a burst of notifications
      if (first) {
        first = false;
        return;
      }
      if (!fresh.length || BrowserWindow.getFocusedWindow()) return;
      if (process.platform === "win32") for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && win.isFocusable()) win.flashFrame(true);
      for (const entry of fresh) notify(entry);
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(refresh, 250);
    };

    ctx.ipc.handle("attention.list", () => entries);
    ctx.on("agent/event", (_threadId, event) => {
      if (event.type === "pending" || event.type === "done") schedule();
    });
    ctx.on("agent/run-ended", schedule);
    ctx.on("codeLink/changed", schedule);
    ctx.on("db/opened", schedule);
    // Focusing a window is the person seeing it: stop the taskbar asking.
    const onFocus = (_e: unknown, win: BrowserWindow) => win.flashFrame(false);
    app.on("browser-window-focus", onFocus);
    const sweep = setInterval(schedule, 30_000);
    schedule();
    ctx.effect(
      () => () => {
        clearTimeout(timer);
        clearInterval(sweep);
        app.off("browser-window-focus", onFocus);
        if (process.platform !== "win32") app.setBadgeCount(0);
      },
      "attention"
    );
  }
};

export default attention;
