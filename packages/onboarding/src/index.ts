import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "cordis";
import { z } from "zod";
import { loadPlaybookDir } from "@tomradex/agent";
import { seedLocale } from "@tomradex/db";
import { GitFolder, gitRunner } from "@tomradex/git";
import type { Item, Project } from "@tomradex/domain";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/hub";
import type { Inbox } from "@tomradex/inbox";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type {} from "@tomradex/projects";
import type { Repos } from "@tomradex/repos";
import type {} from "@tomradex/storage";
import type { SettingsSection } from "@tomradex/settings";
import { PATH, SAMPLE, SAMPLE_REPO, START, type SampleWords } from "./sample.js";
import { errorMessage } from "@tomradex/contracts";

export { PATH, SAMPLE, SAMPLE_REPO, START, sampleWords, type SampleFeedback, type SampleTicket, type SampleWords } from "./sample.js";

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
  throw new Error(`onboarding playbook ${file} failed to load: ${errorMessage(err)}`);
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
  /** Samples whose repository row waits for its folder, which the storage plugin, loading after this one, makes. */
  private readonly pendingRepos = new Map<string, string>();
  /** Each sample's repository being made, by project id. */
  private readonly makingRepos = new Map<string, Promise<void>>();

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
        this.home.logger.warn(`the sample project could not be seeded — ${errorMessage(error)}`);
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
    // A first run's sample has its folder once storage's first pass has made it.
    this.home.inject(["repos", "storage"], (ctx) => {
      void ctx.storage.ready.then(() => this.deliverRepos(ctx.repos));
    });
    // Its repository is the sample's alone: gone with it, this machine stops pointing at its folder.
    this.home.on("projects/removed", (projectId) => {
      const repos = this.ctx.get("repos");
      const entry = this.ctx.hub.catalog.project(projectId);
      if (!repos || !entry?.sample || !entry.dir) return;
      for (const repo of repos.list(projectId)) if (repo.remote.startsWith(entry.dir + path.sep)) repos.clearCheckout(repo.remote);
    });
  }

  /** The sample's repository, once made; at once when there is none to make. */
  repoReady(projectId: string): Promise<void> {
    return this.makingRepos.get(projectId) ?? Promise.resolve();
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
    const repos = this.ctx.get("repos");
    if (repos && this.ctx.get("storage")) this.deliverRepos(repos);
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
    const more = boards.create({ projectId, name: words.more, icon: "i-stack" });
    const example = boards.create({ projectId, name: words.example, icon: "i-clock", repoId: this.seedRepo(projectId) });
    views.create({ projectId, name: words.path, icon: "i-graph", layout: "graph", query: { filter: [{ field: "board", op: "in", values: [tour.id, more.id] }], graph: "deps" } });

    const byKey = new Map<string, Item>();
    words.tickets.forEach((ticket, rank) => {
      const boardId = START.includes(ticket.key) ? tour.id : more.id;
      byKey.set(ticket.key, items.create({ projectId, boardId, title: ticket.title, body: ticket.body, status: "todo", workType: "general", rank, by: "human" }));
    });
    words.examples.forEach((ticket, rank) => {
      items.create({ projectId, boardId: example.id, title: ticket.title, body: ticket.body, status: "backlog", workType: ticket.coding ? "coding" : "general", rank, by: "human" });
    });
    for (const [from, to] of PATH) items.addRelation(projectId, byKey.get(from)!.id, byKey.get(to)!.id, "human");
    this.pendingFeedback.set(projectId, words);
  }

  /**
   * The example's repository row, made with the seed so the workstream stands
   * for it from the start — nothing in History to undo. It names no folder yet:
   * the project gets its folder after the seed. Without a Hub folder there will
   * be none, and no repository.
   */
  private seedRepo(projectId: string): string | null {
    if (!this.ctx.hub.dir) return null;
    const id = randomUUID();
    const now = Date.now();
    this.ctx.projects
      .dbFor(projectId)
      .prepare("INSERT INTO repos (id, project_id, remote, name, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, projectId, SAMPLE_REPO.folder, SAMPLE_REPO.folder, SAMPLE_REPO.branch, now, now);
    this.pendingRepos.set(projectId, id);
    return id;
  }

  private deliverRepos(repos: Repos): void {
    for (const [projectId, repoId] of this.pendingRepos) {
      this.pendingRepos.delete(projectId);
      this.makingRepos.set(
        projectId,
        this.makeRepo(repos, projectId, repoId).catch((error) => this.home.logger.warn(`the sample's repository could not be made — ${errorMessage(error)}`))
      );
    }
  }

  /**
   * The example's code as a git repository in the sample's folder, one commit
   * on main and no remote: an agent's branch is handed back and merged here.
   * The row takes the folder as its identity, and the folder becomes this
   * machine's checkout of it.
   */
  private async makeRepo(repos: Repos, projectId: string, repoId: string): Promise<void> {
    const projectDir = this.ctx.hub.catalog.project(projectId)?.dir;
    if (!projectDir || !this.ctx.projects.get(projectId)) return;
    const dir = path.join(projectDir, SAMPLE_REPO.folder);
    for (const [name, text] of Object.entries(SAMPLE_REPO.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    const git = gitRunner("git");
    // Its own repository, even when the Hub folder is inside one.
    if (!fs.existsSync(path.join(dir, ".git"))) await git(["init", "-q", "-b", SAMPLE_REPO.branch], { cwd: dir });
    await new GitFolder(git, dir).commit(SAMPLE_REPO.message);
    repos.update(projectId, repoId, { remote: dir });
    await repos.addFromFolder(projectId, dir);
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
