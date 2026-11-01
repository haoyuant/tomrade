import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { promisify } from "node:util";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import { githubPull, type SessionView } from "@tomradex/code-link";
import { errorMessage } from "@tomradex/contracts";
import type {} from "@tomradex/db";
import type {} from "@tomradex/github";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/items";
import type {} from "@tomradex/repos";
import type { SettingsSection } from "@tomradex/settings";
import { checksOf, ciEvent, commentEvents, inlineEvents, loginsOf, reviewEvents, standingOf, wakeText, type PrEvent, type Span } from "./rules.js";
import { FeedbackStore, MIGRATIONS, TABLES, type EventState, type HeldEvent, type Notice, type NoticeKind, type Watch } from "./store.js";
import { PR_FEEDBACK_WORDS } from "./words.js";

const run = promisify(execFile);

/** What a person sees waiting on them: Tomrade could not, or may not, hand feedback to the agent. */
export interface PrNotice {
  key: string;
  projectId: string;
  itemId: string;
  threadId: string | null;
  sessionId: string | null;
  agent: string;
  text: string;
}

declare module "cordis" {
  interface Context {
    prFeedback: PrFeedback;
  }
  interface Events {
    "prFeedback/changed"(): void;
  }
}

export const PrFeedbackConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** The pace of code link's own scan: feedback reaches the agent within one look. */
    intervalMs: z.number().int().min(50).default(120_000),
    /** Pull requests read in one look, so one project with many open cannot spend the rate limit. */
    maxPulls: z.number().int().min(1).default(30)
  })
);
export type PrFeedbackConfig = z.output<typeof PrFeedbackConfig>;

interface Prefs {
  enabled: boolean;
  maxWakes: number;
  allowedLogins: string;
}

const w = PR_FEEDBACK_WORDS;
const en = w("en");
const zh = w("zh");

/** Machine scope, and no agent access past reading: an agent never turns on what wakes agents. */
const SECTION: SettingsSection<Prefs> = {
  id: "prFeedback",
  title: en("sectionTitle"),
  description: en("sectionDescription"),
  schema: z.object({
    enabled: z.boolean().default(false).meta({ title: en("enabledTitle") }).describe(en("enabledDescription")),
    maxWakes: z.number().int().min(1).max(50).default(5).meta({ title: en("maxWakesTitle") }).describe(en("maxWakesDescription")),
    allowedLogins: z.string().default("").meta({ title: en("allowedLoginsTitle") }).describe(en("allowedLoginsDescription"))
  }),
  defaults: { enabled: false, maxWakes: 5, allowedLogins: "" },
  order: 16,
  words: {
    zh: {
      title: zh("sectionTitle"),
      description: zh("sectionDescription"),
      fields: {
        enabled: { title: zh("enabledTitle"), description: zh("enabledDescription") },
        maxWakes: { title: zh("maxWakesTitle"), description: zh("maxWakesDescription") },
        allowedLogins: { title: zh("allowedLoginsTitle"), description: zh("allowedLoginsDescription") }
      }
    }
  }
};

/** One automated reviewer's back and forth is enough. */
const MAX_BOT_ROUNDS = 3;
/** Failures in a row before the person hears a pull request cannot be read: one is the network. */
const UNREADABLE_AFTER = 3;
/** GitHub's clock and the end of a run do not line up to the second. */
const RUN_GRACE_MS = 30_000;

export interface PullReader {
  read<T>(route: string, pick: (raw: unknown) => T): Promise<T>;
}

/** Answers remembered: routes name commits, so without a bound a long run would hold every commit it ever looked at. */
const MAX_HELD = 500;

/** Remembers each answer's ETag, so what did not change costs no rate limit. `pick` keeps only what is used of a large answer. */
class GitHubReader implements PullReader {
  private readonly held = new Map<string, { etag: string; value: unknown }>();

  constructor(private readonly ctx: Context) {}

