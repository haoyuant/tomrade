import { Context, Service } from "cordis";
import { z } from "zod";
import type { AgentEvent, RunView, ThreadSummary } from "@tomradex/agent";
import { errorMessage } from "@tomradex/contracts";
import { languageName } from "@tomradex/domain";
import type {} from "@tomradex/items";
import type { LlmService } from "@tomradex/llm";
import type { SettingsSection } from "@tomradex/settings";
import { LOOP_AFTER, Verdict, dueForJudgement, heard, judgeSystem, judgeUser, suspicionOf, type Watch } from "./rules.js";
import { WATCHDOG_WORDS } from "./words.js";

/** What the person should hear about one run. */
export interface RunNotice {
  projectId: string;
  threadId: string;
  itemId: string | null;
  engine: string;
  text: string;
}

declare module "cordis" {
  interface Context {
    watchdog: Watchdog;
  }
  interface Events {
    "watchdog/changed"(): void;
  }
}

export const WatchdogConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    intervalMs: z.number().int().min(50).default(60_000),
    /** How often a long run may be asked about, and how long it runs before the first time. */
    judgeEveryMs: z.number().int().min(50).default(60 * 60_000)
  })
);
export type WatchdogConfig = z.output<typeof WatchdogConfig>;

interface Prefs {
  enabled: boolean;
  silentMinutes: number;
  judge: boolean;
}

const w = WATCHDOG_WORDS;
const en = w("en");
const zh = w("zh");

// 15: in 30 days of real runs the longest quiet stretch of one that went on to finish was 11 minutes.
const SECTION: SettingsSection<Prefs> = {
  id: "watchdog",
  title: en("sectionTitle"),
  description: en("sectionDescription"),
  schema: z.object({
    enabled: z.boolean().default(true).meta({ title: en("enabledTitle") }).describe(en("enabledDescription")),
    silentMinutes: z.number().int().min(5).max(240).default(15).meta({ title: en("silentMinutesTitle") }).describe(en("silentMinutesDescription")),
    judge: z.boolean().default(true).meta({ title: en("judgeTitle") }).describe(en("judgeDescription"))
  }),
  defaults: { enabled: true, silentMinutes: 15, judge: true },
  order: 17,
  words: {
    zh: {
      title: zh("sectionTitle"),
      description: zh("sectionDescription"),
      fields: {
        enabled: { title: zh("enabledTitle"), description: zh("enabledDescription") },
        silentMinutes: { title: zh("silentMinutesTitle"), description: zh("silentMinutesDescription") },
        judge: { title: zh("judgeTitle"), description: zh("judgeDescription") }
      }
    }
  }
};

/** What a day of checks may cost, whatever else goes wrong. */
const MAX_JUDGEMENTS_A_DAY = 10;
/** A look this late means the machine slept: nothing was quiet, it was not running. */
const ASLEEP_AFTER_LOOKS = 3;

/**
 * Watches the runs Tomrade started, from their events alone: no table is read, and nothing is written to a run.
 * Terminal sessions stay out: their hooks cannot tell a person's interruption from a hung agent.
 */
export class Watchdog extends Service {
  static inject = ["settings", "agent"];
  static Config = WatchdogConfig;

  private readonly home: Context;
  private readonly watches = new Map<string, Watch>();
  private on = false;
  private lastLook = 0;
  private judging = false;
  private spent = { day: "", count: 0 };

  constructor(
    ctx: Context,
    public readonly config: WatchdogConfig
  ) {
    super(ctx, "watchdog");
    this.home = ctx;
  }

  [Service.init]() {
    this.home.settings.register(SECTION);
    this.on = this.prefs().enabled;
    const timer = setInterval(() => this.look(), this.config.intervalMs);
    timer.unref?.();
    this.home.effect(() => () => clearInterval(timer), "watchdog look");
    this.home.on("agent/event", (threadId, event) => this.hear(threadId, event));
    this.home.on("agent/run-ended", (_run, thread) => this.forget(thread.id));
    this.home.on("settings/changed", () => {
      const on = this.prefs().enabled;
      if (on === this.on) return;
      this.on = on;
      const had = [...this.watches.values()].some((watch) => watch.flag);
      this.watches.clear();
      if (had) this.home.emit("watchdog/changed");
    });
  }

  private prefs(): Prefs {
    return { ...SECTION.defaults, ...(this.home.settings.value("watchdog") as Partial<Prefs> | undefined) };
  }

  /** What seems wrong with the runs going now, in the person's language. */
  notices(now = Date.now()): RunNotice[] {
    if (!this.on) return [];
    const speak = w(this.home.settings.locale());
    const text = (watch: Watch): string => {
      if (watch.flag === "looping") return speak("noticeLooping", { tool: watch.tool ?? "", times: watch.repeats });
      if (watch.flag === "drifting") return speak("noticeDrifting", { minutes: Math.round((now - watch.startedAt) / 60_000), reason: watch.drift ?? "" });
      const minutes = Math.floor((now - watch.lastAt) / 60_000);
      const step = watch.activity ?? watch.steps.at(-1);
      return step ? speak("noticeSilentStep", { minutes, step }) : speak("noticeSilent", { minutes });
    };
    return [...this.watches.values()].flatMap((watch) =>
      watch.flag ? [{ projectId: watch.projectId, threadId: watch.threadId, itemId: watch.itemId, engine: watch.engine, text: text(watch) }] : []
    );
  }

