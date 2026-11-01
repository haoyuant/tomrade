import { app, BrowserWindow, Notification } from "electron";
import type { Context } from "cordis";
import { z } from "zod";
import { PANEL_SURFACES, type RunView, type ThreadSummary } from "@tomradex/agent";
import type { SettingsSection } from "@tomradex/settings";
import { askLineIn } from "@tomradex/code-link";
import { PROMPT_LINES, promptOnScreen } from "@tomradex/code-link/prompt";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/night-shift";
import type { ImReminder } from "@tomradex/im";
import type {} from "@tomradex/pr-feedback";
import type {} from "@tomradex/watchdog";
import { showMainWindow, whenLoaded } from "./main-window.js";
import { PhonePush, type FetchLike, type PushFailure, type PushRequest, type PushTarget } from "./push.js";
import { DESKTOP_WORDS, type DesktopWords } from "./words.js";

/** One thing an agent is waiting on the person for. */
export interface AttentionEntry {
  /** The thread when there is one, else the session: one entry per conversation. */
  key: string;
  projectId: string;
  threadId: string | null;
  itemId: string | null;
  itemKey: string | null;
  /** `suspect`: it still runs, and only seems to get nowhere (the watchdog's word, not the agent's). */
  kind: "permission" | "question" | "waiting" | "stuck" | "suspect";
  /** Who is waiting: the coding agent's name, or null for the assistant. */
  who: string | null;
  /** The question, or what the agent last said. */
  text: string | null;
  /** Since when it has waited in this kind, as far as this run of the app has seen. */
  since: number;
  /** The terminal session, when it is one: opened in its cell, and answered on its screen. */
  sessionId?: string | null;
  /** Where the person may be told already: herdr's own window, while a client of its own is attached to show it (see `tomradeTells`). */
  toldIn?: "herdr";
  /**
   * The app closed while the conversation ran, and nobody has gone on since. That only ever shows up at a launch,
   * with a window in front: it is told then all the same, which another wait already there at launch is not.
   */
  interrupted?: true;
}

/** What opening an entry needs: the tray's running sessions are opened the same way. */
export type AttentionTarget = Pick<AttentionEntry, "projectId" | "threadId" | "itemId" | "sessionId">;

/** What one notification says, and the entry it opens when clicked. */
export interface AttentionNote {
  title: string;
  body: string;
  entry: AttentionEntry;
  /** What made it: a phone says how long something waited only where waiting is what happened. */
  event?: AttentionEntry["kind"] | "finished" | "lifted";
}

export interface NotificationPrefs {
  enabled: boolean;
  approvals: boolean;
  waiting: boolean;
  stopped: boolean;
  finished: boolean;
  /**
   * Where else the same notice reaches the person while they are away from the computer — one place, never two.
   * `push` reaches a phone through every address configured below.
   */
  away: "im" | "push" | "none";
  /** ntfy's topic address, as the person copied it; the topic is the secret. */
  pushNtfyCredential: string;
  /** Bark's device address, as the app shows it. */
  pushBarkCredential: string;
  /** A Feishu group bot's webhook. */
  pushFeishuCredential: string;
  /** What the agent last said, on top of the ticket's title: off unless the person asks for it. */
  pushSummary: boolean;
}

declare module "cordis" {
  interface Events {
    /** A notification was decided on — whether or not the system is asked to show it. */
    "attention/notified"(note: AttentionNote): void;
    /** The list changed: what the Dock badge counts and the tray menu lists. */
    "attention/changed"(entries: AttentionEntry[]): void;
    /** Somewhere outside the window (the tray menu) asked to show this entry, as a notification click does. */
    "attention/open"(entry: AttentionTarget): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** Everything an agent waits on the person for, across open projects. */
    "attention.list": () => AttentionEntry[];
    /** The last phone push that did not get through, for the settings pane. */
    "attention.pushStatus": () => PushFailure | null;
  }
  interface Broadcasts {
    "attention.changed": (entries: AttentionEntry[]) => void;
    /** A notification was clicked: show its conversation, or its terminal session in the panel. */
    "attention.open": (entry: AttentionTarget) => void;
  }
}

