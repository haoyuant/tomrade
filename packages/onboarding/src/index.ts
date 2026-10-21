import { fileURLToPath } from "node:url";
import { Context, Service } from "cordis";
import { z } from "zod";
import { loadPlaybookDir } from "@tomradex/agent";
import { seedLocale } from "@tomradex/db";
import type { Item, Project } from "@tomradex/domain";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/hub";
import type { Inbox } from "@tomradex/inbox";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type {} from "@tomradex/projects";
import type { SettingsSection } from "@tomradex/settings";
import { PATH, SAMPLE, type SampleWords } from "./sample.js";

export { PATH, SAMPLE, type SampleFeedback, type SampleTicket, type SampleWords } from "./sample.js";

declare module "cordis" {
  interface Context {
    onboarding: Onboarding;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** The sample project again, for someone who deleted it; `locale` names its language. */
    "onboarding.createSample": (locale?: string) => Project;
    /** Onboarding from the top: every hint unseen, and the sample there — made anew when `resetSample`. */
    "onboarding.restart": (opts: { resetSample: boolean; locale?: string }) => Project;
  }
}

export const OnboardingConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** The language a first run's sample is written in, before anyone has picked one. */
    locale: z.string().default("en"),
    /** Seed the sample when the catalog is empty. Off, the first run gets nothing from here. */
    firstRun: z.boolean().default(true)
  })
);
export type OnboardingConfig = z.infer<typeof OnboardingConfig>;

export interface OnboardingSettings {
  /** Hints and cards the person has seen or put away, by id. */
  seen: string[];
}

/** The person's, not the machine's: a hint seen on one computer is not taught again on the next. */
export const ONBOARDING_SECTION: SettingsSection<OnboardingSettings> = {
  id: "onboarding",
  title: "Getting started",
  description: "The hints and setup cards already seen.",
  schema: z.object({ seen: z.array(z.string()).default([]) }),
  defaults: { seen: [] },
  order: 90,
  scope: "user"
};

/** Seen once the sample has opened on its first lesson; the UI's Workspace marks it. */
const FIRST_LESSON = "sample-first-lesson";

const PLAYBOOKS = loadPlaybookDir(fileURLToPath(new URL("../playbooks", import.meta.url)), (file, err) => {
  throw new Error(`onboarding playbook ${file} failed to load: ${err instanceof Error ? err.message : String(err)}`);
});

/**
 * A first run opens on the sample project instead of an empty one: a tour
 * written as tickets, linked into a learning path, with a small backlog to
 * practise on. It is this machine's own — never in the account's catalog —
 * and makes way, untouched, for the account's projects when they restore.
 */
export class Onboarding extends Service {
  static provide = "onboarding";
  static inject = ["hub", "projects", "items", "boards", "views"];
  static Config = OnboardingConfig;

  private readonly home: Context;
  /** Samples whose feedback waits for the inbox, which loads after this plugin. */
  private readonly pendingFeedback = new Map<string, SampleWords>();

  constructor(
    ctx: Context,
    public readonly config: OnboardingConfig
  ) {
    super(ctx, "onboarding");
    this.home = ctx;
  }

