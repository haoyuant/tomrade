import fs from "node:fs";
import type { Context } from "cordis";
import type { Author, Item, Repo } from "@tomradex/domain";
import type { Git } from "@tomradex/git";
import { keysInText, parseBranch, subjectPr } from "../keys.js";
import { githubPull, type ForgePull } from "../forge.js";
import { decide, type Decision, type Evidence } from "../rules.js";
import { scanRepo, uncommittedBranches, type MergedCommit, type ScanResult, type ScannedBranch } from "../scanner.js";
import type { Sessions } from "../sessions.js";
import type { CodeLinkStore, CodeLinkView, ProposalView, SessionView } from "../store.js";
import { errorMessage } from "@tomradex/contracts";

/** Who the scanner writes as. Evidence from git is not a person's decision, and it is not a model's either. */
export const AUTHOR: Author = "sync:git";

/** How a proposal from another ticket's merge that names this one in passing begins. */
export const LANDED_ELSEWHERE = "commits landed through ";

const BEFORE_DONE: ReadonlySet<string> = new Set(["backlog", "todo", "doing", "verifying"]);

const hasLiveSession = (sessions: SessionView[]): boolean =>
  sessions.some((s) => s.mode === "terminal" || s.state === "running" || s.state === "waiting" || s.state === "error");

/** A branch that names a ticket the project does not have, or a ticket in another project. */
export interface UnlinkedBranch {
  repoId: string;
  repoName: string;
  branch: string;
  keyNum: number | null;
  sha: string;
  committedAt: number;
}

export interface ScanSummary {
  repos: number;
  scanned: number;
  offline: number;
  links: number;
  /** Tickets whose status the evidence moved. */
  changed: number;
  /** Proposals and flags raised. */
  proposals: number;
  skipped: { repoId: string; reason: string }[];
}


/** The link the ticket is judged and shown by: an open pull request first, else the branch that moved last. */
export function primaryOf(links: CodeLinkView[]): CodeLinkView | null {
  if (!links.length) return null;
  return [...links].sort((a, b) => {
    const open = Number(b.prState === "open") - Number(a.prState === "open");
    if (open) return open;
    const pr = Number(b.prNumber !== null) - Number(a.prNumber !== null);
    if (pr) return pr;
    const branch = Number(!!b.branch) - Number(!!a.branch);
    if (branch) return branch;
    return (b.headAt ?? 0) - (a.headAt ?? 0);
  })[0]!;
}

const isMerged = (l: CodeLinkView): boolean => !!l.mergedSha || l.prState === "merged";
/** Left behind, not waiting: a pull request closed unmerged, or a bare branch with nothing on it. */
const isAbandoned = (l: CodeLinkView): boolean =>
  !l.mergedSha && (l.prState === "closed" || (l.prNumber === null && !l.prUrl && !l.prState && l.ahead === 0));

/**
 * A delivery is merged once something merged and every other link merged too or was abandoned. A branch with
 * uncommitted work (`underway`) is not abandoned while nothing in its repository has merged: that repository's
 * part has yet to land.
 */
export function deliveryMerged(links: CodeLinkView[], underway: (link: CodeLinkView) => boolean = () => false): boolean {
  const landed = new Set(links.filter(isMerged).map((l) => l.repoId));
  return landed.size > 0 && links.every((l) => isMerged(l) || (isAbandoned(l) && (landed.has(l.repoId) || !underway(l))));
}

const signature = (kind: string, to: string | null, reason: string): string => `${kind}|${to ?? ""}|${reason}`;

/** A merge commit shows in the scan itself; a fast-forward only as the head this link last saw ahead of the default branch now sitting inside it. */
const landed = (b: ScannedBranch, was: CodeLinkView | undefined): boolean => b.merged || (b.contained && !!was && was.headSha === b.sha && was.ahead > 0);

/** The links of a ticket's current delivery. */
export function currentLinks(store: CodeLinkStore, projectId: string, itemId: string): CodeLinkView[] {
  const delivery = store.currentDelivery(projectId, itemId);
  return delivery ? store.links(projectId, itemId).filter((link) => link.delivery === delivery.sequence) : [];
}

export interface GitScanDeps {
  ctx: Context;
  store: CodeLinkStore;
  sessions: Sessions;
  git: Git;
  config: { fetch: boolean };
  pulls: (repo: string, number: number, cwd: string | null) => Promise<ForgePull | null>;
  notify: (projectId: string) => void;
  prefixOf: (projectId: string) => string;
  archiveCompletedSessions: (projectId: string) => void;
  superseded: (projectId: string, session: SessionView) => boolean;
}

/**
 * Git scan → ticket status: each repository's branches and default-branch
 * commits become links, and every ticket they touch is judged again — moved
 * forward, or a proposal raised for a person.
 */