  async read<T>(route: string, pick: (raw: unknown) => T): Promise<T> {
    const held = this.held.get(route);
    if (await this.ctx.github.token()) {
      try {
        const answer = await this.ctx.github.api.conditional<unknown>(route, held?.etag ?? null);
        if (!answer) return held!.value as T;
        const value = pick(answer.body);
        if (answer.etag) {
          this.held.delete(route);
          this.held.set(route, { etag: answer.etag, value });
          if (this.held.size > MAX_HELD) this.held.delete(this.held.keys().next().value!);
        }
        return value;
      } catch {
        // Not readable with this account: gh may still have one that is.
      }
    }
    const { stdout } = await run("gh", ["api", route.slice(1)], { cwd: os.homedir(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return pick(JSON.parse(stdout));
  }
}

interface PullFacts {
  open: boolean;
  head: string | null;
  author: string | null;
  updated: string | null;
}

const pullFacts = (raw: unknown): PullFacts => {
  const pull = raw as { state?: string; head?: { sha?: string }; user?: { login?: string }; updated_at?: string };
  return { open: pull.state === "open", head: pull.head?.sha ?? null, author: pull.user?.login ?? null, updated: pull.updated_at ?? null };
};

const keep = <K extends string>(rows: unknown, keys: readonly K[]): Record<K, unknown>[] =>
  (Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []).map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])) as Record<K, unknown>);

const CHECK_KEYS = ["name", "status", "conclusion", "html_url", "details_url"] as const;
const STATUS_KEYS = ["context", "state", "target_url"] as const;

interface Target {
  id: string;
  itemId: string;
  delivery: number;
  repo: string;
  number: number;
  url: string | null;
  session: SessionView;
}

/**
 * Brings what happens on a ticket's open pull request back to the agent working the ticket: failed CI, reviews, people's
 * comments. Who may wake an agent is settled here from GitHub's facts, never from what a comment says, and everything
 * else is only recorded. Off, it asks GitHub nothing.
 */
export class PrFeedback extends Service {
  static provide = "prFeedback";
  static inject = ["db", "settings", "items", "repos", "hub", "github", "agent", "codeLink"];
  static Config = PrFeedbackConfig;

  /** Replaceable, so tests never reach the network. */
  reader: PullReader;

  private readonly home: Context;
  private readonly store: FeedbackStore;
  private looking = false;
  private on = false;

  constructor(
    ctx: Context,
    public readonly config: PrFeedbackConfig
  ) {
    super(ctx, "prFeedback");
    this.home = ctx;
    this.reader = new GitHubReader(ctx);
    this.store = new FeedbackStore((projectId) => ctx.db.for(projectId));
  }

  [Service.init]() {
    this.home.db.migrate("prfeedback", MIGRATIONS, { tables: TABLES });
    this.home.settings.register(SECTION);
    this.on = this.prefs().enabled;
    const timer = setInterval(() => void this.look(), this.config.intervalMs);
    timer.unref?.();
    this.home.effect(() => () => clearInterval(timer), "pr feedback look");
    this.home.on("settings/changed", () => {
      const on = this.prefs().enabled;
      if (on === this.on) return;
      this.on = on;
      if (on) return void this.look();
      // Turned on again later it starts from then: what happened while off was not asked for.
      for (const projectId of this.home.db.openIds()) this.store.clear(projectId);
      this.home.emit("prFeedback/changed");
    });
  }

  private prefs(): Prefs {
    return { ...SECTION.defaults, ...(this.home.settings.get().prFeedback as Partial<Prefs> | undefined) };
  }

  /** What waits on the person, in their language. */
  notices(): PrNotice[] {
    if (!this.on) return [];
    const speak = w(this.home.settings.locale());
    const say = (watch: Watch, notice: Notice): string => {
      const number = watch.number;
      const words: Record<NoticeKind, () => string> = {
        capped: () => speak("noticeCapped", { number, max: this.prefs().maxWakes }),
        unreachable: () => speak("noticeUnreachable", { number }),
        locked: () => speak("noticeLocked", { number }),
        refused: () => speak("noticeRefused", { number, why: notice.why ?? "" }),
        unreadable: () => speak("noticeUnreadable", { number })
      };
      return words[notice.kind]();
    };
    return this.home.db.openIds().flatMap((projectId) =>
      this.store.watches(projectId).flatMap((watch) =>
        watch.notice ? [{ key: watch.id, projectId, itemId: watch.itemId, threadId: watch.notice.threadId, sessionId: watch.notice.sessionId, agent: watch.notice.agent, text: say(watch, watch.notice) }] : []
      )
    );
  }

  /** One pass over the open projects; a pass still going is left to finish. */
  async look(): Promise<void> {
    if (!this.on || this.looking) return;
    this.looking = true;
    try {
      for (const projectId of this.home.db.openIds()) {
        try {
          await this.lookAt(projectId);
        } catch (error) {
          this.home.logger("pr-feedback").warn(`look at ${projectId} failed: ${errorMessage(error)}`);
        }
      }
    } finally {
      this.looking = false;
    }
  }

