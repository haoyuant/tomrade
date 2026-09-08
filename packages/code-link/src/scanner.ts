import type { Git } from "@tomrade/storage";
import { keysInText, parseBranch } from "./keys.js";

/** Files at a repository's root that say "there is a project here" — one is enough for `scaffolded`. */
export const MANIFESTS = [
  "package.json",
  "pubspec.yaml",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "mix.exs",
  "Package.swift",
  "CMakeLists.txt",
  "Makefile"
];

/** What a coding agent reads first; its presence is what makes a repository "documented". */
export const BRIEF_FILES = ["CLAUDE.md", "AGENTS.md"];

export interface ScanOptions {
  defaultBranch: string;
  /** The project's key prefix, e.g. TOM. */
  prefix: string;
  /** Where the last scan left the default branch; commits after it are read for keys. Null reads the last `logCap`. */
  sinceSha: string | null;
  /** Fetch from origin first. Off, only what this machine already has is read. */
  fetch?: boolean;
  /** Branches to measure besides the keyed ones — those a person linked by hand under a name the template does not know. */
  track?: string[];
  logCap?: number;
}

export interface ScannedBranch {
  name: string;
  sha: string;
  committedAt: number;
  keyNum: number | null;
  ahead: number;
  behind: number;
  /** The head is an ancestor of the default branch. */
  merged: boolean;
  local: boolean;
  remote: boolean;
}

export interface MergedCommit {
  sha: string;
  at: number;
  subject: string;
}

export interface ScanResult {
  /** The fetch failed — what follows is this machine's last view of the remote. */
  offline: boolean;
  /** `origin/<default>` when the remote has it, the local branch otherwise, null in an empty repository. */
  defaultRef: string | null;
  defaultSha: string | null;
  branches: ScannedBranch[];
  /** Ticket numbers named by default-branch commits since `sinceSha`, with the commit that named them. */
  mergedKeys: Map<number, MergedCommit>;
  /** `unknown` when the remote could not be reached and nothing local stands in: an empty checkout of a full repository looks exactly like an empty repository. */
  readiness: "empty" | "scaffolded" | "unknown";
  hasBrief: boolean;
  manifests: string[];
  summary: string | null;
}

const NUL = "\u0000";
const US = "\u001f";
const RS = "\u001e";

/**
 * Read one repository, read-only: which branches carry a ticket key and where
 * they stand against the default branch, which keys the default branch's recent
 * commits name (squash merges lose the branch; the message is what survives),
 * and whether there is a project here at all. A worktree's branch is a ref of
 * the checkout, so agents' branches are seen without visiting their folders.
 */
export async function scanRepo(git: Git, checkout: string, opts: ScanOptions): Promise<ScanResult> {
  const run = (args: string[]) => git(args, { cwd: checkout, ok: true });
  let offline = false;
  if (opts.fetch !== false) {
    const hasOrigin = (await run(["remote", "get-url", "origin"])).code === 0;
    if (hasOrigin) offline = (await run(["fetch", "-q", "--prune", "origin"])).code !== 0;
  }

  const remoteDefault = `refs/remotes/origin/${opts.defaultBranch}`;
  const localDefault = `refs/heads/${opts.defaultBranch}`;
  const defaultRef = (await run(["rev-parse", "--verify", "--quiet", remoteDefault])).code === 0 ? `origin/${opts.defaultBranch}` : (await run(["rev-parse", "--verify", "--quiet", localDefault])).code === 0 ? opts.defaultBranch : null;
  const defaultSha = defaultRef ? (await run(["rev-parse", defaultRef])).stdout.trim() || null : null;

  const refs = await run(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)", "refs/heads", "refs/remotes/origin"]);
  const byName = new Map<string, ScannedBranch>();
  for (const line of refs.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [refname, sha, date] = line.split(NUL);
    if (!refname || !sha) continue;
    const local = refname.startsWith("refs/heads/");
    const name = local ? refname.slice("refs/heads/".length) : refname.slice("refs/remotes/origin/".length);
    if (!local && name === "HEAD") continue;
    if (name === opts.defaultBranch) continue;
    const committedAt = Number(date) * 1000 || 0;
    const seen = byName.get(name);
    if (!seen) {
      byName.set(name, { name, sha, committedAt, keyNum: parseBranch(name, opts.prefix), ahead: 0, behind: 0, merged: false, local, remote: !local });
      continue;
    }
    // The same branch here and on the remote: the newer head is where the work is.
    if (committedAt > seen.committedAt) Object.assign(seen, { sha, committedAt });
    if (local) seen.local = true;
    else seen.remote = true;
  }

  const branches = [...byName.values()];
  const tracked = new Set(opts.track ?? []);
  if (defaultRef) {
    for (const b of branches) {
      if (b.keyNum === null && !tracked.has(b.name)) continue;
      const counts = await run(["rev-list", "--left-right", "--count", `${b.sha}...${defaultRef}`]);
      if (counts.code === 0) {
        const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
        b.ahead = ahead || 0;
        b.behind = behind || 0;
      }
      b.merged = (await run(["merge-base", "--is-ancestor", b.sha, defaultRef])).code === 0;
    }
  }

  const mergedKeys = new Map<number, MergedCommit>();
  if (defaultRef) {
    const format = "--format=%H%x1f%ct%x1f%s%x1f%b%x1e";
    let log = opts.sinceSha ? await run(["log", format, defaultRef, `^${opts.sinceSha}`]) : { code: 1, stdout: "" };
    // The old anchor may be gone (a rewritten default branch): fall back to a window.
    if (log.code !== 0) log = await run(["log", format, `-n`, String(opts.logCap ?? 500), defaultRef]);
    for (const record of log.stdout.split(RS)) {
      const [sha, ct, subject, body] = record.replace(/^\n/, "").split(US);
      if (!sha?.trim()) continue;
      for (const keyNum of keysInText(`${subject ?? ""}\n${body ?? ""}`, opts.prefix)) {
        // Oldest wins: the log is newest-first, so the last write for a key is its first mention.
        mergedKeys.set(keyNum, { sha: sha.trim(), at: Number(ct) * 1000 || 0, subject: (subject ?? "").trim() });
      }
    }
  }

  let manifests: string[] = [];
  let hasBrief = false;
  if (defaultRef) {
    const tree = await run(["ls-tree", "--name-only", defaultRef]);
    const names = new Set(tree.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
    manifests = MANIFESTS.filter((m) => names.has(m));
    hasBrief = BRIEF_FILES.some((f) => names.has(f));
  }
  // No default branch anywhere and the fetch failed: that is not an empty
  // repository, it is a repository this machine cannot see — credentials, most often.
  const readiness = manifests.length ? "scaffolded" : offline && !defaultRef ? "unknown" : "empty";
  const summary = manifests.length ? `${manifests.join(", ")}${hasBrief ? " · documented" : " · no CLAUDE.md"}` : readiness === "unknown" ? "remote unreachable from this checkout — check the credentials git uses for origin" : null;

  return { offline, defaultRef, defaultSha, branches, mergedKeys, readiness, hasBrief, manifests, summary };
}