export class GitScan {
  readonly unlinkedByProject = new Map<string, UnlinkedBranch[]>();
  readonly scannedAt = new Map<string, number>();
  readonly inFlight = new Map<string, Promise<ScanSummary>>();
  /** Per repository, the ticket branches with uncommitted changes in a worktree, as the last scan saw them. */
  private readonly uncommitted = new Map<string, Set<string>>();
  private readonly ctx: Context;
  private readonly store: CodeLinkStore;
  private readonly sessions: Sessions;
  private readonly git: Git;
  private readonly config: { fetch: boolean };
  private readonly pulls: GitScanDeps["pulls"];
  private readonly notify: GitScanDeps["notify"];
  private readonly prefixOf: GitScanDeps["prefixOf"];
  private readonly archiveCompletedSessions: GitScanDeps["archiveCompletedSessions"];
  private readonly superseded: GitScanDeps["superseded"];

  constructor(deps: GitScanDeps) {
    this.ctx = deps.ctx;
    this.store = deps.store;
    this.sessions = deps.sessions;
    this.git = deps.git;
    this.config = deps.config;
    this.pulls = deps.pulls;
    this.notify = deps.notify;
    this.prefixOf = deps.prefixOf;
    this.archiveCompletedSessions = deps.archiveCompletedSessions;
    this.superseded = deps.superseded;
  }

  private currentLinks(projectId: string, itemId: string): CodeLinkView[] {
    return currentLinks(this.store, projectId, itemId);
  }

  private readonly underway = (link: CodeLinkView): boolean => !!link.branch && !!this.uncommitted.get(link.repoId)?.has(link.branch);

  /** Repoint every checkout still naming a Hub helper at the userData one. Idempotent, so a later scan catches one that appears late. */
  async migrateCredentialHelpers(projectId: string): Promise<void> {
    for (const repo of this.ctx.repos.list(projectId)) {
      const checkout = this.ctx.repos.checkout(repo.remote).checkout;
      if (!checkout || !fs.existsSync(checkout)) continue;
      try {
        await this.ctx.github.migrateHelper(this.git, checkout);
      } catch (err) {
        this.ctx.logger.warn(`credential helper migration for ${checkout} failed: ${errorMessage(err)}`);
      }
    }
  }

  /** One scan per project at a time; a second caller gets the running one. */
  scan(projectId: string): Promise<ScanSummary> {
    const running = this.inFlight.get(projectId);
    if (running) return running;
    const job = this.doScan(projectId).finally(() => this.inFlight.delete(projectId));
    this.inFlight.set(projectId, job);
    return job;
  }

  /** A pass that sees a change made just now: it waits out a running pass, which may have started before the change. */
  rescan(projectId: string): Promise<ScanSummary> {
    const running = this.inFlight.get(projectId);
    return (running ? running.catch(() => undefined) : Promise.resolve()).then(() => this.scan(projectId));
  }


  private async doScan(projectId: string): Promise<ScanSummary> {
    this.archiveCompletedSessions(projectId);
    const summary: ScanSummary = { repos: 0, scanned: 0, offline: 0, links: 0, changed: 0, proposals: 0, skipped: [] };
    const prefix = this.prefixOf(projectId);
    try {
      await this.ctx.repos.adoptOrigins(projectId);
    } catch (err) {
      this.ctx.logger.warn(`adopting new origins in ${projectId} failed: ${errorMessage(err)}`);
    }
    const repos = this.ctx.repos.list(projectId);
    summary.repos = repos.length;
    const unlinked: UnlinkedBranch[] = [];
    const now = Date.now();
    await this.migrateCredentialHelpers(projectId);
    // Read before any repository is judged: one repository's merge waits on another's uncommitted work.
    for (const repo of repos) {
      const checkout = this.ctx.repos.checkout(repo.remote).checkout;
      if (checkout && fs.existsSync(checkout)) this.uncommitted.set(repo.id, await uncommittedBranches(this.git, checkout, prefix));
      else this.uncommitted.delete(repo.id);
    }
    for (const repo of repos) {
      const placement = this.ctx.repos.checkout(repo.remote);
      if (!placement.checkout || !fs.existsSync(placement.checkout)) {
        summary.skipped.push({ repoId: repo.id, reason: "no checkout on this machine" });
        if (!this.store.repoState(projectId, repo.id)) this.store.upsertRepoState(projectId, repo.id, {});
        // Nothing here can be read from git, but GitHub can still say what became of its pull requests.
        const outcome = await this.settlePulls(projectId, repo);
        this.releaseMerged(projectId, repo.id);
        summary.changed += outcome.changed;
        summary.proposals += outcome.proposals;
        continue;
      }
      const before = this.store.repoState(projectId, repo.id);
      let result: ScanResult;
      try {
        result = await scanRepo(this.git, placement.checkout, { defaultBranch: repo.defaultBranch, prefix, sinceSha: before?.scannedSha ?? null, fetch: this.config.fetch });
      } catch (err) {
        summary.skipped.push({ repoId: repo.id, reason: errorMessage(err) });
        continue;
      }
      summary.scanned += 1;
      if (result.offline) summary.offline += 1;
      this.store.upsertRepoState(projectId, repo.id, {
        readiness: result.readiness,
        remote: result.remote,
        remoteDetail: result.remote === "unreachable" ? result.remoteDetail : null,
        remoteAt: result.remote === "ok" ? now : (before?.remoteAt ?? null),
        hasBrief: result.hasBrief,
        manifests: result.manifests,
        summary: result.summary,
        scannedSha: result.defaultSha,
        defaultSha: result.defaultSha,
        scannedAt: now
      });
      if (result.remote === "ok") {
        for (const session of this.store.sessions(projectId, { live: true })) {
          if (session.repoId === repo.id && session.blocked === "credentials") this.store.patchSession(projectId, session.id, { blocked: null, state: "idle", activity: null });
        }
      }
      const outcome = await this.absorb(projectId, repo, result, before?.autoDone ?? true, now, unlinked);
      this.releaseMerged(projectId, repo.id);
      summary.links += outcome.links;
      summary.changed += outcome.changed;
      summary.proposals += outcome.proposals;
    }
    for (const item of this.ctx.items.list({ projectId })) this.closeEmptyScannedDelivery(projectId, item, now);
    this.unlinkedByProject.set(projectId, unlinked);
    this.scannedAt.set(projectId, now);
    this.notify(projectId);
    return summary;
  }