const en = DESKTOP_WORDS("en");
const zh = DESKTOP_WORDS("zh");
// macOS carries the count in the Dock, Linux in its launcher; Windows has neither — its code path only flashes the taskbar.
const NOTIFICATIONS_DESCRIPTION =
  process.platform === "darwin" ? "notificationsDescription" : process.platform === "win32" ? "notificationsDescriptionNoBadge" : "notificationsDescriptionNoDock";

export const NOTIFICATIONS_SECTION: SettingsSection<NotificationPrefs> = {
  id: "notifications",
  title: en("notificationsTitle"),
  description: en(NOTIFICATIONS_DESCRIPTION),
  schema: z.object({
    enabled: z.boolean().default(true).meta({ title: en("notifyEnabledTitle") }),
    approvals: z.boolean().default(true).meta({ title: en("notifyApprovalsTitle") }).describe(en("notifyApprovalsDescription")),
    waiting: z.boolean().default(true).meta({ title: en("notifyWaitingTitle") }).describe(en("notifyWaitingDescription")),
    stopped: z.boolean().default(true).meta({ title: en("notifyStoppedTitle") }).describe(en("notifyStoppedDescription")),
    finished: z.boolean().default(true).meta({ title: en("notifyFinishedTitle") }).describe(en("notifyFinishedDescription")),
    away: z.enum(["im", "push", "none"]).default("im").meta({ title: en("notifyAwayTitle") })
      .describe(en("notifyAwayDescription")),
    pushNtfyCredential: z.string().default("").meta({ title: en("notifyPushNtfyTitle") }).describe(en("notifyPushNtfyDescription")),
    pushBarkCredential: z.string().default("").meta({ title: en("notifyPushBarkTitle") }).describe(en("notifyPushBarkDescription")),
    pushFeishuCredential: z.string().default("").meta({ title: en("notifyPushFeishuTitle") }).describe(en("notifyPushFeishuDescription")),
    pushSummary: z.boolean().default(false).meta({ title: en("notifyPushSummaryTitle") }).describe(en("notifyPushSummaryDescription"))
  }),
  defaults: { enabled: true, approvals: true, waiting: true, stopped: true, finished: true, away: "im", pushNtfyCredential: "", pushBarkCredential: "", pushFeishuCredential: "", pushSummary: false },
  order: 15,
  scope: "user",
  agent: "write",
  words: {
    en: { fields: { away: { options: { im: en("notifyAwayIm"), push: en("notifyAwayPush"), none: en("notifyAwayNone") } } } },
    zh: {
      title: zh("notificationsTitle"),
      description: zh(NOTIFICATIONS_DESCRIPTION),
      fields: {
        enabled: { title: zh("notifyEnabledTitle") },
        approvals: { title: zh("notifyApprovalsTitle"), description: zh("notifyApprovalsDescription") },
        waiting: { title: zh("notifyWaitingTitle"), description: zh("notifyWaitingDescription") },
        stopped: { title: zh("notifyStoppedTitle"), description: zh("notifyStoppedDescription") },
        finished: { title: zh("notifyFinishedTitle"), description: zh("notifyFinishedDescription") },
        away: { title: zh("notifyAwayTitle"), description: zh("notifyAwayDescription"), options: { im: zh("notifyAwayIm"), push: zh("notifyAwayPush"), none: zh("notifyAwayNone") } },
        pushNtfyCredential: { title: zh("notifyPushNtfyTitle"), description: zh("notifyPushNtfyDescription") },
        pushBarkCredential: { title: zh("notifyPushBarkTitle"), description: zh("notifyPushBarkDescription") },
        pushFeishuCredential: { title: zh("notifyPushFeishuTitle"), description: zh("notifyPushFeishuDescription") },
        pushSummary: { title: zh("notifyPushSummaryTitle"), description: zh("notifyPushSummaryDescription") }
      }
    }
  }
};


const clip = (text: string | null | undefined, n = 160): string | null => {
  const line = text?.replace(/\s+/g, " ").trim();
  return line ? (line.length > n ? `${line.slice(0, n - 1)}…` : line) : null;
};

export interface TellerOptions {
  /** A coding session's turn ends with "waiting" every time; told only once it has waited this long. */
  waitingDelayMs: number;
  /** A run with no ticket is worth a "finished" only past this. */
  finishedAfterMs: number;
  prefs(): NotificationPrefs;
  /** Someone is looking at Tomrade: nothing needs telling. */
  focused(): boolean;
  words(): DesktopWords;
  tell(note: AttentionNote): void;
}