  private async lookAt(projectId: string): Promise<void> {
    const targets = await this.targets(projectId);
    const followed = new Set(targets.map((target) => target.id));
    let moved = false;
    for (const watch of this.store.watches(projectId)) {
      if (followed.has(watch.id)) continue;
      moved ||= !!watch.notice;
      this.store.drop(projectId, watch.id);
    }
    for (const target of targets.slice(0, this.config.maxPulls)) moved = (await this.lookAtPull(projectId, target)) || moved;
    if (moved) this.home.emit("prFeedback/changed");
  }

  /** Open pull requests of this delivery of tickets still open, whose agent ran on this machine. */
  private async targets(projectId: string): Promise<Target[]> {
    const { codeLink, items, repos, hub } = this.home;
    const out: Target[] = [];
    for (const link of codeLink.store.openPulls(projectId)) {
      const item = items.get(projectId, link.itemId);
      if (!item || item.status === "done" || item.status === "cancelled") continue;
      if (link.delivery !== codeLink.store.activeDelivery(projectId, item.id)?.sequence) continue;
      const repo = repos.get(projectId, link.repoId);
      const ref = repo ? await githubPull(link.prUrl, link.prNumber, repo.remote) : null;
      if (!ref) continue;
      const session = codeLink.sessionsOf(projectId, item.id, { delivery: link.delivery }).filter((s) => s.device === hub.deviceId).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (!session) continue;
      out.push({ id: `${ref.repo}#${ref.number}:${item.id}`, itemId: item.id, delivery: link.delivery, repo: ref.repo, number: ref.number, url: link.prUrl, session });
    }
    return out;
  }

  /** True when what waits on the person changed. */
  private async lookAtPull(projectId: string, target: Target): Promise<boolean> {
    const fresh = !this.store.watch(projectId, target.id);
    if (fresh) this.store.add({ id: target.id, projectId, itemId: target.itemId, delivery: target.delivery, repo: target.repo, number: target.number, url: target.url, watchedFrom: Date.now() });
    const before = this.store.watch(projectId, target.id)!;
    const had = before.notice;
    try {
      const open = await this.readPull(projectId, target, before, fresh);
      if (!open) {
        this.store.drop(projectId, target.id);
        return !!had;
      }
      this.store.patch(projectId, target.id, { failures: 0, ...(this.store.watch(projectId, target.id)?.notice?.kind === "unreadable" ? { notice: null } : {}) });
      this.deliver(projectId, target);
    } catch (error) {
      const failures = before.failures + 1;
      this.home.logger("pr-feedback").warn(`${target.repo}#${target.number} was not read: ${errorMessage(error)}`);
      this.store.patch(projectId, target.id, { failures, ...(failures >= UNREADABLE_AFTER && !had ? { notice: this.noticeOf(target, "unreadable") } : {}) });
    }
    return JSON.stringify(this.store.watch(projectId, target.id)?.notice ?? null) !== JSON.stringify(had);
  }

  /** Reads what changed into events; false when the pull request has ended. */
  private async readPull(projectId: string, target: Target, watch: Watch, fresh: boolean): Promise<boolean> {
    const base = `/repos/${target.repo}`;
    const pull = await this.reader.read(`${base}/pulls/${target.number}`, pullFacts);
    if (!pull.open) return false;
    if (pull.head !== watch.head) {
      this.store.supersede(projectId, target.id);
      this.store.patch(projectId, target.id, { head: pull.head, ...(watch.notice && watch.notice.kind !== "unreadable" ? { notice: null } : {}) });
    }
    // `updated_at` moves with every comment and review, so an unchanged one needs no further reading.
    if (pull.updated !== watch.updated) {
      const since = new Date(watch.watchedFrom).toISOString();
      const [comments, inline, reviews] = await Promise.all([
        this.reader.read(`${base}/issues/${target.number}/comments?since=${since}&per_page=100`, commentEvents),
        this.reader.read(`${base}/pulls/${target.number}/comments?since=${since}&per_page=100`, inlineEvents),
        this.reader.read(`${base}/pulls/${target.number}/reviews?per_page=100`, reviewEvents)
      ]);
      const allowed = loginsOf(this.prefs().allowedLogins);
      const agentRan = this.agentRan(projectId, target.session);
      for (const event of [...comments, ...inline, ...reviews]) {
        if (event.at < watch.watchedFrom) continue;
        const standing = standingOf(event, { author: pull.author, allowed, agentRan });
        const state: EventState = standing === "person" || (standing === "bot" && watch.botRounds < MAX_BOT_ROUNDS) ? "pending" : "ignored";
        this.store.record(projectId, target.id, event, state);
      }
      this.store.patch(projectId, target.id, { updated: pull.updated });
    }
    // Passed CI keeps being looked at: a later check of the same commit can still fail, and an unchanged answer costs nothing.
    if (pull.head && pull.head !== watch.reported) {
      const runs = await this.reader.read(`${base}/commits/${pull.head}/check-runs?per_page=100`, (raw) => ({ check_runs: keep((raw as { check_runs?: unknown }).check_runs, CHECK_KEYS) }));
      const statuses = await this.reader.read(`${base}/commits/${pull.head}/status?per_page=100`, (raw) => ({ statuses: keep((raw as { statuses?: unknown }).statuses, STATUS_KEYS) }));
      const checks = checksOf(runs, statuses);
      if (checks.state === "failed") {
        // Already red when first seen is not news: it was so before anyone asked to hear.
        if (!fresh) this.store.record(projectId, target.id, ciEvent(pull.head, checks.failed, Date.now()), "pending");
        this.store.patch(projectId, target.id, { reported: pull.head });
      }
    }
    return true;
  }