  /** Turn one repository's scan into links, then judge every ticket the repository touches. */
  private async absorb(projectId: string, repo: Repo, result: ScanResult, autoDone: boolean, now: number, unlinked: UnlinkedBranch[]): Promise<{ links: number; changed: number; proposals: number }> {
    const items = this.ctx.items.list({ projectId });
    const byNum = new Map(items.map((i) => [i.keyNum, i]));
    const previous = new Map(this.store.linksForRepo(projectId, repo.id).map((l) => [l.id, l]));
    const seen = new Set<string>();
    const touched = new Set<string>(previous.size ? [...previous.values()].map((l) => l.itemId) : []);
    let links = 0;

    for (const b of result.branches) {
      for (const keyNum of b.keyNums) {
        const item = byNum.get(keyNum);
        if (!item) {
          unlinked.push({ repoId: repo.id, repoName: repo.name, branch: b.name, keyNum, sha: b.sha, committedAt: b.committedAt });
          continue;
        }
        const sameBranch = [...previous.values()].filter((link) => link.itemId === item.id && link.branch === b.name).sort((a, z) => z.delivery - a.delivery);
        const active = this.store.activeDelivery(projectId, item.id);
        const current = active ? sameBranch.find((link) => link.delivery === active.sequence) : undefined;
        const unchangedHistory = !current ? sameBranch.find((link) => link.headSha === b.sha) : undefined;
        const target = current ?? unchangedHistory;
        // A recreated branch is not a request to reopen a closed ticket.
        if (!target && (item.status === "done" || item.status === "cancelled")) continue;
        const merged = landed(b, target);
        const link = target
          ? this.store.patchLink(projectId, target.id, {
              headSha: b.sha,
              headAt: b.committedAt,
              ahead: b.ahead,
              behind: b.behind,
              mergedSha: merged ? (target.mergedSha ?? result.defaultSha) : undefined,
              lastSeenAt: now
            })
          : this.store.upsertLink(
              projectId,
              { itemId: item.id, repoId: repo.id, branch: b.name },
              { headSha: b.sha, headAt: b.committedAt, ahead: b.ahead, behind: b.behind, mergedSha: merged ? result.defaultSha : undefined, lastSeenAt: now }
            );
        if (merged && link.prState === "open") this.store.patchLink(projectId, link.id, { prState: "merged" });
        if (link.delivery === this.store.activeDelivery(projectId, item.id)?.sequence) seen.add(link.id);
        touched.add(item.id);
        links += 1;
        // A branch with commits is a session's heartbeat too.
        for (const s of this.store.sessions(projectId, { itemId: item.id, delivery: link.delivery, live: true })) if (s.branch === b.name && (s.lastCommitAt ?? 0) < b.committedAt) this.store.patchSession(projectId, s.id, { lastCommitAt: b.committedAt });
      }
    }

    // A branch the scan once linked for a mention (another ticket's branch, a commit naming this one in passing)
    // is not this ticket's work; left in, its unmerged commits hold "every link merged" open for good.
    for (const l of previous.values()) {
      if (seen.has(l.id) || l.source !== "scan" || !l.branch || l.mergedSha || l.prNumber !== null || l.prUrl || l.prState || l.threadId) continue;
      const b = result.branches.find((x) => x.name === l.branch);
      const item = this.ctx.items.get(projectId, l.itemId);
      if (!b || b.ahead === 0 || !item || b.keyNums.includes(item.keyNum)) continue;
      if (l.delivery !== this.store.activeDelivery(projectId, item.id)?.sequence) continue;
      if (this.store.sessions(projectId, { itemId: item.id, delivery: l.delivery }).some((session) => session.branch === l.branch)) continue;
      this.store.removeLink(projectId, l.id);
      touched.add(item.id);
    }

    // A branch linked by hand under a name the template does not know is still one of ours.
    for (const l of previous.values()) {
      if (l.source !== "manual" || seen.has(l.id) || !l.branch) continue;
      const b = result.branches.find((x) => x.name === l.branch);
      if (!b) continue;
      const merged = landed(b, l);
      this.store.patchLink(projectId, l.id, { headSha: b.sha, headAt: b.committedAt, ahead: b.ahead, behind: b.behind, mergedSha: merged ? result.defaultSha : undefined, ...(merged && l.prState === "open" ? { prState: "merged" } : {}), lastSeenAt: now });
      seen.add(l.id);
    }

    // A branch deleted after its merge, or one whose ticket commits landed through
    // another branch, never reads as merged above: settle it from the commits it
    // last pointed at, which stay in the clone after a prune.
    if (result.defaultSha) {
      const prefix = this.prefixOf(projectId);
      const cwd = this.ctx.repos.checkout(repo.remote).checkout!;
      for (const l of previous.values()) {
        if (seen.has(l.id) || l.mergedSha || !l.branch || !l.headSha || l.ahead === 0) continue;
        const item = this.ctx.items.get(projectId, l.itemId);
        if (!item || l.delivery !== this.store.activeDelivery(projectId, item.id)?.sequence) continue;
        const sha = result.branches.find((b) => b.name === l.branch)?.sha ?? l.headSha;
        const log = await this.git(["log", "--format=%s%x1f%b%x1e", `${result.defaultSha}..${sha}`], { cwd, ok: true });
        if (log.code !== 0) continue;
        // A branch named for the ticket is all its work; one found by commit keys owes only the commits naming it.
        const pending = parseBranch(l.branch, prefix) === item.keyNum ? !!log.stdout.trim() : keysInText(log.stdout, prefix).includes(item.keyNum);
        if (pending) continue;
        this.store.patchLink(projectId, l.id, { mergedSha: result.defaultSha, ...(l.prState === "open" ? { prState: "merged" as const } : {}) });
        touched.add(item.id);
      }
    }

    // A branch the scan saw with nothing of its own (renamed away, cut and dropped) and gone since was
    // never part of the work; left in, it would hold the delivery's "every link merged" open for good.
    // Only beside another link, and never one an agent, a session or a pull request named.
    if (!result.offline) {
      for (const l of previous.values()) {
        if (seen.has(l.id) || l.source !== "scan" || !l.branch || l.ahead > 0 || l.mergedSha || l.prNumber !== null || l.prUrl || l.prState || l.threadId) continue;
        if (result.branches.some((b) => b.name === l.branch)) continue;
        const item = this.ctx.items.get(projectId, l.itemId);
        if (!item || l.delivery !== this.store.activeDelivery(projectId, item.id)?.sequence) continue;
        if (!this.store.links(projectId, item.id).some((o) => o.id !== l.id && o.delivery === l.delivery)) continue;
        this.store.removeLink(projectId, l.id);
        touched.add(item.id);
      }
      // A claim's suggested branch left beside the pull request the work went into, from before link_code dropped it.
      for (const l of this.store.linksForRepo(projectId, repo.id)) {
        if (l.source !== "mcp" || !l.branch || (l.prNumber === null && !l.prUrl)) continue;
        if (l.delivery !== this.store.activeDelivery(projectId, l.itemId)?.sequence) continue;
        if (this.dropSuggested(projectId, l.itemId, repo.id, l.branch, (name) => result.branches.some((b) => b.name === name))) touched.add(l.itemId);
      }
      // A claim's suggested branch in this repository, never created, once the work showed up in another one.
      for (const l of this.store.linksForRepo(projectId, repo.id)) {
        if (l.source !== "mcp" || !l.branch || l.headSha || l.ahead > 0 || l.mergedSha || l.prNumber !== null || l.prUrl || l.prState || l.threadId) continue;
        if (result.branches.some((b) => b.name === l.branch)) continue;
        if (l.delivery !== this.store.activeDelivery(projectId, l.itemId)?.sequence) continue;
        const real = this.store.links(projectId, l.itemId).some((o) => o.id !== l.id && o.delivery === l.delivery && (!!o.headSha || o.prNumber !== null || !!o.prUrl));
        if (!real) continue;
        this.store.removeLink(projectId, l.id);
        touched.add(l.itemId);
      }
    }

    for (const item of items) this.closeEmptyScannedDelivery(projectId, item, now, repo.id);

    // A link's pull request is settled by what GitHub says about it; the commit-message rules
    // below are for links it cannot answer for (no pull request, not GitHub, no account, offline).
    const answered = new Set<string>();
    if (result.defaultRef) {
      const cwd = this.ctx.repos.checkout(repo.remote).checkout!;
      for (const { link: l, item, pull } of await this.askPulls(projectId, repo, cwd)) {
        if (pull.merged && pull.mergeSha) {
          // Merged into the default branch, or into another branch that has not reached it yet.
          const landed = await this.git(["merge-base", "--is-ancestor", pull.mergeSha, result.defaultRef], { cwd, ok: true });
          if (landed.code > 1) continue; // the merge commit is not here yet: the local rules decide
          answered.add(l.id);
          if (landed.code === 0) {
            this.store.patchLink(projectId, l.id, { mergedSha: pull.mergeSha, prState: "merged" });
            touched.add(item.id);
          }
        } else {
          answered.add(l.id);
          if (pull.state === "closed") {
            this.store.patchLink(projectId, l.id, { prState: "closed" });
            touched.add(item.id);
          }
        }
      }
    }

    let passed = 0;
    for (const [keyNum, commit] of result.mergedKeys) {
      const item = byNum.get(keyNum);
      if (!item) continue;
      let active = this.store.activeDelivery(projectId, item.id);
      if (!active && item.status !== "done" && item.status !== "cancelled") active = this.store.ensureActiveDelivery(projectId, item.id, commit.at);
      if (!active) continue;
      const base = active.bases[repo.id];
      if (base && active.sequence > 1) {
        const cwd = this.ctx.repos.checkout(repo.remote).checkout!;
        const ancestor = await this.git(["merge-base", "--is-ancestor", commit.sha, base], { cwd, ok: true });
        if (ancestor.code !== 1) continue;
      } else if (active.sequence > 1) {
        // Without a known starting ref, require branch/PR evidence instead of
        // assigning a historical ticket mention to a reopened delivery.
        continue;
      }
      const own = this.store.links(projectId, item.id).filter((l) => l.repoId === repo.id && l.delivery === active.sequence);
      // Named only in passing by another ticket's merge: the person decides whether that delivered this one.
      if (commit.passingFor !== null && !own.some((l) => l.prNumber !== null && l.prNumber === subjectPr(commit.subject))) {
        passed += this.proposeLanding(projectId, repo.id, item, active.sequence, own, commit);
        touched.add(item.id);
        continue;
      }
      if (own.length) {
        for (const l of own) {
          if (answered.has(l.id)) continue;
          // A ticket mention in a squash commit cannot identify which of
          // several branches was merged. Multi-link deliveries require
          // branch ancestry or explicit PR evidence for each link.
          if (own.length > 1 && (l.prNumber === null || l.prNumber !== subjectPr(commit.subject))) continue;
          if (!l.mergedSha || l.prState === "open") {
            this.store.patchLink(projectId, l.id, { ...(!l.mergedSha ? { mergedSha: commit.sha } : {}), ...(l.prState === "open" ? { prState: "merged" as const } : {}) });
          }
        }
      } else {
        this.store.upsertLink(projectId, { itemId: item.id, repoId: repo.id, branch: "", delivery: active.sequence }, { headSha: commit.sha, headAt: commit.at, mergedSha: commit.sha, lastSeenAt: now, source: "scan" });
      }
      touched.add(item.id);
    }

    // Without GitHub's answer: a squash merge never makes the branch an ancestor of the default
    // branch, and a scan that read its commit before the links settled will not read it again,
    // so look for the pull request's own commit, `… (#N)`, wherever it is.
    if (result.defaultRef) {
      const cwd = this.ctx.repos.checkout(repo.remote).checkout!;
      for (const l of this.store.linksForRepo(projectId, repo.id)) {
        if (l.prNumber === null || l.mergedSha || l.prState === "closed" || answered.has(l.id)) continue;
        const item = this.ctx.items.get(projectId, l.itemId);
        if (!item || l.delivery !== this.store.activeDelivery(projectId, item.id)?.sequence) continue;
        const log = await this.git(["log", "--format=%H%x1f%s", "-n", "20", "--fixed-strings", `--grep=#${l.prNumber}`, result.defaultRef], { cwd, ok: true });
        if (log.code !== 0) continue;
        const sha = log.stdout.split("\n").map((line) => line.split("\x1f")).find(([, subject]) => subjectPr(subject ?? "") === l.prNumber)?.[0];
        if (!sha) continue;
        this.store.patchLink(projectId, l.id, { mergedSha: sha, prState: "merged" });
        touched.add(item.id);
      }
    }

    // A branch carrying the commits of a sibling whose pull request was squash-merged never reads as merged
    // above: those commits never reach the default branch. With nothing past the merged head, it landed too.
    if (result.defaultRef) {
      const cwd = this.ctx.repos.checkout(repo.remote).checkout!;
      for (const l of this.store.linksForRepo(projectId, repo.id)) {
        if (l.mergedSha || !l.branch || !l.headSha || l.ahead === 0 || l.prNumber !== null || l.prUrl || l.prState) continue;
        if (l.delivery !== this.store.activeDelivery(projectId, l.itemId)?.sequence) continue;
        const sha = result.branches.find((b) => b.name === l.branch)?.sha ?? l.headSha;
        const siblings = this.store.links(projectId, l.itemId).filter((o) => o.id !== l.id && o.repoId === repo.id && o.delivery === l.delivery && o.mergedSha && o.headSha);
        let carrier: CodeLinkView | undefined;
        for (const o of siblings) {
          if (o.headSha === sha || (await this.git(["merge-base", "--is-ancestor", sha, o.headSha!], { cwd, ok: true })).code === 0) {
            carrier = o;
            break;
          }
        }
        if (!carrier) continue;
        this.store.patchLink(projectId, l.id, { mergedSha: carrier.mergedSha });
        touched.add(l.itemId);
      }
    }

    let changed = 0;
    let proposals = passed;
    for (const itemId of touched) {
      const item = this.ctx.items.get(projectId, itemId);
      if (!item) continue;
      const r = this.judge(projectId, item, repo.id, previous, seen, autoDone);
      changed += r.changed;
      proposals += r.proposals;
    }
    return { links, changed, proposals };
  }