/**
 * Decides which changes to the attention list become a notification: each
 * entry once per kind, a coding session's "waiting" only once it has lasted,
 * nothing while a Tomrade window has focus, and nothing the person switched off.
 */
export class Teller {
  private told = new Map<string, AttentionEntry["kind"]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private current = new Map<string, AttentionEntry>();
  private failed = new Map<string, AttentionEntry>();
  private primed = false;

  constructor(private readonly options: TellerOptions) {}

  /** The list as it stands now. The first one is what already waited at launch: the badge has it, no notification does. */
  update(entries: AttentionEntry[]): void {
    this.current = new Map(entries.map((e) => [e.key, e]));
    for (const [key, kind] of this.told) if (this.current.get(key)?.kind !== kind) this.told.delete(key);
    for (const [key, timer] of this.timers) {
      if (this.current.get(key)?.kind === "waiting") continue;
      clearTimeout(timer);
      this.timers.delete(key);
    }
    if (!this.primed) {
      this.primed = true;
      for (const e of entries) if (!e.interrupted) this.told.set(e.key, e.kind);
    }
    for (const e of entries) {
      if (this.told.get(e.key) === e.kind || this.timers.has(e.key)) continue;
      if (e.kind !== "waiting") {
        this.decide(e);
        continue;
      }
      this.timers.set(
        e.key,
        setTimeout(() => {
          this.timers.delete(e.key);
          const now = this.current.get(e.key);
          if (now?.kind === "waiting" && this.told.get(e.key) !== "waiting") this.decide(now);
        }, this.options.waitingDelayMs)
      );
    }
    // a failed run that no coding session stands for has no entry of its own to say so
    for (const [key, entry] of this.failed) if (!this.current.has(key)) this.decide(entry);
    this.failed.clear();
  }

  /** A run ended. Errors are told by the next update, unless a session's entry already says it stopped. */
  ended(entry: Omit<AttentionEntry, "kind" | "since">, run: Pick<RunView, "status" | "startedAt" | "endedAt" | "error">, last: string | null): void {
    const now = Date.now();
    if (run.status === "error") {
      this.failed.set(entry.key, { ...entry, kind: "stuck", text: clip(run.error) ?? entry.text, since: now });
      return;
    }
    if (run.status !== "done") return;
    if (!entry.itemId && (run.endedAt ?? now) - run.startedAt < this.options.finishedAfterMs) return;
    const prefs = this.options.prefs();
    if (!prefs.enabled || !prefs.finished || this.options.focused()) return;
    this.options.tell({ title: this.titleOf(entry.itemKey, "finished", entry.who), body: clip(last) ?? "", entry: { ...entry, kind: "waiting", since: now }, event: "finished" });
  }

