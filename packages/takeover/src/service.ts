import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Context, Service } from "cordis";
import type { Agent, EngineRecord } from "@tomradex/agent";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/code-link";
import { errorMessage, localeOf } from "@tomradex/contracts";
import { languageTag, type Item, type Repo } from "@tomradex/domain";
import { gitRunner, type Git } from "@tomradex/git";
import type { GitHubAccount } from "@tomradex/github";
import { githubRepo, pullRepo } from "@tomradex/inbox-github";
import type { Inbox } from "@tomradex/inbox";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type { LlmService } from "@tomradex/llm";
import type {} from "@tomradex/repos";
import type {} from "@tomradex/settings";
import { buildEntries, markCovered, markSimilar, organize, ticketBody, type Facts, type TakeoverEntry } from "./draft.js";
import { baseRef, IDLE_MS, MAX_BRANCHES, quiet, readBranches, readSession, readWorktree, worktreeFolders, type IssueFact, type SessionFact, type WorktreeFact } from "./facts.js";
import { TAKEOVER_WORDS, type TakeoverWords } from "./words.js";

declare module "cordis" {
  interface Context {
    takeover: Takeover;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "takeover.offer": (projectId: string) => TakeoverOffer;
    "takeover.scan": (projectId: string, input: TakeoverScan) => TakeoverDraft;
    "takeover.apply": (projectId: string, draftId: string, entryIds: string[]) => TakeoverApplied;
  }
}

const SESSIONS_SINCE_MS = 30 * 24 * 60 * 60_000;
const SESSIONS_PER_AGENT = 40;
const ISSUES_PER_REPO = 100;

/** What a person is told before anything is read or sent. */
export interface TakeoverOffer {
  repos: { id: string; name: string; placed: boolean }[];
  /** Whose records would be read, and from which folders. */
  sessions: { agent: string; title: string; folders: string[] }[];
  /** The model the draft would go to; null when none answers. */
  model: string | null;
  modelMissing: string | null;
}

export interface TakeoverScan {
  /** The person agreed to the agents' records being read. */
  sessions: boolean;
  /** The model they agreed to send the draft to, by the name they were shown; null to send nothing. */
  model: string | null;
}

export interface TakeoverDraft {
  id: string;
  projectId: string;
  entries: TakeoverEntry[];
  /** What the scan could not read or chose to leave out, in the person's language. */
  notes: string[];
  /** The model that organised it; null when only facts are listed. */
  model: string | null;
}

export interface TakeoverApplied {
  created: { key: string; title: string }[];
  failed: { title: string; reason: string }[];
}

interface Placed {
  repo: Repo;
  checkout: string;
  base: string;
}

const real = (dir: string) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};

/**
 * Reads what a repository already holds into a draft backlog and writes only
 * what a person ticks. A scan writes no ticket; the agents' records are read and
 * anything is sent to a model only when the scan was told it may.
 */
export class Takeover extends Service {
  static inject = ["items", "boards", "repos", "codeLink"];

  private readonly home: Context;
  private readonly git: Git;
  /** The last draft per project: what a person ticks is what the scan found, not what a renderer sends back. */
  private readonly drafts = new Map<string, TakeoverDraft>();

