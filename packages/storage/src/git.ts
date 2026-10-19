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
  readonly stdout: string;
  readonly code: number | string | null;
  readonly signal: string | null;

  constructor(
    public readonly args: string[],
    public readonly stderr: string,
    exit: { stdout?: string; code?: number | string | null; signal?: string | null } = {}
  ) {
    // A token reaches us inside a remote URL — in git's own output AND in the
    // arguments we passed it. Both must be scrubbed before this reaches a log,
    // a toast or a status line.
    const scrub = (text: string) => text.replace(/\/\/[^@\s/]*@/g, "//");
    // Some refusals come on stdout ("nothing to commit"); a reason left empty helps nobody.
    const said = scrub(stderr.trim() ? stderr : (exit.stdout ?? "")).trim().split("\n").slice(-3).join(" ").slice(0, 400);
    const how = exit.signal ? `killed by ${exit.signal}` : exit.code !== undefined && exit.code !== null ? `exit ${exit.code}` : null;
    super(`git ${scrub(args.join(" "))} failed${how ? ` (${how})` : ""}${said ? `: ${said}` : ""}`);
    this.name = "GitError";
    this.stdout = exit.stdout ?? "";
    this.code = exit.code ?? null;
    this.signal = exit.signal ?? null;
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

/** A credential helper for one URL prefix, used by a single git command rather than written to any config. */
export interface GitCredential {
  url: string;
  helper: string;
}

/**
 * Command-line config that makes each helper the only one for its URL: the
 * empty value first clears whatever the user's own config lists, so another
 * account's stored password is never tried.
 */
export const credentialArgs = (credentials: GitCredential[]): string[] =>
  credentials.flatMap((c) => ["-c", `credential.${c.url}.helper=`, "-c", `credential.${c.url}.helper=${c.helper}`]);

/** `credentials` is asked before every command, so a connection made or dropped takes effect at once. */
export function gitRunner(binary: string, defaultCwd?: string, credentials?: () => GitCredential[]): Git {
  return async (args, opts = {}) => {
    const cwd = opts.cwd ?? defaultCwd;
    const argv = [...credentialArgs(credentials?.() ?? []), ...args];
    for (let attempt = 0; ; attempt++) {
      try {
        const { stdout, stderr } = await exec(binary, argv, { cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer: 16 * 1024 * 1024 }, opts.stdin);
        return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
      } catch (error) {
        const e = error as { code?: number | string | null; signal?: string | null; stderr?: string | Buffer; stdout?: string | Buffer };
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
        throw new GitError(args, stderrText, { stdout: String(e.stdout ?? ""), code: e.code ?? null, signal: e.signal ?? null });
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

  /**
   * Point origin at `url` when it names the same repository with a credential
   * written into it, as remotes once were. A different repository is left
   * alone. Returns whether it changed.
   */
  async dropRemoteCredential(url: string, name = "origin"): Promise<boolean> {
    const r = await this.git(["remote", "get-url", name], { cwd: this.dir, ok: true });
    const current = r.stdout.trim();
    if (r.code !== 0 || current === url || cleanRemote(current) === current || cleanRemote(current) !== cleanRemote(url)) return false;
    await this.git(["remote", "set-url", name, url], { cwd: this.dir });
    return true;
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
    if (!subtree) await this.dropEmbeddedRepositories();
    if (!(await this.staged())) return false;
    await this.ensureIdentity();
    try {
      await this.git(["commit", "-q", "-m", message], { cwd: this.dir });
    } catch (error) {
      // Another git committed what we staged in between: nothing was left to record, which is no failure.
      if (!(await this.staged())) return false;
      throw error;
    }
    return true;
  }

  private async staged(): Promise<boolean> {
    return (await this.git(["diff", "--cached", "--quiet"], { cwd: this.dir, ok: true })).code !== 0;
  }

  /**
   * `add -A` records a repository inside the folder (the Files store, before
   * its ignore line exists) as a bare commit pointer no clone can fill. Only a
   * submodule `.gitmodules` declares is meant; any other pointer leaves the
   * index, one an earlier commit recorded included.
   */
  private async dropEmbeddedRepositories(): Promise<void> {
    const staged = await this.git(["ls-files", "-s", "-z"], { cwd: this.dir });
    const pointers = staged.stdout.split("\0").filter((line) => line.startsWith("160000 ")).map((line) => line.slice(line.indexOf("\t") + 1));
    if (!pointers.length) return;
    const modules = await this.git(["config", "-z", "-f", ".gitmodules", "--get-regexp", "\\.path$"], { cwd: this.dir, ok: true });
    const declared = new Set(modules.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(entry.indexOf("\n") + 1)));
    const strays = pointers.filter((p) => !declared.has(p));
    if (strays.length) await this.git(["update-index", "--force-remove", "--", ...strays], { cwd: this.dir });
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

  /** Where this folder last saw the remote branch, or null before any fetch. */
  async tip(branch: string, name = "origin"): Promise<string | null> {
    const r = await this.git(["rev-parse", "-q", "--verify", `refs/remotes/${name}/${branch}`], { cwd: this.dir, ok: true });
    return r.code === 0 ? r.stdout.trim() : null;
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

/** Whether any git runs on this machine now. Where that cannot be told (no pgrep, Windows) one is assumed to. */
export const gitRunning = (): Promise<boolean> =>
  process.platform === "win32" ? Promise.resolve(true) : new Promise((resolve) => execFile("pgrep", ["-x", "git"], (error) => resolve((error as { code?: unknown } | null)?.code !== 1)));

const statOf = (file: string): fs.Stats | null => {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
};

/**
 * A git killed mid-command (a forced quit, a power cut) leaves `index.lock`
 * behind, and every commit there fails until it goes. It is taken away only
 * when nothing can still own it: it is older than any command holds it, and no
 * git runs on this machine at all. Returns whether it was removed.
 */
export async function clearStaleIndexLock(dir: string, opts: { olderThanMs?: number; running?: () => Promise<boolean> } = {}): Promise<boolean> {
  const lock = path.join(dir, ".git", "index.lock");
  const seen = statOf(lock);
  if (!seen || Date.now() - seen.mtimeMs < (opts.olderThanMs ?? 60_000)) return false;
  if (await (opts.running ?? gitRunning)()) return false;
  // A git that started meanwhile made a lock of its own; that one is not stale.
  const now = statOf(lock);
  if (!now || now.ino !== seen.ino || now.mtimeMs !== seen.mtimeMs) return false;
  fs.rmSync(lock, { force: true });
  return true;
}