  /** A usage limit lifted on a conversation nobody continues on its own: the person may now. */
  lifted(entry: Omit<AttentionEntry, "kind" | "since">): void {
    const prefs = this.options.prefs();
    if (!prefs.enabled || !prefs.waiting || this.options.focused()) return;
    this.options.tell({ title: this.titleOf(entry.itemKey, "lifted", entry.who), body: this.options.words()("liftedBody"), entry: { ...entry, kind: "waiting", since: Date.now() }, event: "lifted" });
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private decide(entry: AttentionEntry): void {
    this.told.set(entry.key, entry.kind);
    const prefs = this.options.prefs();
    const on = entry.kind === "permission" || entry.kind === "question" ? prefs.approvals : entry.kind === "waiting" ? prefs.waiting : prefs.stopped;
    if (!prefs.enabled || !on || (this.options.focused() && !entry.interrupted)) return;
    this.options.tell({ title: this.titleOf(entry.itemKey, entry.kind, entry.who), body: entry.text ?? "", entry, event: entry.kind });
  }

  private titleOf(itemKey: string | null, key: AttentionEntry["kind"] | "finished" | "lifted", who: string | null): string {
    const w = this.options.words();
    return [itemKey, w(key, { who: who ?? w("assistant") })].filter(Boolean).join(" · ");
  }
}

/**
 * Whether the system notification is Tomrade's to show. herdr alerts in its own window, and only while a client of its
 * own is attached to show it: someone who uses Tomrade's Terminal window alone has nobody else to tell them.
 */
export async function tomradeTells(entry: Pick<AttentionEntry, "toldIn">, herdrClient: () => Promise<boolean>): Promise<boolean> {
  return !entry.toldIn || !(await herdrClient().catch(() => false));
}

/** What the tray's Allow presses for an entry, and pressing it. */
export interface TrayAllow {
  label: string;
  /** False when nothing was answered: the screen no longer asks, or the answer did not go. */
  allow(): Promise<boolean>;
}

/** Null where nothing may be answered from outside the entry's window. */
export async function allowOf(ctx: Context, entry: AttentionEntry, words: DesktopWords): Promise<TrayAllow | null> {
  const threadId = entry.threadId;
  // The assistant's own permission question: its first option, the yes every engine puts first, named as it is.
  if (entry.kind === "permission" && threadId) {
    const agent = ctx.get("agent");
    const pending = agent?.activities().find((a) => a.threadId === threadId)?.pending;
    const yes = pending?.kind === "permission" ? pending.question.options?.[0] : undefined;
    if (agent && pending && yes) {
      return {
        label: yes,
        allow: async () => {
          await agent.send(entry.projectId, threadId, { kind: "answer", questionId: pending.question.id, value: yes });
          return true;
        }
      };
    }
  }
  // A terminal session: only while its screen shows a permission prompt with yes under the cursor, read as the panel's Allow reads it.
  // Its hooks having said what it asks, its wait is listed as a permission; otherwise as waiting.
  const sessionId = entry.sessionId;
  const codeLink = ctx.get("codeLink");
  if ((entry.kind !== "waiting" && entry.kind !== "permission") || !sessionId || !codeLink) return null;
  const panel = codeLink.sessionPanel(entry.projectId, sessionId);
  if (panel.input !== "ok" || !panel.approval) return null;
  const screen = await codeLink.sessionTail(entry.projectId, sessionId, PROMPT_LINES).catch(() => null);
  if (!promptOnScreen(screen ?? "")?.allows) return null;
  // The answer reads the screen again and presses nothing on one that no longer asks.
  return { label: words("trayAllow"), allow: async () => (await codeLink.sessionAnswer(entry.projectId, sessionId, "allow")) === "answered" };
}

export interface ImRemindable { remind(n: ImReminder): boolean }

/** The one other place a notice reaches the person while they are away, as they chose. */
export function remindAway(prefs: NotificationPrefs, note: AttentionNote, im: ImRemindable | undefined): void {
  if (prefs.away !== "im") return;
  im?.remind({ projectId: note.entry.projectId, threadId: note.entry.threadId, kind: note.entry.kind, title: note.title, body: note.body });
}

export interface ImAnnounceable { announce(n: { key: string; title: string; body: string }): boolean }

/** News that belongs to no conversation reaches an IM the same way, for someone who chose it. */
export function announceAway(prefs: NotificationPrefs, key: string, notice: { title: string; body: string }, im: ImAnnounceable | undefined): void {
  if (prefs.away === "im") im?.announce({ key, ...notice });
}

/** A run's steps while the person is away: each to the IM they chose, and only what stopped a ticket to a phone. */
export function tellShiftSteps(prefs: NotificationPrefs, notices: { key: string; title: string; body: string }[], stuck: { title: string; body: string } | null, im: ImAnnounceable | undefined): { title: string; body: string } | null {
  for (const { key, ...notice } of notices) announceAway(prefs, `night-shift:${key}`, notice, im);
  return stuck && prefs.away === "push" && pushTargets(prefs).length ? stuck : null;
}

/**
 * What a phone gets: the ticket key and the event on the first line, the ticket's
 * own title and how long it waited under it. The agent's words only when asked —
 * the message passes through a service Tomrade does not run.
 */
export function phonePushRequest(prefs: NotificationPrefs, note: AttentionNote, subject: string | null, waitedMs: number, words: DesktopWords): PushRequest | null {
  if (prefs.away !== "push" || !pushTargets(prefs).length) return null;
  const n = Math.max(1, Math.round(waitedMs / 1000));
  const duration = n < 60 ? words("pushSeconds", { n }) : n < 3600 ? words("pushMinutes", { n: Math.round(n / 60) }) : words("pushHours", { n: Math.round(n / 3600) });
  const waited = note.event === "finished" || note.event === "lifted" ? null : words("pushWaited", { duration });
  return {
    title: note.title,
    body: [subject, waited, prefs.pushSummary ? note.body : null].filter(Boolean).join("\n")
  };
}

/** Every address the person gave, in the order a failure is reported. */
export function pushTargets(prefs: NotificationPrefs): PushTarget[] {
  return [
    prefs.pushNtfyCredential && ({ channel: "ntfy", url: prefs.pushNtfyCredential } as const),
    prefs.pushBarkCredential && ({ channel: "bark", url: prefs.pushBarkCredential } as const),
    prefs.pushFeishuCredential && ({ channel: "feishu", url: prefs.pushFeishuCredential } as const)
  ].filter((target): target is PushTarget => !!target);
}

/**
 * Says when an agent is waiting on the person: a count on the Dock, a flash
 * of the taskbar, and — while no Tomrade window has focus — a notification
 * for each new thing, which opens its conversation when clicked. The renderer
 * reads the same list for the badges it draws.
 */
export const attention = {
  name: "attention",
  inject: ["ipc", "agent", "settings"],
  /**
   * `notify: false` decides as usual but never asks the system to show anything — for checks that run with no window in front.
   * The delays are there for those checks too.
   */
  apply(ctx: Context, config: { notify?: boolean; waitingDelayMs?: number; finishedAfterMs?: number } = {}) {
    const shows = config.notify !== false;
    ctx.settings.register(NOTIFICATIONS_SECTION);
    let entries: AttentionEntry[] = [];
    let since = new Map<string, { kind: AttentionEntry["kind"]; at: number }>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const words = () => DESKTOP_WORDS(ctx.settings.locale());
    const prefsOf = (): NotificationPrefs => ({ ...NOTIFICATIONS_SECTION.defaults, ...(ctx.settings.get().notifications as Partial<NotificationPrefs> | undefined) });
    const phone = new PhonePush({ fetch: globalThis.fetch as unknown as FetchLike });
    const engineTitle = (id: string) => ctx.agent.codeEngines().find((e) => e.id === id)?.title ?? id;
    const itemKeyOf = (projectId: string, itemId: string | null) => (itemId ? ctx.get("items")?.get(projectId, itemId)?.key ?? null : null);

    const collect = (): Omit<AttentionEntry, "since">[] => {
      const out = new Map<string, Omit<AttentionEntry, "since">>();
      const codeLink = ctx.get("codeLink");
      if (codeLink) {
        for (const projectId of ctx.get("db")?.openIds() ?? []) {
          for (const s of codeLink.sessionsOf(projectId, undefined, { live: true })) {
            if (s.state !== "waiting" && s.state !== "error") continue;
            const key = s.threadId ? `thread:${s.threadId}` : `session:${s.id}`;
            const itemId = s.itemIds[0] ?? null;
            out.set(key, {
              key, projectId, threadId: s.threadId, itemId, itemKey: itemKeyOf(projectId, itemId),
              // what it asks says what kind of waiting it is: a tool's permission, a question
              kind: s.state === "error" ? "stuck" : s.ask?.kind === "permission" ? "permission" : s.ask?.kind === "question" ? "question" : "waiting",
              who: engineTitle(s.agent), text: clip(s.state !== "error" && s.ask ? askLineIn(s.ask, ctx.settings.locale()) : (s.activity ?? s.summary)), sessionId: s.id,
              // herdr may say so in its own window; Tomrade's own terminal host does not.
              ...(s.herdrPane && ctx.get("terminals")?.kind === "herdr" ? { toldIn: "herdr" as const } : {})
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
          key, projectId: a.projectId, threadId: a.threadId, itemId, itemKey: itemKeyOf(a.projectId, itemId),
          kind: a.pending.kind === "permission" ? "permission" : "question",
          who: session?.who ?? (thread?.itemId ? engineTitle(thread.engine) : null),
          text: clip(a.pending.question.text),
          ...(session?.sessionId ? { sessionId: session.sessionId } : {})
        });
      }
      // the app closed mid-run: the conversation waits on the person to go on, or to wave it away
      for (const projectId of ctx.get("db")?.openIds() ?? []) {
        for (const thread of ctx.agent.store.interruptedThreads(projectId, PANEL_SURFACES)) {
          const key = `thread:${thread.id}`;
          if (out.has(key)) continue;
          out.set(key, {
            key, projectId, threadId: thread.id, itemId: thread.itemId, itemKey: itemKeyOf(projectId, thread.itemId), kind: "stuck",
            who: thread.itemId ? engineTitle(thread.engine) : null, text: clip(ctx.agent.store.interruptedRun(projectId, thread.id)?.error), interrupted: true
          });
        }
      }
      // pull request feedback that could not, or may not, go to the agent by itself
      for (const notice of ctx.get("prFeedback")?.notices() ?? []) {
        const key = `pr:${notice.key}`;
        out.set(key, {
          key, projectId: notice.projectId, threadId: notice.threadId, itemId: notice.itemId, itemKey: itemKeyOf(notice.projectId, notice.itemId), kind: "waiting",
          who: engineTitle(notice.agent), text: clip(notice.text), sessionId: notice.sessionId
        });
      }
      // what the watchdog suspects of a run; a wait of its own already says more
      for (const notice of ctx.get("watchdog")?.notices() ?? []) {
        const key = `thread:${notice.threadId}`;
        if (out.has(key)) continue;
        const sessionId = codeLink?.sessionsOf(notice.projectId, undefined, { live: true, threadId: notice.threadId })[0]?.id;
        out.set(key, {
          key, projectId: notice.projectId, threadId: notice.threadId, itemId: notice.itemId, itemKey: itemKeyOf(notice.projectId, notice.itemId), kind: "suspect",
          who: notice.itemId ? engineTitle(notice.engine) : null, text: clip(notice.text), ...(sessionId ? { sessionId } : {})
        });
      }
      return [...out.values()].sort((x, y) => x.key.localeCompare(y.key));
    };

    const open = async (target: AttentionTarget) => {
      // A terminal session goes to its cell while its project's Terminal window is open; anything else to the main window's panel.
      const codeLink = ctx.get("codeLink");
      if (target.sessionId && codeLink && ctx.bail("codeLink/session-cells", target.projectId) && (await codeLink.showSession(target.projectId, target.sessionId).catch(() => false))) return;
      // Running in the background there may be no window yet: one opens, and hears the entry once it has loaded.
      const win = showMainWindow();
      if (win) whenLoaded(win, () => ctx.ipc.send("attention.open", target));
      else ctx.ipc.send("attention.open", target);
    };
    const herdrClient = () => ctx.get("herdr")?.clientAttached() ?? Promise.resolve(false);
    const show = (note: AttentionNote) => {
      if (process.platform === "win32") for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && win.isFocusable()) win.flashFrame(true);
      const n = new Notification({ title: note.title, body: note.body, silent: false });
      n.on("click", () => void open(note.entry));
      n.show();
    };

    const teller = new Teller({
      waitingDelayMs: config.waitingDelayMs ?? 15_000,
      finishedAfterMs: config.finishedAfterMs ?? 30_000,
      prefs: prefsOf,
      focused: () => !!BrowserWindow.getFocusedWindow(),
      words,
      tell: (note) => {
        ctx.emit("attention/notified", note);
        try {
          remindAway(prefsOf(), note, ctx.get("im") as ImRemindable | undefined);
        } catch (e) {
          ctx.logger.warn(`couldn't remind in IM: ${(e as Error).message}`);
        }
        const away = prefsOf();
        const subject = note.entry.itemId ? ctx.get("items")?.get(note.entry.projectId, note.entry.itemId)?.title ?? null : null;
        const toPhone = phonePushRequest(away, note, subject, Date.now() - note.entry.since, words());
        if (toPhone) {
          void phone
            .send(pushTargets(away), toPhone)
            .then((failure) => {
              if (failure) ctx.logger.warn(`couldn't push to ${failure.channel}: ${failure.error}`);
            })
            .catch((e) => ctx.logger.warn(`couldn't push: ${(e as Error).message}`));
        }
        if (!shows || !Notification.isSupported()) return;
        void tomradeTells(note.entry, herdrClient).then((ours) => ours && show(note));
      }
    });

    // What a night shift came to reaches a phone or a chat the way anything else does while the person is away.
    ctx.on("nightShift/briefed", (shift, notice) => {
      const away = prefsOf();
      try {
        announceAway(away, `night-shift:${shift.id}`, notice, ctx.get("im") as ImAnnounceable | undefined);
      } catch (e) {
        ctx.logger.warn(`couldn't tell IM: ${(e as Error).message}`);
      }
      if (away.away === "push" && pushTargets(away).length) void phone.send(pushTargets(away), notice).catch((e) => ctx.logger.warn(`couldn't push: ${(e as Error).message}`));
    });

    ctx.on("nightShift/step", (_shift, notices, stuck) => {
      const away = prefsOf();
      try {
        const toPhone = tellShiftSteps(away, notices, stuck, ctx.get("im") as ImAnnounceable | undefined);
        if (toPhone) void phone.send(pushTargets(away), toPhone).catch((e) => ctx.logger.warn(`couldn't push: ${(e as Error).message}`));
      } catch (e) {
        ctx.logger.warn(`couldn't tell IM: ${(e as Error).message}`);
      }
    });

    const refresh = () => {
      timer = undefined;
      const now = Date.now();
      entries = collect().map((e) => {
        const was = since.get(e.key);
        return { ...e, since: was?.kind === e.kind ? was.at : now };
      });
      since = new Map(entries.map((e) => [e.key, { kind: e.kind, at: e.since }]));
      if (process.platform !== "win32") app.setBadgeCount(entries.length);
      ctx.ipc.send("attention.changed", entries);
      ctx.emit("attention/changed", entries);
      teller.update(entries);
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(refresh, 250);
    };

    const lastSaid = (thread: ThreadSummary, runId: string): string | null => {
      const said = ctx.agent.store.messages(thread.projectId, thread.id).filter((m) => m.runId === runId && m.role === "agent" && m.block.type === "text");
      const block = said.at(-1)?.block;
      return block?.type === "text" ? block.text : null;
    };

    ctx.ipc.handle("attention.list", () => entries);
    ctx.ipc.handle("attention.pushStatus", () => phone.lastFailure());
    ctx.on("agent/event", (_threadId, event) => {
      if (event.type === "pending" || event.type === "done") schedule();
    });
    ctx.on("agent/run-ended", (run, thread) => {
      // The troubleshooter's test turn: its thread is gone already, and nobody waits on it.
      if (thread.surface === "probe") return;
      const who = thread.itemId ? engineTitle(thread.engine) : null;
      teller.ended(
        { key: `thread:${thread.id}`, projectId: thread.projectId, threadId: thread.id, itemId: thread.itemId, itemKey: itemKeyOf(thread.projectId, thread.itemId), who, text: null },
        run,
        run.status === "done" ? lastSaid(thread, run.id) : null
      );
      schedule();
    });
    ctx.on("agent/limit-lifted", (_park, thread) => {
      const who = thread.itemId ? engineTitle(thread.engine) : null;
      teller.lifted({ key: `thread:${thread.id}`, projectId: thread.projectId, threadId: thread.id, itemId: thread.itemId, itemKey: itemKeyOf(thread.projectId, thread.itemId), who, text: null });
    });
    ctx.on("codeLink/changed", schedule);
    ctx.on("prFeedback/changed", schedule);
    ctx.on("watchdog/changed", schedule);
    ctx.on("agent/interrupted-changed", schedule);
    ctx.on("db/opened", schedule);
    ctx.on("attention/open", (target) => void open(target));
    // Focusing a window is the person seeing it: stop the taskbar asking.
    const onFocus = (_e: unknown, win: BrowserWindow) => win.flashFrame(false);
    app.on("browser-window-focus", onFocus);
    const sweep = setInterval(schedule, 30_000);
    schedule();
    ctx.effect(
      () => () => {
        clearTimeout(timer);
        clearInterval(sweep);
        teller.dispose();
        app.off("browser-window-focus", onFocus);
        if (process.platform !== "win32") app.setBadgeCount(0);
      },
      "attention"
    );
  }
};

export default attention;
