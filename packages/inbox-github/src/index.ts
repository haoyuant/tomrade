import type { Context } from "cordis";
import type { Item } from "@tomradex/domain";
import type {} from "@tomradex/github";
import type { Inbox, InboxActivity, InboxEntry, InboxEntryInput, InboxKind, InboxSource, TriageChange } from "@tomradex/inbox";
import type {} from "@tomradex/items";
import { remoteIdentity, serverHost, sshHostName } from "@tomradex/repos";
import type {} from "@tomradex/settings";
import { GITHUB_WORDS } from "./words.js";
import { contract, errorMessage, type LandedLink, localeOf } from "@tomradex/contracts";

export const name = "inbox-github";
export const inject = ["inbox", "github", "repos", "items"];

export const SOURCE_ID = "github";

/** What the source says, filled in; tests hand in their own. */
interface Words {
  source: string;
  connect: string;
  noRepo: string;
  noAccess(repo: string, why: string): string;
  repoFailed(repo: string, why: string): string;
  releaseFailed(why: string): string;
  comment: string;
  commentHelp: string;
  close: string;
  closeHelp: string;
}

function wordsIn(locale: unknown): Words {
  const w = GITHUB_WORDS(locale);
  return {
    source: w("source"),
    connect: w("connect"),
    noRepo: w("noRepo"),
    noAccess: (repo, why) => w("noAccess", { repo, why }),
    repoFailed: (repo, why) => w("repoFailed", { repo, why }),
    releaseFailed: (why) => w("releaseFailed", { why }),
    comment: w("comment"),
    commentHelp: w("commentHelp"),
    close: w("close"),
    closeHelp: w("closeHelp")
  };
}

/** The REST calls this needs, as `ctx.github.api` makes them. */
export interface Api {
  request<T>(method: string, route: string, body?: unknown): Promise<T>;
  whoami(): Promise<string>;
}

export type { LandedLink };

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  labels: (string | { name?: string })[];
  state: "open" | "closed";
  created_at: string;
  pull_request?: unknown;
}

interface Comment {
  issue_url: string;
  user: { login: string } | null;
  created_at: string;
}

interface IssueEvent {
  event: string;
  actor: { login: string } | null;
  created_at: string;
  issue?: { number: number; pull_request?: unknown };
}

interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}

const PAGES = 10;
/** Pulls overlap by this much, so an issue GitHub stamped a little before our clock's "now" is not missed. */
const OVERLAP_MS = 2 * 60_000;

/** Where each repository's issues were read up to; a repository missing from it is pulled from the start. */
export interface PullState {
  repos: Record<string, number>;
}

const isPullState = (state: unknown): state is PullState => !!state && typeof state === "object" && typeof (state as PullState).repos === "object" && (state as PullState).repos !== null;

/** "owner/repo" for a GitHub remote, whatever its spelling or SSH alias; null for any other. */
export async function githubRepo(remote: string, resolveHost: (host: string) => Promise<string> = sshHostName): Promise<string | null> {
  const id = remoteIdentity(remote);
  if (!id) return null;
  const host = id.host === "github.com" ? id.host : await serverHost(id, resolveHost);
  const [owner, repo, ...rest] = id.path.split("/");
  return host === "github.com" && owner && repo && !rest.length ? `${owner}/${repo}` : null;
}

export const issueRef = (repo: string, number: number): string => `${repo}#${number}`;

export function parseRef(externalId: string): { repo: string; number: number } {
  const m = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(externalId);
  if (!m) throw new Error(`Not a GitHub issue: ${externalId}`);
  return { repo: m[1]!, number: Number(m[2]) };
}

export function kindOf(labels: Issue["labels"]): InboxKind {
  const names = labels.map((l) => (typeof l === "string" ? l : (l.name ?? "")).toLowerCase());
  if (names.some((n) => /\bbug\b/.test(n))) return "bug";
  if (names.some((n) => /enhancement|feature|idea|proposal/.test(n))) return "idea";
  return "feedback";
}

export function toEntry(repo: string, issue: Issue): InboxEntryInput {
  return {
    externalId: issueRef(repo, issue.number),
    url: issue.html_url,
    kind: kindOf(issue.labels),
    reporter: issue.user?.login ?? null,
    title: issue.title,
    body: issue.body ?? "",
    receivedAt: Date.parse(issue.created_at)
  };
}

/** What the issue reads after a triage; public, so in English. Null: nothing to say. */
export function commentFor(change: TriageChange, repo: string): string | null {
  switch (change.state) {
    case "accepted":
      return `Thanks for reporting this — it is now tracked as ${change.ticket.key}: ${change.ticket.title}.`;
    case "merged":
      return `Thanks — this is tracked together with similar reports as ${change.ticket.key}: ${change.ticket.title}.`;
    case "shipped":
      return `Fixed in ${change.version}.`;
    case "closed": {
      if (change.reason === "wontfix") return "Thanks for taking the time to write this up. We don't plan to work on it, so we're closing it.";
      const main = change.duplicateOf;
      if (!main) return "Closing this as a duplicate.";
      try {
        const { repo: mainRepo, number } = parseRef(main.externalId);
        return `Duplicate of ${mainRepo === repo ? `#${number}` : issueRef(mainRepo, number)}`;
      } catch {
        return main.url ? `Duplicate of ${main.url}` : "Closing this as a duplicate.";
      }
    }
    case "reopened":
      return null;
  }
}

