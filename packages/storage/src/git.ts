import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const exec = (binary: string, args: string[], options: Parameters<typeof execFile>[2], stdin?: string): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> =>
  new Promise((resolve, reject) => {
    const child = execFile(binary, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
      } else resolve({ stdout, stderr });
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

export class GitMissingError extends Error {
  constructor(public readonly binary: string) {
    super(`git not found (looked for "${binary}"). Set the git binary in Settings, or install the command line tools.`);
    this.name = "GitMissingError";
  }
}

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly stderr: string
  ) {
    // A token reaches us inside a remote URL — in git's own output AND in the
    // arguments we passed it. Both must be scrubbed before this reaches a log,
    // a toast or a status line.
    const scrub = (text: string) => text.replace(/\/\/[^@\s/]*@/g, "//");
    super(`git ${scrub(args.join(" "))} failed: ${scrub(stderr).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
    this.name = "GitError";
  }
}

/**
 * A GUI-launched Electron app has a minimal PATH and no terminal: git must never
 * be allowed to sit waiting for a password, or a publish hangs for ever.
 */
export const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GCM_INTERACTIVE: "never"
};

export interface Git {
  (args: string[], opts?: { cwd?: string; ok?: boolean; stdin?: string }): Promise<{ stdout: string; stderr?: string; code: number }>;
}

/** git itself takes this lock for a moment even on a "read" like `status`, to opportunistically refresh its index cache. */
const isIndexLockContention = (stderr: string): boolean => /Unable to create '.*index\.lock': File exists/.test(stderr);

export function gitRunner(binary: string, defaultCwd?: string): Git {
  return async (args, opts = {}) => {
    const cwd = opts.cwd ?? defaultCwd;
    for (let attempt = 0; ; attempt++) {
      try {
        const { stdout, stderr } = await exec(binary, args, { cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer: 16 * 1024 * 1024 }, opts.stdin);
        return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
      } catch (error) {
        const e = error as { code?: number | string; stderr?: string | Buffer; stdout?: string | Buffer };
        if (e.code === "ENOENT") throw new GitMissingError(binary);
        const stderrText = String(e.stderr ?? "");
        // Nothing ran yet when index.lock collides, so a retry is never a
        // double-apply — just outwait whichever process briefly held it.
        if (attempt < 5 && isIndexLockContention(stderrText)) {
          await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
          continue;
        }
        // `ok` means a non-zero exit is an answer, not a failure — `diff --quiet`, say.
        if (opts.ok) return { stdout: String(e.stdout ?? ""), stderr: stderrText, code: typeof e.code === "number" ? e.code : 1 };
        throw new GitError(args, stderrText);
      }
    }
  };
}

/** Never used to reach a remote — only to name a local directory. */
export const shortHash = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

/** A remote URL with any credential removed, for display and for identity. */
export const cleanRemote = (remote: string): string => remote.replace(/\/\/[^@/]*@/, "//");

export type GitOrigin = "dedicated" | "shared" | "none";

const realpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Helpers over one folder. `dedicated` means a repository Tomrade made for the
 * project alone, which it may drive; `shared` is somebody's checkout, where
 * Tomrade writes its own subtree and nothing else; `none` is a plain folder.
 */
export class GitFolder {
  constructor(
    private readonly git: Git,
    public readonly dir: string
  ) {}

  async toplevel(): Promise<string | null> {
    const r = await this.git(["rev-parse", "--show-toplevel"], { cwd: this.dir, ok: true });
    return r.code === 0 ? realpath(r.stdout.trim()) : null;
  }

  /** Whether the folder is a repository root, inside one, or neither. `dedicated` needs the manifest's word too. */
  async origin(markedDedicated: boolean): Promise<GitOrigin> {
    const top = await this.toplevel();
    if (!top) return "none";
    return top === realpath(this.dir) && markedDedicated ? "dedicated" : "shared";
  }

  async init(branch: string): Promise<void> {
    if (await this.toplevel()) return;
    await this.git(["init", "-b", branch], { cwd: this.dir });
    await this.ensureIdentity();
  }

  /** A repository with no identity cannot commit; set one locally rather than failing at publish. */
  async ensureIdentity(): Promise<void> {
    const email = await this.git(["config", "--get", "user.email"], { cwd: this.dir, ok: true });
    if (email.code === 0 && email.stdout.trim()) return;
    await this.git(["config", "--local", "user.email", "tomrade@localhost"], { cwd: this.dir, ok: true });
    await this.git(["config", "--local", "user.name", "Tomrade"], { cwd: this.dir, ok: true });
  }

  async currentBranch(): Promise<string | null> {
    const r = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: this.dir, ok: true });
    const name = r.stdout.trim();
    return r.code === 0 && name && name !== "HEAD" ? name : null;
  }

  async remoteUrl(name = "origin"): Promise<string | null> {
    const r = await this.git(["remote", "get-url", name], { cwd: this.dir, ok: true });
    return r.code === 0 ? cleanRemote(r.stdout.trim()) : null;
  }

  async setRemote(url: string, name = "origin"): Promise<void> {
    const existing = await this.git(["remote", "get-url", name], { cwd: this.dir, ok: true });
    if (existing.code === 0) await this.git(["remote", "set-url", name, url], { cwd: this.dir });
    else await this.git(["remote", "add", name, url], { cwd: this.dir });
  }

  async removeRemote(name = "origin"): Promise<void> {
    await this.git(["remote", "remove", name], { cwd: this.dir, ok: true });
  }

  /** Stage a subtree (or everything) and commit if anything is staged. Returns whether a commit was made. */
  async commit(message: string, subtree?: string): Promise<boolean> {
    await this.git(subtree ? ["add", "-A", "--", subtree] : ["add", "-A"], { cwd: this.dir });
    const staged = await this.git(["diff", "--cached", "--quiet"], { cwd: this.dir, ok: true });
    if (staged.code === 0) return false;
    await this.ensureIdentity();
    await this.git(["commit", "-q", "-m", message], { cwd: this.dir });
    return true;
  }

  /**
   * Whether the remote has the branch, is reachable but has not got it yet (a
   * repository nobody has pushed to), or cannot be reached at all. Only the
   * last is "offline"; an empty repository is where every project starts.
   */
  async probe(branch: string, name = "origin"): Promise<"exists" | "absent" | "offline"> {
    const r = await this.git(["ls-remote", "--exit-code", name, `refs/heads/${branch}`], { cwd: this.dir, ok: true });
    if (r.code === 0) return "exists";
    return r.code === 2 ? "absent" : "offline";
  }

  /** `ok`: an unreachable remote is an answer, not a failure. */
  async fetch(branch: string, name = "origin"): Promise<boolean> {
    const r = await this.git(["fetch", "-q", name, branch], { cwd: this.dir, ok: true });
    return r.code === 0;
  }

  async aheadBehind(branch: string, name = "origin"): Promise<{ ahead: number; behind: number } | null> {
    const r = await this.git(["rev-list", "--left-right", "--count", `HEAD...${name}/${branch}`], { cwd: this.dir, ok: true });
    if (r.code !== 0) return null;
    const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  }

  /** Against the checkout's own upstream, for a shared folder's status line. */
  async aheadBehindUpstream(): Promise<{ ahead: number; behind: number } | null> {
    const r = await this.git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd: this.dir, ok: true });
    if (r.code !== 0) return null;
    const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  }

  async fastForward(branch: string, name = "origin"): Promise<void> {
    await this.git(["merge", "-q", "--ff-only", `${name}/${branch}`], { cwd: this.dir });
  }

  /** Non-fast-forward is reported as `false`, never forced. */
  async push(branch: string, name = "origin"): Promise<boolean> {
    const r = await this.git(["push", "-q", name, `HEAD:refs/heads/${branch}`], { cwd: this.dir, ok: true });
    return r.code === 0;
  }

  async mergeBase(branch: string, name = "origin"): Promise<string | null> {
    const r = await this.git(["merge-base", "HEAD", `${name}/${branch}`], { cwd: this.dir, ok: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** A file's content at a commit, or null when it did not exist there. */
  async show(commit: string, rel: string): Promise<string | null> {
    const r = await this.git(["show", `${commit}:${rel.split(path.sep).join("/")}`], { cwd: this.dir, ok: true });
    return r.code === 0 ? r.stdout : null;
  }

  /** Files under a path at a commit. */
  async listAt(commit: string, rel: string): Promise<string[]> {
    const r = await this.git(["ls-tree", "-r", "--name-only", commit, "--", rel.split(path.sep).join("/")], { cwd: this.dir, ok: true });
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  }

  /**
   * Start a merge commit with the remote: their files outside `.tomrade/` come
   * along (a README GitHub wrote when the repository was made, say), and the
   * caller then writes the merged artifact over `.tomrade/` and commits, so
   * history records both parents and the push fast-forwards the remote. Two
   * machines that each started a repository share no commit yet, hence
   * unrelated histories are allowed.
   */
  async beginMerge(branch: string, name = "origin"): Promise<void> {
    const r = await this.git(["merge", "-q", "--no-ff", "--no-commit", "--allow-unrelated-histories", `${name}/${branch}`], { cwd: this.dir, ok: true });
    if (r.code === 0) return;
    const conflicted = (await this.git(["diff", "--name-only", "--diff-filter=U"], { cwd: this.dir, ok: true })).stdout.split("\n").filter(Boolean);
    if (!conflicted.length) {
      // Not a content clash: fall back to a merge that keeps our tree outright.
      await this.git(["merge", "--abort"], { cwd: this.dir, ok: true });
      await this.git(["merge", "-q", "--no-ff", "--no-commit", "--allow-unrelated-histories", "-s", "ours", `${name}/${branch}`], { cwd: this.dir });
      return;
    }
    // A clash outside the artifact keeps ours; inside it, the caller's merged files overwrite whatever git left.
    for (const file of conflicted) await this.git(["checkout", "--ours", "--", file], { cwd: this.dir, ok: true });
    await this.git(["add", "-A", "--", ...conflicted], { cwd: this.dir, ok: true });
  }

  /** The artifact's files at a commit, shaped like a folder's. */
  async filesAt(commit: string, dir: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const rel of await this.listAt(commit, dir)) {
      if (!rel.endsWith(".jsonl") && !rel.endsWith("project.json")) continue;
      const body = await this.show(commit, rel);
      if (body !== null) files.set(rel.split("/").join(path.sep), body);
    }
    return files;
  }

  /** Reset the working tree to the remote branch — only ever in a folder that is Tomrade's own. */
  async resetTo(branch: string, name = "origin"): Promise<void> {
    await this.git(["reset", "-q", "--hard", `${name}/${branch}`], { cwd: this.dir });
  }
}

/** Reachable with the branch, reachable without it, unreachable, or reachable but refused (no access, or nothing there). */
export type RemoteReach = "exists" | "absent" | "offline" | "denied";

const lastWords = (stderr: string): string | undefined => stderr.replace(/\/\/[^@\s/]*@/g, "//").trim().split("\n").slice(-2).join(" ").slice(0, 300) || undefined;

/** git words a network failure differently per transport; anything else is the server saying no. */
const OFFLINE = /could not resolve|failed to connect|couldn't connect|connection (refused|timed out|reset|closed)|network is unreachable|timed out|no route to host|ssl|tls|proxy|unable to look up/i;

const reachOf = (detail: string | undefined): "offline" | "denied" => (detail && OFFLINE.test(detail) ? "offline" : "denied");

export async function probeUrl(git: Git, url: string, branch: string): Promise<{ reach: RemoteReach; detail?: string }> {
  const r = await git(["ls-remote", "--exit-code", url, `refs/heads/${branch}`], { ok: true });
  if (r.code === 0) return { reach: "exists" };
  if (r.code === 2) return { reach: "absent" };
  const detail = lastWords(r.stderr ?? "");
  return { reach: reachOf(detail), detail };
}

/** Clone one branch, or say why not without leaving a half-made folder behind. */
export async function cloneBranch(git: Git, url: string, branch: string, dir: string): Promise<{ ok: true } | { ok: false; reach: "offline" | "denied"; detail?: string }> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await git(["clone", "-q", "--branch", branch, "--single-branch", url, dir], { ok: true });
  if (r.code === 0) return { ok: true };
  fs.rmSync(dir, { recursive: true, force: true });
  const detail = lastWords(r.stderr ?? "");
  return { ok: false, reach: reachOf(detail), detail };
}

export async function cloneInto(git: Git, url: string, branch: string, dir: string): Promise<void> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await git(["clone", "-q", "--branch", branch, "--single-branch", url, dir], { ok: true });
  if (r.code === 0) return;
  // An empty repository, or a branch that does not exist yet: start it here.
  fs.mkdirSync(dir, { recursive: true });
  await git(["init", "-q", "-b", branch], { cwd: dir });
  await git(["remote", "add", "origin", url], { cwd: dir });
  const fetched = await git(["fetch", "-q", "origin", branch], { cwd: dir, ok: true });
  if (fetched.code === 0) await git(["reset", "-q", "--hard", `origin/${branch}`], { cwd: dir, ok: true });
}

export const hasConflictMarkers = (text: string): boolean => /^(<{7}|={7}|>{7})( |$)/m.test(text);