  /**
   * Another ticket's merge that names this one only in passing — its squash lists a commit of this one, or a closing
   * word names it — proposes Done instead of closing it. The commit is kept on the ticket as a link of its own when
   * the delivery has none, so the person sees where the work went; accepting settles that link as merged.
   */
  private proposeLanding(projectId: string, repoId: string, item: Item, delivery: number, own: CodeLinkView[], commit: MergedCommit): number {
    if (item.status === "done" || item.status === "cancelled") return 0;
    const pr = subjectPr(commit.subject);
    const reason = `${LANDED_ELSEWHERE}${pr !== null ? `#${pr}` : commit.sha.slice(0, 7)} (${this.prefixOf(projectId)}-${commit.passingFor}), which names this ticket only in passing`;
    if (this.store.hasRecentProposal(projectId, item.id, delivery, "propose", "done", reason, commit.sha)) return 0;
    const link =
      own.length === 1 ? own[0]! : own.length ? null : this.store.upsertLink(projectId, { itemId: item.id, repoId, branch: "", delivery }, { headSha: commit.sha, headAt: commit.at, lastSeenAt: Date.now(), source: "scan" });
    this.store.addProposal(projectId, { itemId: item.id, delivery, linkId: link?.id ?? null, kind: "propose", fromStatus: item.status, toStatus: "done", reason, evidenceSha: commit.sha });
    return 1;
  }