  [Service.init]() {
    if (this.config.firstRun && !this.ctx.hub.catalog.projects().length) {
      try {
        this.createSample(this.config.locale);
      } catch (error) {
        this.home.logger.warn(`the sample project could not be seeded — ${error instanceof Error ? error.message : String(error)}`);
        this.ctx.projects.ensureDefault();
      }
    }
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("onboarding.createSample", (locale) => ctx.onboarding.sampleAgain(locale));
      ctx.ipc.handle("onboarding.restart", (opts) => ctx.onboarding.restart(opts));
    });
    this.home.inject(["settings"], (ctx) => {
      ctx.settings.register(ONBOARDING_SECTION);
    });
    this.home.inject(["agent"], (ctx) => {
      for (const playbook of PLAYBOOKS) ctx.agent.playbook(playbook);
    });
    this.home.inject(["inbox"], (ctx) => this.deliverFeedback(ctx.inbox));
  }

  /** The tour, in `locale`. Its seed is how it began, not history: nothing to undo, nothing in History. */
  createSample(locale?: string): Project {
    const words = SAMPLE[seedLocale(locale)];
    const created = this.ctx.projects.create(
      { name: words.name, description: words.description, keyPrefix: "TOM", locale },
      {
        seed: (project) => {
          this.ctx.hub.catalog.patchProject(project.id, { seed: true, sample: true });
          this.fill(project.id, words);
        }
      }
    );
    const inbox = this.ctx.get("inbox");
    if (inbox) this.deliverFeedback(inbox);
    // Read back: the catalog marked it the sample after the row was made.
    return this.ctx.projects.get(created.id) ?? created;
  }

  /**
   * The sample again, from the home's tile, without the rest of onboarding:
   * it opens on its first lesson, as a new one did. One that is already there
   * is the one returned, so a second press makes no second sample.
   */
  sampleAgain(locale?: string): Project {
    const existing = this.ctx.projects.list().find((p) => p.sample);
    if (existing) return existing;
    const settings = this.ctx.get("settings");
    if (settings) {
      const seen = (settings.get().onboarding as Partial<OnboardingSettings> | undefined)?.seen ?? [];
      if (seen.includes(FIRST_LESSON)) settings.set({ ...settings.get(), onboarding: { seen: seen.filter((id) => id !== FIRST_LESSON) } });
    }
    return this.createSample(locale ?? this.config.locale);
  }

  /**
   * Onboarding again, as often as wanted: the hints and the setup screen count
   * as unseen, and the sample is there. Reset, the old sample goes with its
   * folder — it is this machine's alone — and a fresh one takes its place.
   */
  restart(opts: { resetSample: boolean; locale?: string }): Project {
    const settings = this.ctx.get("settings");
    if (settings) settings.set({ ...settings.get(), onboarding: { seen: [] } });
    const samples = this.ctx.projects.list().filter((p) => p.sample);
    if (samples.length && !opts.resetSample) return samples[0];
    for (const sample of samples) this.ctx.projects.remove(sample.id, { deleteFolder: true });
    return this.createSample(opts.locale ?? this.config.locale);
  }

  private fill(projectId: string, words: SampleWords): void {
    const { boards, views, items } = this.ctx;
    const tour = boards.defaultFor(projectId);
    if (!tour) throw new Error("the sample project has no workstream to fill");
    boards.update(projectId, tour.id, { name: words.tour, icon: "i-panel" });
    const example = boards.create({ projectId, name: words.example, icon: "i-clock" });
    views.create({ projectId, name: words.path, icon: "i-graph", layout: "graph", query: { filter: [{ field: "board", op: "in", values: [tour.id] }], graph: "deps" } });

    const byKey = new Map<string, Item>();
    words.tickets.forEach((ticket, rank) => {
      byKey.set(ticket.key, items.create({ projectId, boardId: tour.id, title: ticket.title, body: ticket.body, status: "todo", workType: "general", rank, by: "human" }));
    });
    words.examples.forEach((ticket, rank) => {
      items.create({ projectId, boardId: example.id, title: ticket.title, body: ticket.body, status: "backlog", workType: "general", rank, by: "human" });
    });
    for (const [from, to] of PATH) items.addRelation(projectId, byKey.get(from)!.id, byKey.get(to)!.id, "human");
    this.pendingFeedback.set(projectId, words);
  }

  /** The inbox exercise: the sample's feedback, from the tour itself as source. Added once; triaged entries stay as they are. */
  private deliverFeedback(inbox: Inbox): void {
    for (const [projectId, words] of this.pendingFeedback) {
      this.pendingFeedback.delete(projectId);
      if (!this.ctx.projects.get(projectId)) continue;
      const at = Date.now();
      inbox.add(projectId, words.name, words.feedback.map((f, i) => ({
        externalId: f.key, kind: f.kind, reporter: f.reporter, title: f.title, body: f.body, receivedAt: at - (i + 1) * 3_600_000
      })));
    }
  }
}

export default Onboarding;