  constructor(ctx: Context) {
    super(ctx, "takeover");
    this.home = ctx;
    this.git = gitRunner("git");
    ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("takeover.offer", (projectId) => ctx.takeover.offer(projectId));
      ctx.ipc.handle("takeover.scan", (projectId, input) => ctx.takeover.scan(projectId, input));
      ctx.ipc.handle("takeover.apply", (projectId, draftId, entryIds) => ctx.takeover.apply(projectId, draftId, entryIds));
    });
  }

  private words(): TakeoverWords {
    return TAKEOVER_WORDS(localeOf(this.home));
  }

  private llm = () => (this.home.get("llm") as LlmService | undefined) ?? null;

  /** Agents whose records can be listed by folder: their names and folders come from the agents themselves. */
  private recorders(): { id: string; title: string; record: EngineRecord }[] {
    const agent = this.home.get("agent") as Agent | undefined;
    return (agent?.allEngines() ?? []).flatMap((e) => (e.local?.record?.sessions ? [{ id: e.id, title: e.title, record: e.local.record }] : []));
  }

  async offer(projectId: string): Promise<TakeoverOffer> {
    const worker = await this.llm()?.worker();
    return {
      repos: this.home.repos.list(projectId).map((repo) => {
        const checkout = this.home.repos.checkout(repo.remote).checkout;
        return { id: repo.id, name: repo.name, placed: !!checkout && fs.existsSync(checkout) };
      }),
      sessions: this.recorders().flatMap((r) => {
        const folders = r.record.roots?.() ?? [];
        return folders.length ? [{ agent: r.id, title: r.title, folders }] : [];
      }),
      model: worker?.ok ? (worker.title ?? null) : null,
      modelMissing: worker?.ok ? null : (worker?.reason ?? null)
    };
  }

  async scan(projectId: string, input: TakeoverScan): Promise<TakeoverDraft> {
    const w = this.words();
    const notes: string[] = [];
    const summary = await this.home.codeLink.scan(projectId);
    if (summary.offline) notes.push(w("offline", { n: summary.offline }));

    const placed: Placed[] = [];
    for (const repo of this.home.repos.list(projectId)) {
      const checkout = this.home.repos.checkout(repo.remote).checkout;
      if (!checkout || !fs.existsSync(checkout)) notes.push(w("noCheckout", { repo: repo.name }));
      else placed.push({ repo, checkout, base: await baseRef(this.git, checkout, repo.defaultBranch) });
    }

    const existing = this.home.items.list({ projectId });
    const known = existing.map((i) => i.body ?? "").join("\n");
    const facts: Facts = { branches: await this.branches(projectId, placed, notes, w), worktrees: await this.worktrees(projectId, placed), issues: await this.issues(projectId, placed, known, notes, w), sessions: [] };
    if (input.sessions) facts.sessions = await this.sessions(projectId, placed, known, notes, w);
    else notes.push(w("sessionsDeclined"));

    let entries = buildEntries(facts, w);
    const worker = await this.llm()?.worker();
    const now = worker?.ok ? (worker.title ?? null) : null;
    const allowed = input.model !== null && now === input.model;
    if (input.model !== null && !allowed) notes.push(w("modelChanged", { now: now ?? "—", asked: input.model }));
    const llm = allowed ? this.llm() : null;
    let model: string | null = null;
    if (llm) {
      try {
        const organized = await organize(llm, entries, facts, languageTag(localeOf(this.home)));
        entries = organized.entries;
        model = now;
        if (organized.dropped) notes.push(w("modelHid", { model: now!, n: organized.dropped }));
      } catch (err) {
        notes.push(w("modelFailed", { why: errorMessage(err) }));
      }
    }
    await markSimilar(model ? llm : null, entries, existing);
    if (llm && model) {
      const brief = (this.home.get("agent") as Agent | undefined)?.brief(projectId) ?? null;
      await markCovered(llm, entries, existing, brief).catch((err: unknown) => this.home.logger.warn(`find_gaps over a takeover draft failed: ${errorMessage(err)}`));
    }
    const draft: TakeoverDraft = { id: randomUUID(), projectId, entries, notes, model };
    this.drafts.set(projectId, draft);
    return draft;
  }

  private async branches(projectId: string, placed: Placed[], notes: string[], w: TakeoverWords) {
    const unmerged = this.home.codeLink.unmerged(projectId).sort((a, b) => b.committedAt - a.committedAt);
    if (unmerged.length > MAX_BRANCHES) notes.push(w("tooManyBranches", { n: MAX_BRANCHES }));
    const listed = unmerged.slice(0, MAX_BRANCHES);
    const out = [];
    for (const { repo, checkout, base } of placed) out.push(...(await readBranches(this.git, checkout, base, listed.filter((b) => b.repoId === repo.id))));
    return out;
  }

  /** Worktrees nobody is using and no ticket holds. */
  private async worktrees(projectId: string, placed: Placed[]): Promise<WorktreeFact[]> {
    const held = new Set(this.home.codeLink.links(projectId).map((l) => l.branch));
    const live = new Set(this.home.codeLink.sessionsOf(projectId).filter((s) => s.state !== "ended").flatMap((s) => [s.worktree, s.cwd]).filter((d): d is string => !!d).map(real));
    const now = Date.now();
    const out: WorktreeFact[] = [];
    for (const { repo, checkout, base } of placed) {
      for (const tree of await worktreeFolders(this.git, checkout)) {
        if (live.has(real(tree.dir)) || (tree.branch && held.has(tree.branch))) continue;
        const fact = await readWorktree(this.git, { repoId: repo.id, repoName: repo.name }, base, tree);
        if (fact && now - fact.touchedAt >= IDLE_MS) out.push(fact);
      }
    }
    return out;
  }

  /** Open issues, read directly: taking one through the inbox would answer on GitHub, which nobody asked here. */
  private async issues(projectId: string, placed: Placed[], known: string, notes: string[], w: TakeoverWords): Promise<IssueFact[]> {
    const github = this.home.get("github") as GitHubAccount | undefined;
    const named = (await Promise.all(placed.map(async ({ repo }) => ({ repo, slug: await githubRepo(repo.remote) })))).filter((r): r is { repo: Repo; slug: string } => !!r.slug);
    if (!named.length || !github) return [];
    if (!(await github.readToken())) {
      notes.push(w("noGithub"));
      return [];
    }
    const triaged = new Set(((this.home.get("inbox") as Inbox | undefined)?.list(projectId, "all") ?? []).filter((e) => e.status !== "new").map((e) => e.externalId));
    const out: IssueFact[] = [];
    for (const { repo, slug } of named) {
      try {
        const { entries } = await pullRepo(github.issues, slug, null, "");
        for (const issue of entries.slice(-ISSUES_PER_REPO).reverse()) {
          if (triaged.has(issue.externalId) || (issue.url && known.includes(issue.url))) continue;
          out.push({ repoId: repo.id, repoName: repo.name, ref: issue.externalId, number: Number(issue.externalId.split("#").pop()), url: issue.url ?? null, title: issue.title, body: issue.body ?? "", reporter: issue.reporter ?? null });
        }
      } catch (err) {
        notes.push(w("issuesFailed", { repo: slug, why: errorMessage(err) }));
      }
    }
    return out;
  }

  /** Runs only on the person's word: `scan` does not call it otherwise. */
  private async sessions(projectId: string, placed: Placed[], known: string, notes: string[], w: TakeoverWords): Promise<SessionFact[]> {
    const recorders = this.recorders();
    if (!recorders.length) {
      notes.push(w("noRecords"));
      return [];
    }
    const held = new Set(this.home.codeLink.links(projectId).map((l) => l.branch));
    const tracked = this.home.codeLink.sessionsOf(projectId);
    const transcripts = new Set(tracked.map((s) => s.transcript));
    const ids = tracked.flatMap((s) => (s.externalId ? [s.externalId] : []));
    const folders = new Map<string, Repo>();
    for (const { repo, checkout } of placed) {
      // Agents file a session under the path as they saw it, which a symlink can make either of these.
      for (const dir of [checkout, ...(await worktreeFolders(this.git, checkout)).map((t) => t.dir)]) folders.set(dir, repo).set(real(dir), repo);
    }
    const now = Date.now();
    const out: SessionFact[] = [];
    for (const { id, title, record } of recorders) {
      for (const session of record.sessions!([...folders.keys()], { since: now - SESSIONS_SINCE_MS, limit: SESSIONS_PER_AGENT })) {
        if (!quiet(session, now) || transcripts.has(session.file) || ids.some((sid) => session.file.includes(sid)) || known.includes(session.file) || (session.branch && held.has(session.branch))) continue;
        const repo = folders.get(session.cwd)!;
        const fact = readSession(record, session, { id, title }, { repoId: repo.id, repoName: repo.name });
        if (fact) out.push(fact);
      }
    }
    return out;
  }

  /** Writes the ticked entries and nothing else. */
  apply(projectId: string, draftId: string, entryIds: string[]): TakeoverApplied {
    const w = this.words();
    const draft = this.drafts.get(projectId);
    if (draft?.id !== draftId) throw new Error(w("stale"));
    this.drafts.delete(projectId);
    const ticked = new Set(entryIds);
    const made = new Map<string, Item>();
    const applied: TakeoverApplied = { created: [], failed: [] };
    for (const entry of draft.entries.filter((e) => ticked.has(e.id))) {
      try {
        const item = this.create(projectId, entry, w);
        made.set(entry.id, item);
        applied.created.push({ key: item.key, title: item.title });
      } catch (err) {
        applied.failed.push({ title: entry.title, reason: errorMessage(err) });
      }
    }
    for (const entry of draft.entries) {
      const item = made.get(entry.id);
      if (!item) continue;
      for (const dep of entry.dependsOn) {
        const first = made.get(dep);
        if (first) this.home.items.addRelation(projectId, first.id, item.id, "human");
      }
    }
    if (draft.entries.some((e) => e.branch && made.has(e.id))) void this.home.codeLink.scan(projectId).catch((err: unknown) => this.home.logger.warn(`scan after a takeover failed: ${errorMessage(err)}`));
    return applied;
  }

  private create(projectId: string, entry: TakeoverEntry, w: TakeoverWords): Item {
    const body = ticketBody(entry, w);
    if (entry.repoId && entry.branch) return this.home.codeLink.adoptBranch(projectId, entry.repoId, entry.branch, { title: entry.title, body, rescan: false });
    return this.home.items.create({ projectId, boardId: this.home.boards.defaultFor(projectId).id, title: entry.title, body, by: "human" });
  }
}
