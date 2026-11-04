import fs from "node:fs";
import path from "node:path";
import type { EngineRecord, RecordSession } from "@tomradex/agent";
import type { UnmergedBranch } from "@tomradex/code-link";
import type { Git } from "@tomradex/git";

/** Most branches a draft lists: past this it stops being something a person ticks through. */
export const MAX_BRANCHES = 100;
/** A worktree touched more recently than this may still be in use. */
export const IDLE_MS = 24 * 60 * 60_000;
/** A record that changed this recently is probably a session still running. */
const LIVE_RECORD_MS = 10 * 60_000;
const SUBJECTS = 5;
const EXCERPT_LINES = 12;
const EXCERPT_LINE = 300;

export interface BranchFact extends UnmergedBranch {
  /** The default branch as this repository calls it. */
  base: string;
  /** Newest first. */
  subjects: string[];
  /** The closest other unmerged branch this one was built on. */
  parent: string | null;
}

export interface WorktreeFact {
  repoId: string;
  repoName: string;
  dir: string;
  branch: string | null;
  dirty: number;
  /** Commits ahead of the default branch; counted only where no branch would say. */
  ahead: number;
  touchedAt: number;
}

export interface IssueFact {
  repoId: string;
  repoName: string;
  ref: string;
  number: number;
  url: string | null;
  title: string;
  body: string;
  reporter: string | null;
}

export interface SessionFact {
  agent: string;
  agentTitle: string;
  repoId: string;
  repoName: string;
  file: string;
  at: number;
  branch: string | null;
  title: string;
  lastSaid: string;
  /** The conversation's end, what a model reads to judge it. */
  excerpt: string;
}

const lines = (text: string) => text.split("\n").filter((l) => l.trim());

/** Where the repository's default branch stands: the remote's when there is one. */
export async function baseRef(git: Git, checkout: string, branch: string): Promise<string> {
  const remote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: checkout, ok: true });
  return remote.code === 0 ? `origin/${branch}` : branch;
}

/** Each branch's last commits, and which other unmerged branch it stands on: a stack is the one dependency git itself proves. */
export async function readBranches(git: Git, checkout: string, base: string, branches: UnmergedBranch[]): Promise<BranchFact[]> {
  const run = (args: string[]) => git(args, { cwd: checkout, ok: true });
  const out: BranchFact[] = [];
  for (const b of branches) {
    const under = await run(["for-each-ref", `--merged=${b.sha}`, "--format=%(objectname)", "refs/heads", "refs/remotes/origin"]);
    const ancestors = new Set(lines(under.stdout).map((l) => l.trim()));
    const closest = branches.filter((o) => o.sha !== b.sha && ancestors.has(o.sha)).sort((x, y) => y.ahead - x.ahead)[0];
    // On a stack, the commits that are this branch's own are those past the one it stands on.
    const log = await run(["log", "--format=%s", "-n", String(SUBJECTS), `${closest?.sha ?? base}..${b.sha}`]);
    out.push({ ...b, base, subjects: lines(log.stdout), parent: closest?.branch ?? null });
  }
  return out;
}

const newestFile = (dir: string, status: string): number =>
  Math.max(
    0,
    ...lines(status)
      .slice(0, 50)
      .map((l) => fs.statSync(path.join(dir, l.slice(3).split(" -> ").pop()!), { throwIfNoEntry: false })?.mtimeMs ?? 0)
  );

/** Every worktree of the checkout but the checkout itself, by the folder git says it is in. */
export async function worktreeFolders(git: Git, checkout: string): Promise<{ dir: string; branch: string | null }[]> {
  const list = await git(["worktree", "list", "--porcelain"], { cwd: checkout, ok: true });
  if (list.code !== 0) return [];
  return list.stdout
    .split("\n\n")
    .slice(1)
    .filter((entry) => !/^prunable/m.test(entry))
    .flatMap((entry) => {
      // git spells a Windows path with forward slashes; the folder goes on in this platform's own spelling.
      const dir = /^worktree (.+)$/m.exec(entry)?.[1];
      return dir ? [{ dir: path.normalize(dir), branch: /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1] ?? null }] : [];
    });
}

export async function readWorktree(git: Git, repo: { repoId: string; repoName: string }, base: string, tree: { dir: string; branch: string | null }): Promise<WorktreeFact | null> {
  const run = (args: string[]) => git(args, { cwd: tree.dir, ok: true });
  const status = await run(["status", "--porcelain"]);
  if (status.code !== 0) return null;
  const committed = Number((await run(["log", "-1", "--format=%ct"])).stdout.trim()) * 1000 || 0;
  const ahead = Number((await run(["rev-list", "--count", `${base}..HEAD`])).stdout.trim()) || 0;
  return { ...repo, dir: tree.dir, branch: tree.branch, dirty: lines(status.stdout).length, ahead, touchedAt: Math.max(committed, newestFile(tree.dir, status.stdout)) };
}

const clip = (text: string, n: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** What a session's record says: nothing is kept when no person ever spoke in it. */
export function readSession(record: EngineRecord, session: RecordSession, agent: { id: string; title: string }, repo: { repoId: string; repoName: string }): SessionFact | null {
  const read = record.read(session.file);
  const said = read?.lines.filter((l) => l.who !== "tool") ?? [];
  const person = said.filter((l) => l.who === "person");
  if (!person.length) return null;
  return {
    agent: agent.id,
    agentTitle: agent.title,
    ...repo,
    file: session.file,
    at: session.at,
    branch: session.branch,
    title: clip(record.title?.(session.file) ?? person[0]!.text, 120),
    lastSaid: clip(person.at(-1)!.text, 200),
    excerpt: said
      .slice(-EXCERPT_LINES)
      .map((l) => `${l.who}: ${clip(l.text, EXCERPT_LINE)}`)
      .join("\n")
  };
}

/** Sessions a running agent may still be writing are nobody's unfinished work yet. */
export const quiet = (session: RecordSession, now: number) => now - session.at >= LIVE_RECORD_MS;