  /** What GitHub says about each unsettled pull request of a repository's current deliveries, asked once per pull request. */
  private async askPulls(projectId: string, repo: Repo, cwd: string | null): Promise<{ link: CodeLinkView; item: Item; pull: ForgePull }[]> {
    const asked = new Map<string, Promise<ForgePull | null>>();
    const out: { link: CodeLinkView; item: Item; pull: ForgePull }[] = [];
    for (const link of this.store.linksForRepo(projectId, repo.id)) {
      if (link.mergedSha || link.prState === "closed" || (link.prNumber === null && !link.prUrl)) continue;
      const item = this.ctx.items.get(projectId, link.itemId);
      if (!item || link.delivery !== this.store.activeDelivery(projectId, item.id)?.sequence) continue;
      const ref = await githubPull(link.prUrl, link.prNumber, repo.remote);
      if (!ref) continue;
      const key = `${ref.repo}#${ref.number}`;
      if (!asked.has(key)) asked.set(key, this.pulls(ref.repo, ref.number, cwd));
      const pull = await asked.get(key)!;
      if (pull) out.push({ link, item, pull });
    }
    return out;
  }

  /**
   * A repository with no checkout here: GitHub alone settles its pull requests. Without the
   * default branch to look in, a merge counts only when GitHub says it went into that branch.
   */
  private async settlePulls(projectId: string, repo: Repo): Promise<{ changed: number; proposals: number }> {
    const touched = new Set<string>();
    for (const { link, item, pull } of await this.askPulls(projectId, repo, null)) {
      if (pull.merged && pull.mergeSha && pull.base === repo.defaultBranch) this.store.patchLink(projectId, link.id, { mergedSha: pull.mergeSha, prState: "merged" });
      else if (!pull.merged && pull.state === "closed") this.store.patchLink(projectId, link.id, { prState: "closed" });
      else continue;
      touched.add(item.id);
    }
    let changed = 0;
    let proposals = 0;
    const autoDone = this.store.repoState(projectId, repo.id)?.autoDone ?? true;
    for (const itemId of touched) {
      const item = this.ctx.items.get(projectId, itemId);
      if (!item) continue;
      const r = this.judge(projectId, item, repo.id, new Map(), new Set(), autoDone);
      changed += r.changed;
      proposals += r.proposals;
    }
    return { changed, proposals };
  }