  /** One round over the runs going now. */
  look(now = Date.now()): void {
    if (!this.on) return;
    const slept = this.lastLook > 0 && now - this.lastLook >= this.config.intervalMs * ASLEEP_AFTER_LOOKS;
    this.lastLook = now;
    const going = new Map(this.home.agent.activeRuns().map(({ run, thread }) => [thread.id, { run, thread }]));
    let moved = false;
    for (const [threadId, watch] of this.watches) {
      if (going.get(threadId)?.run.id === watch.runId) continue;
      moved ||= !!watch.flag;
      this.watches.delete(threadId);
    }
    for (const { run, thread } of going.values()) this.watch(run, thread, now);
    const silentMs = this.prefs().silentMinutes * 60_000;
    for (const watch of this.watches.values()) {
      if (slept) watch.lastAt = now;
      moved = this.reflag(watch, now, silentMs) || moved;
    }
    if (moved) this.home.emit("watchdog/changed");
    const due = [...this.watches.values()].find((watch) => dueForJudgement(watch, now, this.config.judgeEveryMs));
    if (due && !this.judging) void this.judge(due, now);
  }

  private watch(run: RunView, thread: ThreadSummary, now: number): Watch | null {
    // the troubleshooter's test turn: nobody started it, and its thread does not last
    if (thread.surface === "probe") return null;
    const known = this.watches.get(thread.id);
    if (known?.runId === run.id) return known;
    const watch: Watch = {
      runId: run.id, projectId: thread.projectId, threadId: thread.id, itemId: thread.itemId, engine: thread.engine, title: thread.title,
      startedAt: run.startedAt, lastAt: now, waiting: false, activity: null, steps: [], said: null, call: null, tool: null, repeats: 0, judgedAt: null, drift: null, flag: null
    };
    this.watches.set(thread.id, watch);
    return watch;
  }

  private hear(threadId: string, event: AgentEvent): void {
    if (!this.on) return;
    // the run's own first events start the watch, so the steps a judge reads begin at the beginning
    const started = this.watches.has(threadId) ? null : this.home.agent.activeRuns().find((going) => going.thread.id === threadId);
    const now = Date.now();
    if (started) this.watch(started.run, started.thread, now);
    const watch = this.watches.get(threadId);
    if (!watch) return;
    heard(watch, event, now);
    // only what can change a flag reads the settings: this runs for every word streamed
    if ((watch.flag || watch.repeats >= LOOP_AFTER) && this.reflag(watch, now, this.prefs().silentMinutes * 60_000)) this.home.emit("watchdog/changed");
  }

  private forget(threadId: string): void {
    const flagged = !!this.watches.get(threadId)?.flag;
    this.watches.delete(threadId);
    if (flagged) this.home.emit("watchdog/changed");
  }

  /** True when what the person should hear about this run changed. */
  private reflag(watch: Watch, now: number, silentMs: number): boolean {
    const flag = suspicionOf(watch, now, silentMs);
    if (flag === watch.flag) return false;
    watch.flag = flag;
    return true;
  }

  private overBudget(now: number): boolean {
    const day = new Date(now).toDateString();
    if (this.spent.day !== day) this.spent = { day, count: 0 };
    return this.spent.count >= MAX_JUDGEMENTS_A_DAY;
  }

  /** Whatever goes wrong here costs the run nothing: it stays unsuspected until the next hour. */
  private async judge(watch: Watch, now: number): Promise<void> {
    watch.judgedAt = now;
    const llm = this.home.get("llm") as LlmService | undefined;
    if (!llm || !this.prefs().judge || this.overBudget(now)) return;
    this.judging = true;
    try {
      if (!(await llm.worker()).ok) return;
      this.spent.count += 1;
      const item = watch.itemId ? this.home.get("items")?.get(watch.projectId, watch.itemId) : null;
      const task = item ? { title: item.title, body: item.body } : { title: watch.title };
      const { verdict, reason } = await llm.completeJson(Verdict, {
        system: judgeSystem(languageName(this.home.settings.locale())),
        user: judgeUser(watch, task, now),
        maxTokens: 600,
        repair: false,
        timeoutMs: 60_000,
        purpose: "watchdog"
      });
      if (this.watches.get(watch.threadId) !== watch) return;
      watch.drift = verdict === "working" ? null : reason.trim() || verdict;
      if (this.reflag(watch, Date.now(), this.prefs().silentMinutes * 60_000)) this.home.emit("watchdog/changed");
    } catch (error) {
      this.home.logger("watchdog").warn(`judging a long run failed: ${errorMessage(error)}`);
    } finally {
      this.judging = false;
    }
  }
}