export function closeFor(change: TriageChange): "completed" | "not_planned" | null {
  if (change.state === "shipped") return "completed";
  if (change.state === "closed") return "not_planned";
  return null;
}

async function pages<T>(api: Api, route: string, enough?: (batch: T[]) => boolean): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const batch = await api.request<T[]>("GET", `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100 || enough?.(batch)) break;
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();
const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

/**
 * One repository's issues since `since`: open ones as entries (the first pull
 * takes only what is open), and comments and reopens by anyone but this
 * account as activity on entries already triaged.
 */
export async function pullRepo(api: Api, repo: string, since: number | null, me: string): Promise<{ entries: InboxEntryInput[]; activity: InboxActivity[] }> {
  const issues = await pages<Issue>(api, since === null ? `/repos/${repo}/issues?state=open&sort=created&direction=asc` : `/repos/${repo}/issues?state=all&sort=updated&direction=asc&since=${iso(since)}`);
  const entries = issues.filter((i) => !i.pull_request && i.state === "open").map((i) => toEntry(repo, i));
  const activity: InboxActivity[] = [];
  if (since !== null) {
    for (const c of await pages<Comment>(api, `/repos/${repo}/issues/comments?sort=updated&direction=asc&since=${iso(since)}`)) {
      const number = Number(/\/issues\/(\d+)$/.exec(c.issue_url)?.[1]);
      if (number && !same(c.user?.login, me)) activity.push({ externalId: issueRef(repo, number), at: Date.parse(c.created_at) });
    }
    // newest first, so stop once a page reaches back past `since`
    const events = await pages<IssueEvent>(api, `/repos/${repo}/issues/events`, (batch) => batch.some((e) => Date.parse(e.created_at) < since));
    for (const e of events) {
      const at = Date.parse(e.created_at);
      if (e.event === "reopened" && e.issue && !e.issue.pull_request && at >= since && !same(e.actor?.login, me)) activity.push({ externalId: issueRef(repo, e.issue.number), at });
    }
  }
  return { entries, activity };
}

export interface Deps {
  api: Api;
  inbox: Inbox;
  /** The project's GitHub repositories, as "owner/repo" by repository id. */
  repos(projectId: string): Promise<Map<string, string>>;
  item(projectId: string, itemId: string): Item | null;
  /** Where a ticket's code was merged; empty without code-link. */
  links(projectId: string, itemId: string): LandedLink[];
  /** Null while no account is connected. */
  connected(): Promise<boolean>;
  words(): Words;
}

/**
 * GitHub issues of a project's repositories as an inbox source. It hears of
 * triage through comments and, when the project allows, by closing the issue;
 * and when an accepted issue's ticket is merged and a release contains the
 * merge, it says which release.
 */
export function githubSource(deps: Deps): InboxSource {
  const { api, inbox } = deps;
  // a release that did not contain a commit never will; what did, always will
  const contains = new Map<string, boolean>();

  const guard = async <T>(repo: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 403 || status === 404) throw new Error(deps.words().noAccess(repo, errorMessage(error)));
      throw error;
    }
  };

  const includes = async (repo: string, tag: string, sha: string): Promise<boolean> => {
    const key = `${repo}@${tag}:${sha}`;
    const known = contains.get(key);
    if (known !== undefined) return known;
    const found = await api
      .request<{ status: string }>("GET", `/repos/${repo}/compare/${sha}...${encodeURIComponent(tag)}`)
      .then((c) => c.status === "ahead" || c.status === "identical")
      .catch((error: { status?: number }) => {
        if (error.status === 404) return false;
        throw error;
      });
    contains.set(key, found);
    return found;
  };

  /** The earliest published release that contains `sha`, or null while none does. */
  const releaseWith = async (repo: string, sha: string, releases: Map<string, Release[]>): Promise<string | null> => {
    let list = releases.get(repo);
    if (!list) {
      list = (await api.request<Release[]>("GET", `/repos/${repo}/releases?per_page=30`))
        .filter((r) => !r.draft && !r.prerelease && r.published_at)
        .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!));
      releases.set(repo, list);
    }
    let found: string | null = null;
    for (const r of list) {
      if (!(await includes(repo, r.tag_name, sha))) break;
      found = r.tag_name;
    }
    return found;
  };

  const mergeSha = async (repo: string, link: LandedLink): Promise<string | null> => {
    if (link.prNumber && link.prState === "merged") {
      const pr = await api.request<{ merge_commit_sha: string | null }>("GET", `/repos/${repo}/pulls/${link.prNumber}`).catch(() => null);
      if (pr?.merge_commit_sha) return pr.merge_commit_sha;
    }
    return link.mergedSha;
  };

  /** Accepted issues whose ticket is done: shipped once a release holds its merge. */
  const ship = async (projectId: string, repos: Map<string, string>): Promise<void> => {
    const waiting = [...inbox.list(projectId, "accepted"), ...inbox.list(projectId, "merged")].filter((e) => e.source === SOURCE_ID && !e.shippedIn && e.itemId);
    const byItem = new Map<string, InboxEntry[]>();
    for (const e of waiting) byItem.set(e.itemId!, [...(byItem.get(e.itemId!) ?? []), e]);
    const releases = new Map<string, Release[]>();
    for (const [itemId, entries] of byItem) {
      if (deps.item(projectId, itemId)?.status !== "done") continue;
      for (const link of deps.links(projectId, itemId)) {
        const repo = repos.get(link.repoId);
        const sha = repo ? await mergeSha(repo, link) : null;
        const version = repo && sha ? await releaseWith(repo, sha, releases) : null;
        if (!version) continue;
        for (const e of entries) inbox.ship(projectId, e.id, version);
        break;
      }
    }
  };

  return {
    id: SOURCE_ID,
    title: () => deps.words().source,
    keyPattern: "[\\w.-]+/[\\w.-]+#\\d+",
    options: [
      { id: "comment", title: () => deps.words().comment, description: () => deps.words().commentHelp, default: true },
      // closing what someone opened is a stronger act: a new project only comments until someone says so
      { id: "close", title: () => deps.words().close, description: () => deps.words().closeHelp, default: false }
    ],
    async available(projectId) {
      if (!(await deps.connected())) return deps.words().connect;
      return (await deps.repos(projectId)).size ? null : deps.words().noRepo;
    },
    async pull({ projectId, since, state }) {
      const started = Date.now();
      const repos = await deps.repos(projectId);
      const me = await api.whoami();
      const names = [...new Set(repos.values())];
      // Before cursors were kept per repository, one cursor stood for every repository bound then.
      const read: Record<string, number> = isPullState(state) ? { ...state.repos } : since === null ? {} : Object.fromEntries(names.map((repo) => [repo, since]));
      const entries: InboxEntryInput[] = [];
      const activity: InboxActivity[] = [];
      const warnings: string[] = [];
      let pulled = 0;
      let failure: unknown = null;
      // One repository refusing must not hold the others back; its own cursor stays, so it catches up later.
      for (const repo of names) {
        try {
          const got = await guard(repo, () => pullRepo(api, repo, read[repo] ?? null, me));
          entries.push(...got.entries);
          activity.push(...got.activity);
          read[repo] = started - OVERLAP_MS;
          pulled += 1;
        } catch (error) {
          failure ??= error;
          warnings.push(deps.words().repoFailed(repo, errorMessage(error)));
        }
      }
      if (names.length && !pulled) throw failure;
      // a release check that fails is tried again next pull; it must not lose what was pulled
      await ship(projectId, repos).catch((error: unknown) => warnings.push(deps.words().releaseFailed(errorMessage(error))));
      return { entries, activity, cursor: started - OVERLAP_MS, state: { repos: read } satisfies PullState, warnings };
    },
    async reply(entry, text) {
      const { repo, number } = parseRef(entry.externalId);
      await guard(repo, () => api.request("POST", `/repos/${repo}/issues/${number}/comments`, { body: text }));
    },
    async setStatus(entry, change) {
      const { repo, number } = parseRef(entry.externalId);
      const close = inbox.option(entry.projectId, SOURCE_ID, "close") ? closeFor(change) : null;
      const comment = inbox.option(entry.projectId, SOURCE_ID, "comment") ? commentFor(change, repo) : null;
      // closed first: a retry after a failed comment closes again harmlessly instead of commenting twice
      if (close) await guard(repo, () => api.request("PATCH", `/repos/${repo}/issues/${number}`, { state: "closed", state_reason: close }));
      if (comment) await guard(repo, () => api.request("POST", `/repos/${repo}/issues/${number}/comments`, { body: comment }));
    }
  };
}

export function apply(ctx: Context) {
  const words = () => wordsIn(localeOf(ctx));
  const codeLink = () => contract(ctx, "codeLink");
  ctx.inbox.source(
    githubSource({
      api: ctx.github.api,
      inbox: ctx.inbox,
      async repos(projectId) {
        const out = new Map<string, string>();
        for (const r of ctx.repos.list(projectId)) {
          const repo = await githubRepo(r.remote);
          if (repo) out.set(r.id, repo);
        }
        return out;
      },
      item: (projectId, itemId) => ctx.items.get(projectId, itemId),
      links: (projectId, itemId) => codeLink()?.links(projectId, itemId) ?? [],
      connected: async () => !!(await ctx.github.token()),
      words
    })
  );
}