  /** A merge the agent was refused is over once someone merged it. */
  private releaseMerged(projectId: string, repoId: string): void {
    for (const session of this.store.sessions(projectId, { live: true })) {
      if (session.repoId !== repoId || session.blocked !== "merge") continue;
      const links = session.itemIds.flatMap((id) => this.currentLinks(projectId, id)).filter((l) => l.repoId === repoId);
      if (!deliveryMerged(links, this.underway)) continue;
      if (this.superseded(projectId, session)) this.sessions.end(projectId, session.id, "ended", true, "another session took over from it");
      else this.store.patchSession(projectId, session.id, { blocked: null, state: "idle", activity: null });
    }
  }

  private closeEmptyScannedDelivery(projectId: string, item: Item, now: number, repoId?: string): void {
    if (item.status !== "done" && item.status !== "cancelled") return;
    const active = this.store.activeDelivery(projectId, item.id);
    if (!active) return;
    const links = this.store.links(projectId, item.id).filter(link => link.delivery === active.sequence);
    // Cross-repository attempts must wait until every repository has been scanned.
    if (repoId && links.some(link => link.repoId !== repoId)) return;
    if (!links.length || links.some(link => link.source !== "scan" || link.ahead > 0 || link.mergedSha || link.prNumber !== null || link.prUrl || link.prState || link.threadId)) return;
    if (this.store.sessions(projectId, { itemId: item.id, delivery: active.sequence }).length) return;
    if (item.evidence.resources.some(resource => resource.role === "output" && resource.deliveryId === active.id) || item.evidence.submissions.some(submission => submission.deliveryId === active.id)) return;
    // Keep the accidental attempt as cancelled history; it has no delivery evidence.
    this.store.finishActiveDelivery(projectId, item.id, "cancelled", now);
    for (const proposal of this.store.proposalsForDelivery(projectId, item.id, active.sequence, "open")) this.store.setProposalState(projectId, proposal.id, "stale");
  }

