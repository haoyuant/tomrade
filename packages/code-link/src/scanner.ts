import type { Git } from "@tomradex/storage";
import { keysInText, parseBranch } from "./keys.js";
import { remoteFailureDetail, remoteFailureMessage } from "./remote.js";

/** Project manifests anywhere in a repository — one is enough for `scaffolded`. */
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
  logCap?: number;
}

export interface ScannedBranch {
  name: string;
  sha: string;
  committedAt: number;
  keyNum: number | null;
  /** Every ticket named by the branch or by commits unique to it. */
  keyNums: number[];
  ahead: number;
  behind: number;
  /** Nothing ahead: the head is already in the default branch. */
  contained: boolean;
  /** A merge commit brought the head into the default branch. */
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
  remote: "ok" | "unreachable" | "unknown";
  /** Last stderr line from a failed fetch, with credentials removed. */
  remoteDetail: string | null;
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
  let remote: ScanResult["remote"] = "unknown";
  let remoteDetail: string | null = null;
  if (opts.fetch !== false) {
    const hasOrigin = (await run(["remote", "get-url", "origin"])).code === 0;
    if (hasOrigin) {
      const fetched = await run(["fetch", "-q", "--prune", "origin"]);
      remote = fetched.code === 0 ? "ok" : "unreachable";
      if (fetched.code !== 0) remoteDetail = remoteFailureDetail(fetched.stderr ?? "");
    }
  }
  const offline = remote === "unreachable";

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
      const keyNum = parseBranch(name, opts.prefix);
      byName.set(name, { name, sha, committedAt, keyNum, keyNums: keyNum === null ? [] : [keyNum], ahead: 0, behind: 0, contained: false, merged: false, local, remote: !local });
      continue;
    }
    // The same branch here and on the remote: the newer head is where the work is.
    if (committedAt > seen.committedAt) Object.assign(seen, { sha, committedAt });
    if (local) seen.local = true;
    else seen.remote = true;
  }

  const branches = [...byName.values()];
  if (defaultRef) {
    let mainline: Set<string> | null = null;
    for (const b of branches) {
      const counts = await run(["rev-list", "--left-right", "--count", `${b.sha}...${defaultRef}`]);
      if (counts.code === 0) {
        const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
        b.ahead = ahead || 0;
        b.behind = behind || 0;
        b.contained = b.ahead === 0;
      }
      // A fresh ticket branch is contained too: it was cut from a default
      // commit, and it stays an ancestor once the default moves on — another
      // merge, or Tomrade's own data commits in a repository that also holds
      // the project. Only a merge commit brings a head in off the default's
      // first-parent line; a fast-forward or squash is read from links and
      // commit keys instead.
      if (b.contained && b.behind > 0) {
        mainline ??= new Set((await run(["rev-list", "--first-parent", defaultRef])).stdout.split("\n").map((s) => s.trim()).filter(Boolean));
        b.merged = !mainline.has(b.sha);
      }
      // Work started outside Tomrade does not necessarily follow the branch
      // template. Commit keys are the cheap, local fallback: no model call and
      // no forge API are needed to discover it.
      if (b.ahead > 0) {
        const log = await run(["log", "--format=%s%x1f%b%x1e", "-n", String(opts.logCap ?? 500), `${defaultRef}..${b.sha}`]);
        for (const keyNum of keysInText(log.stdout, opts.prefix)) if (!b.keyNums.includes(keyNum)) b.keyNums.push(keyNum);
      }
    }
  } else {
    // In a repository without a default branch, every commit on a branch is
    // unique work and can still identify a ticket started from another tool.
    for (const b of branches) {
      const log = await run(["log", "--format=%s%x1f%b%x1e", "-n", String(opts.logCap ?? 500), b.sha]);
      for (const keyNum of keysInText(log.stdout, opts.prefix)) if (!b.keyNums.includes(keyNum)) b.keyNums.push(keyNum);
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
        // Newest evidence wins when a full rescan contains several deliveries.
        if (!mergedKeys.has(keyNum)) mergedKeys.set(keyNum, { sha: sha.trim(), at: Number(ct) * 1000 || 0, subject: (subject ?? "").trim() });
      }
    }
  }

  let manifests: string[] = [];
  let hasBrief = false;
  if (defaultRef) {
    const tree = await run(["ls-tree", "-r", "--name-only", defaultRef]);
    const names = tree.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    manifests = names.filter((name) => MANIFESTS.includes(name.split("/").pop() ?? ""));
    // A repository-level brief governs every workstream beneath it. Nested
    // briefs may describe only that subtree and are not equivalent here.
    hasBrief = BRIEF_FILES.some((file) => names.includes(file));
  }
  // No default branch anywhere and the fetch failed: that is not an empty
  // repository, it is a repository this machine cannot see — credentials, most often.
  const readiness = manifests.length ? "scaffolded" : offline && !defaultRef ? "unknown" : "empty";
  const summary = manifests.length ? `${manifests.join(", ")}${hasBrief ? " · documented" : " · no CLAUDE.md"}` : readiness === "unknown" ? remoteFailureMessage(remoteDetail ?? "") : null;

  return { offline, remote, remoteDetail, defaultRef, defaultSha, branches, mergedKeys, readiness, hasBrief, manifests, summary };
}
