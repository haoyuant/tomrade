import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import { localeOf } from "@tomradex/contracts";
import { languageTag } from "@tomradex/domain";
import type {} from "@tomradex/db";
import type {} from "@tomradex/github";
import { githubRepo } from "@tomradex/inbox-github";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/repos";
import type {} from "@tomradex/settings";
import { candidates, content, renderPage, type Candidate, type PageConfig } from "./page.js";
import { publishPages } from "./publish.js";
import { BUILD_PAGE_WORDS, type BuildPageWords } from "./words.js";

declare module "cordis" {
  interface Context {
    buildPage: BuildPage;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "buildPage.state": (projectId: string) => BuildPageState;
    "buildPage.preview": (projectId: string, config: PageConfig) => BuildPagePreview;
    "buildPage.publish": (projectId: string, previewId: string) => BuildPagePublished;
  }
}

export interface BuildPageState {
  config: PageConfig;
  candidates: Candidate[];
  /** The project's GitHub repositories, "owner/repo". */
  repos: string[];
  connected: boolean;
  published: { url: string | null; at: number } | null;
}

export interface BuildPagePreview {
  id: string;
  /** Exactly what publishing writes as index.html. */
  html: string;
  roadmap: number;
  changelog: number;
}

export interface BuildPagePublished {
  url: string | null;
  /** What still needs the person, in their language; null when the page is live. */
  warning: string | null;
}

export const MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS plugin_buildpage_projects (
  project_id   TEXT PRIMARY KEY,
  config_json  TEXT NOT NULL,
  published_json TEXT,
  updated_at   INTEGER NOT NULL
);
`
  }
];

/** What was ticked travels with the project, so every machine publishes the same page. */
export const TABLES = { plugin_buildpage_projects: { project: "project_id", export: { order: "project_id" } } } as const;

/** Where a ticket's code was merged, as code-link keeps it; read without depending on it. */
interface LinkReader {
  links(projectId: string): { itemId: string; prState: string | null; mergedSha: string | null; updatedAt: number }[];
}

interface Row {
  config_json: string;
  published_json: string | null;
}

/**
 * The public build page: the roadmap and changelog a person ticked, and a way
 * to send feedback, rendered to one static page and published to their own
 * repository's GitHub Pages. Feedback opens an issue there, which the GitHub
 * inbox source brings into the Inbox. A page is published only as it was previewed.
 */
export class BuildPage extends Service {
  static inject = ["db", "items", "repos", "projects", "github"];

  private readonly home: Context;
  private readonly previews = new Map<string, { id: string; html: string; repo: string }>();

  constructor(ctx: Context) {
    super(ctx, "buildPage");
    this.home = ctx;
    ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("buildPage.state", (projectId) => ctx.buildPage.state(projectId));
      ctx.ipc.handle("buildPage.preview", (projectId, config) => ctx.buildPage.preview(projectId, config));
      ctx.ipc.handle("buildPage.publish", (projectId, previewId) => ctx.buildPage.publish(projectId, previewId));
    });
  }

  [Service.init]() {
    this.home.db.migrate("buildpage", MIGRATIONS, { tables: TABLES });
  }

  private words(): BuildPageWords {
    return BUILD_PAGE_WORDS(localeOf(this.home));
  }

  private row(projectId: string): Row | undefined {
    return this.home.db.for(projectId).prepare("SELECT config_json, published_json FROM plugin_buildpage_projects WHERE project_id = ?").get(projectId) as Row | undefined;
  }

  private async repos(projectId: string): Promise<string[]> {
    const out = new Set<string>();
    for (const r of this.home.repos.list(projectId)) {
      const repo = await githubRepo(r.remote);
      if (repo) out.add(repo);
    }
    return [...out];
  }

  private offered(projectId: string): Candidate[] {
    const merged = new Map<string, number>();
    for (const link of (this.home.get("codeLink") as LinkReader | undefined)?.links(projectId) ?? []) {
      if (link.prState !== "merged" && !link.mergedSha) continue;
      merged.set(link.itemId, Math.max(merged.get(link.itemId) ?? 0, link.updatedAt));
    }
    return candidates(this.home.items.list({ projectId }), merged);
  }

  async state(projectId: string): Promise<BuildPageState> {
    const repos = await this.repos(projectId);
    const row = this.row(projectId);
    const saved = row ? (JSON.parse(row.config_json) as PageConfig) : null;
    const config: PageConfig = saved ?? { repo: repos[0] ?? null, title: this.home.projects.get(projectId)?.name ?? "", footer: true, picks: [] };
    return { config, candidates: this.offered(projectId), repos, connected: !!(await this.home.github.token()), published: row?.published_json ? JSON.parse(row.published_json) : null };
  }

  /** Saves what was ticked and renders the page; publishing takes this preview's id and writes exactly its html. */
  async preview(projectId: string, config: PageConfig): Promise<BuildPagePreview> {
    const w = this.words();
    const repos = await this.repos(projectId);
    const repo = config.repo && repos.includes(config.repo) ? config.repo : null;
    if (!repo) throw new Error(w("noRepo"));
    const offered = this.offered(projectId);
    const known = new Set(offered.map((c) => c.id));
    const saved: PageConfig = { repo, title: config.title.trim() || (this.home.projects.get(projectId)?.name ?? repo), footer: config.footer, picks: config.picks.filter((id) => known.has(id)) };
    this.home.db
      .for(projectId)
      .prepare("INSERT INTO plugin_buildpage_projects (project_id, config_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at")
      .run(projectId, JSON.stringify(saved), Date.now());
    const page = content({ ...saved, repo }, offered, languageTag(localeOf(this.home)), Date.now(), w);
    const html = renderPage(page, w);
    const id = randomUUID();
    this.previews.set(projectId, { id, html, repo });
    return { id, html, roadmap: page.now.length + page.next.length, changelog: page.changelog.reduce((n, d) => n + d.titles.length, 0) };
  }

  async publish(projectId: string, previewId: string): Promise<BuildPagePublished> {
    const w = this.words();
    const shown = this.previews.get(projectId);
    if (!shown) throw new Error(w("noPreview"));
    if (shown.id !== previewId) throw new Error(w("stale"));
    if (!(await this.home.github.token())) throw new Error(w("notConnected"));
    const outcome = await publishPages(this.home.github.api, shown.repo, { "index.html": shown.html }, w("commit"));
    if (!outcome.ok) throw new Error(w("foreignSite", { repo: shown.repo }));
    this.previews.delete(projectId);
    const url = outcome.url;
    this.home.db.for(projectId).prepare("UPDATE plugin_buildpage_projects SET published_json = ? WHERE project_id = ?").run(JSON.stringify({ url, at: Date.now() }), projectId);
    const warning = outcome.pages === "elsewhere" ? w("pagesElsewhere", { repo: shown.repo, source: outcome.source }) : outcome.pages === "failed" ? w("pagesFailed", { why: outcome.why }) : null;
    return { url, warning };
  }
}