  /** Re-judge one ticket in one repository after a link changed by tool or by hand, taking every branch as present. */
  reevaluate(projectId: string, itemId: string, repoId: string): void {
    const item = this.ctx.items.get(projectId, itemId);
    if (!item) return;
    const links = this.store.links(projectId, itemId).filter((l) => l.repoId === repoId);
    const seen = new Set(links.filter((l) => l.branch).map((l) => l.id));
    this.judge(projectId, item, repoId, new Map(links.map((l) => [l.id, l])), seen, this.store.repoState(projectId, repoId)?.autoDone ?? true);
    this.notify(projectId);
  }

  /**
   * The branch a claim suggested, once the work is linked on `branch` instead: nothing on it (no commit, no pull
   * request, never seen by a scan), yet it would hold the delivery's "every link merged" open for good. It goes,
   * and the sessions on it move to `branch`. A suggested branch with anything on it is real work and stays.
   */
  dropSuggested(projectId: string, itemId: string, repoId: string, branch: string, present: (name: string) => boolean = () => false): boolean {
    const delivery = this.store.activeDelivery(projectId, itemId);
    if (!delivery || !branch) return false;
    const empty = this.store
      .links(projectId, itemId)
      .filter((l) => l.repoId === repoId && l.delivery === delivery.sequence && l.branch && l.branch !== branch && l.source === "mcp")
      .filter((l) => !l.headSha && l.ahead === 0 && !l.mergedSha && l.prNumber === null && !l.prUrl && !l.prState && !l.threadId && !present(l.branch));
    for (const l of empty) {
      this.store.removeLink(projectId, l.id);
      for (const s of this.store.sessions(projectId, { itemId, delivery: delivery.sequence })) if (s.branch === l.branch) this.store.patchSession(projectId, s.id, { branch });
    }
    return empty.length > 0;
  }

  /** Without a remote there is no pull request: a session's scoped hand-over is the request for review. */
  handOver(projectId: string, itemId: string, repoId: string): void {
    if (this.store.repoState(projectId, repoId)?.remote !== "none") return;
    const item = this.ctx.items.get(projectId, itemId);
    if (!item || item.humanLocked || !["backlog", "todo", "doing"].includes(item.status)) return;
    this.ctx.items.update(projectId, itemId, { status: "verifying" }, AUTHOR);
    this.notify(projectId);
  }