  /** When the agent was at work, so what it wrote under the pull request's own account does not wake it. */
  private agentRan(projectId: string, session: SessionView): Span[] {
    const now = Date.now();
    if (session.mode === "headless" && session.threadId) return this.home.agent.store.runs(projectId, session.threadId).map((r) => ({ from: r.startedAt, to: (r.endedAt ?? now) + RUN_GRACE_MS }));
    return [{ from: session.startedAt, to: (session.endedAt ?? now) + RUN_GRACE_MS }];
  }

  private noticeOf(target: Target, kind: NoticeKind, why?: string): Notice {
    const { session } = target;
    return { kind, threadId: session.threadId, sessionId: session.id, agent: session.agent, ...(why ? { why } : {}) };
  }

  private deliver(projectId: string, target: Target): void {
    const pending = this.store.pending(projectId, target.id);
    if (!pending.length) return;
    const watch = this.store.watch(projectId, target.id)!;
    const ids = pending.map((event) => event.id);
    const tell = (state: EventState, kind: NoticeKind, why?: string) => {
      this.store.settle(projectId, target.id, ids, state);
      this.store.patch(projectId, target.id, { notice: this.noticeOf(target, kind, why) });
    };
    if (this.home.items.get(projectId, target.itemId)?.humanLocked) return tell("noticed", "locked");
    const { session } = target;
    // A terminal is the person's to type in: nothing is ever written there for them.
    if (session.mode !== "headless" || !session.threadId) return tell("noticed", "unreachable");
    const threadId = session.threadId;
    // It hears at the look after this turn or question ends; what came meanwhile goes along.
    if (this.home.agent.activeRuns().some(({ thread }) => thread.id === threadId) || this.home.agent.store.pending(projectId, threadId)) return;
    if (this.store.wakes(projectId, target.itemId, target.delivery) >= this.prefs().maxWakes) return tell("capped", "capped");
    this.wake(projectId, target, watch, threadId, pending, tell);
  }

  private wake(projectId: string, target: Target, watch: Watch, threadId: string, pending: HeldEvent[], tell: (state: EventState, kind: NoticeKind, why?: string) => void): void {
    const named = pending.find((event) => event.batch)?.batch;
    const events = named ? pending.filter((event) => event.batch === named) : pending;
    const eventIds = events.map((event) => event.id);
    const batch = named ?? createHash("sha256").update(`${target.id}\n${eventIds.join("\n")}`).digest("hex").slice(0, 32);
    if (!named) this.store.batch(projectId, target.id, batch, eventIds);
    try {
      const text = wakeText({ number: watch.number, url: watch.url }, events satisfies PrEvent[]);
      this.home.agent.send(projectId, threadId, { kind: "text", text }, { requestId: `pr-feedback:${batch}`, source: { kind: "pr-feedback", pull: `${target.repo}#${target.number}` } });
    } catch (error) {
      tell("noticed", "refused", errorMessage(error));
      return;
    }
    this.store.settle(projectId, target.id, eventIds, "delivered");
    this.store.woke(projectId, target.id, events.some((event) => event.bot));
  }
}