  /** Apply the sync matrix to one ticket in one repository. */
  completionPolicy(projectId: string, item: Item): "merge" | "human" {
    if (item.workType === "general") return "human";
    const active = this.store.activeDelivery(projectId, item.id);
    if (item.evidence.resources.some(r => r.role === "output" && r.deliveryId === active?.id) || item.evidence.submissions.some(s => s.deliveryId === active?.id)) return "human";
    const links = this.currentLinks(projectId, item.id);
    const defaultRepo = this.ctx.boards.get(projectId, item.boardId)?.repoId;
    const repos = links.length ? links.map(l => l.repoId) : defaultRepo ? [defaultRepo] : [];
    return repos.length && repos.every(id => this.store.repoState(projectId, id)?.autoDone ?? true) ? "merge" : "human";
  }

  private judge(projectId: string, item: Item, repoId: string, previous: Map<string, CodeLinkView>, seen: Set<string>, autoDone: boolean): { changed: number; proposals: number } {
    if (item.workType === "general") return { changed: 0, proposals: 0 };
    const delivery = this.store.activeDelivery(projectId, item.id);
    if (!delivery) return { changed: 0, proposals: 0 };
    autoDone = autoDone && this.completionPolicy(projectId, item) === "merge";
    const links = this.store.links(projectId, item.id).filter((l) => l.repoId === repoId && l.delivery === delivery.sequence);
    if (!links.length) return { changed: 0, proposals: 0 };
    const present = links.filter((l) => l.branch && seen.has(l.id));
    const primary = primaryOf(links);
    const working = hasLiveSession(this.store.sessions(projectId, { itemId: item.id, delivery: delivery.sequence, live: true }));
    const evidence: Evidence = {
      branch: present.length > 0,
      ahead: present.reduce((max, l) => Math.max(max, l.ahead), 0),
      merged: deliveryMerged(this.currentLinks(projectId, item.id), this.underway),
      working,
      pr: primary?.prState ?? null,
      movedAfterDone:
        item.status === "done" &&
        present.some((l) => {
          const was = previous.get(l.id);
          return !!was?.headSha && was.headSha !== l.headSha && !l.mergedSha;
        })
    };
    const evidenceSha = primary?.mergedSha ?? primary?.headSha ?? null;
    let changed = 0;
    let proposals = 0;
    let status = item.status;
    // A previous scan may have written Done just before an unmerged terminal
    // session was rebound after an app restart. Once the live process is visible
    // again, undo that sync-only transition. Definitive merge evidence still wins.
    if (evidence.working && !evidence.merged && status === "done" && item.updatedBy === AUTHOR) {
      this.ctx.items.update(projectId, item.id, { status: "doing" }, AUTHOR);
      status = "doing";
      changed += 1;
    }
    const standing = new Set<string>();
    for (let d of decide(status, evidence, { autoDone, humanLocked: item.humanLocked })) {
      if (d.kind === "auto") {
        try {
          this.ctx.items.update(projectId, item.id, { status: d.to }, AUTHOR);
          changed += 1;
          continue;
        } catch (err) {
          // A refused write (a policy, a stale version) is a question for a person, not a retry.
          d = { kind: "propose", to: d.to, reason: `${d.reason} — ${errorMessage(err)}` } satisfies Decision;
        }
      }
      const to = d.kind === "propose" ? d.to : null;
      standing.add(signature(d.kind, to, d.reason));
      if (this.store.hasRecentProposal(projectId, item.id, delivery.sequence, d.kind, to, d.reason, evidenceSha)) continue;
      this.store.addProposal(projectId, { itemId: item.id, delivery: delivery.sequence, linkId: primary?.id ?? null, kind: d.kind, fromStatus: item.status, toStatus: to, reason: d.reason, evidenceSha });
      proposals += 1;
    }
    // A proposal the evidence no longer supports is withdrawn, not left for someone to reject.
    // A passing merge's proposal stands until the ticket's own merge or the person settles it.
    const passing = (p: ProposalView) => p.reason.startsWith(LANDED_ELSEWHERE) && !evidence.merged && BEFORE_DONE.has(this.ctx.items.get(projectId, item.id)?.status ?? "done");
    for (const p of this.store.proposalsForDelivery(projectId, item.id, delivery.sequence, "open")) if (!standing.has(signature(p.kind, p.toStatus, p.reason)) && !passing(p)) this.store.setProposalState(projectId, p.id, "stale");
    if (evidence.merged && this.ctx.items.get(projectId, item.id)?.status === "done") this.store.finishActiveDelivery(projectId, item.id, "completed");
    return { changed, proposals };
  }
}
