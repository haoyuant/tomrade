import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { execGit, type Git } from "@tomradex/git";
import type { ChangeCommit, ChangedFile, ChangeFileOptions, ChangeReviewed, ChangeScope, ChangeScopeKind, ChangesOptions, ChangesSummary, ChangesView } from "./changes.js";
import { addedFileHunks, parseFileList, parsePatch, type ListedFile, type PatchFile } from "./changes-parse.js";
import { currentLinks, primaryOf } from "./scan/absorb.js";
import type { CodeLinkStore, CodeLinkView } from "./store.js";

/** What one answer reads of a change: past these, a file's hunks wait for `changeFile`. */
const BULK_LINES = 20_000;
const BULK_FILES = 300;
const BULK_FILE_LINES = 3_000;
const BULK_FILE_BYTES = 400 * 1024;
/** More context lines than a file has. */
const WHOLE_FILE = 10_000_000;
/** The most of one file `changeFile` hands back. */
const FILE_BYTES = 2 * 1024 * 1024;
/** Pathspecs go on the command line, which Windows caps near 32 000 characters. */
const PATHSPEC_CHARS = 24_000;
const COMMITS_MAX = 200;
/** What a commit with no parent, or a branch with no commit, is compared with. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** The largest file git does not track that a review's snapshot keeps: past it, the file is not copied into the repository. */
const SNAPSHOT_FILE_BYTES = 1024 * 1024;
/** Where the commit of a code link's last review is kept from being collected. */
const reviewedRef = (linkId: string) => `refs/tomrade/reviewed/${linkId}`;
/** A snapshot is nobody's commit: it must not fail for want of the person's identity, nor carry it. */
const SNAPSHOT_AUTHOR = { GIT_AUTHOR_NAME: "Tomrade", GIT_AUTHOR_EMAIL: "tomrade@localhost", GIT_COMMITTER_NAME: "Tomrade", GIT_COMMITTER_EMAIL: "tomrade@localhost" };

const GENERATED_NAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "Gemfile.lock", "composer.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "go.sum", "flake.lock"]);

/** A lockfile or a build output by its name alone; `.gitattributes` adds the repository's own. */
export function looksGenerated(file: string): boolean {
  const parts = file.split("/");
  const name = parts.at(-1) ?? "";
  return GENERATED_NAMES.has(name) || /\.min\.(js|css)$/.test(name) || /\.(js|css)\.map$/.test(name) || parts.slice(0, -1).includes("dist");
}

/** The two sides compared: commits or trees, or the working tree when `to` is null. */
interface Range {
  from: string;
  to: string | null;
}

interface Target {
  link: CodeLinkView;
  view: Omit<ChangesView, "files">;
  /** Where git runs: the folder with the working tree for `uncommitted`, any folder of the repository otherwise. */
  dir: string;
  range: Range;
  /**
   * The working tree is compared with a commit that may hold files git does not track: they are read through an index
   * of their own (`index`, set while one read lasts), where a plain diff would call them deleted.
   */
  untrackedToo?: boolean;
  index?: string;
}

export interface ChangesDeps {
  ctx: Context;
  store: CodeLinkStore;
  git: Git;
  /** The git command itself, for the few calls that need an index of their own. */
  binary: string;
  worktreeOf: (projectId: string, itemId: string) => string | null;
}

/** What a ticket changed, read from git in the shape a diff view draws. */
export class Changes {
  private readonly ctx: Context;
  private readonly store: CodeLinkStore;
  private readonly git: Git;
  private readonly binary: string;
  private readonly worktreeOf: ChangesDeps["worktreeOf"];

  constructor(deps: ChangesDeps) {
    this.ctx = deps.ctx;
    this.store = deps.store;
    this.git = deps.git;
    this.binary = deps.binary;
    this.worktreeOf = deps.worktreeOf;
  }

  /** The changed files of one code link in one scope; null when the ticket has no branch or git has nothing of it here. */
  async changes(projectId: string, itemId: string, opts: ChangesOptions = {}): Promise<ChangesView | null> {
    const target = await this.target(projectId, itemId, opts);
    if (!target) return null;
    return this.reading(target, async (t) => ({ ...t.view, files: await this.files(t, Boolean(opts.ignoreWhitespace)) }));
  }

  /** One file of that answer with every hunk, up to `FILE_BYTES`; null when the scope does not change it. */
  async changeFile(projectId: string, itemId: string, opts: ChangesOptions & ChangeFileOptions): Promise<ChangedFile | null> {
    const target = await this.target(projectId, itemId, opts);
    if (!target) return null;
    return this.reading(target, (t) => this.file(t, opts.path, Boolean(opts.ignoreWhitespace), Boolean(opts.full)));
  }

  /**
   * Records what the person now sees of a code link as reviewed: a snapshot of its working tree where one is here, else
   * the branch's tip. Null for a merged link, and for one git cannot show here.
   */
  async markReviewed(projectId: string, itemId: string, opts: { linkId?: string } = {}): Promise<ChangeReviewed | null> {
    const target = await this.target(projectId, itemId, { linkId: opts.linkId });
    if (!target || target.link.mergedSha || !target.view.head) return null;
    const folder = target.view.root;
    const sha = (folder ? await this.snapshot(folder) : null) ?? target.view.head;
    const kept = await this.git(["update-ref", reviewedRef(target.link.id), sha], { cwd: target.dir, ok: true });
    if (kept.code !== 0) return null;
    const reviewed = { sha, at: Date.now() };
    this.store.setReviewed(projectId, target.link.id, sha, reviewed.at);
    return reviewed;
  }

  /** One git command reading and writing `index` instead of the folder's own. */
  private async gitWith(index: string, args: string[], opts: { cwd: string; stdin?: string; env?: Record<string, string> }): Promise<{ stdout: string; code: number }> {
    try {
      const { stdout } = await execGit(this.binary, args, { cwd: opts.cwd, stdin: opts.stdin, maxBuffer: 16 * 1024 * 1024, env: { ...opts.env, GIT_INDEX_FILE: index } });
      return { stdout, code: 0 };
    } catch (error) {
      const e = error as { code?: number | string | null; stdout?: string | Buffer };
      return { stdout: String(e.stdout ?? ""), code: typeof e.code === "number" ? e.code : 1 };
    }
  }

  /** A copy of the folder's index to work on, so nothing done with it shows in the folder; gone when `work` ends. */
  private async withIndex<T>(folder: string, work: (index: string) => Promise<T>): Promise<T | null> {
    const at = await this.git(["rev-parse", "--git-path", "index"], { cwd: folder, ok: true });
    if (at.code !== 0 || !at.stdout.trim()) return null;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-index-"));
    const index = path.join(tmp, "index");
    try {
      const own = path.resolve(folder, at.stdout.trim());
      // A repository nothing was ever added to has no index yet.
      if (fs.existsSync(own)) fs.copyFileSync(own, index);
      return await work(index);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** The files git does not track, named to `git add` in the copy `index`: `intent` records them without storing them. */
  private addUntracked(folder: string, index: string, files: string[], intent: boolean): Promise<{ code: number }> {
    return this.gitWith(index, ["--literal-pathspecs", "add", "--ignore-errors", ...(intent ? ["--intent-to-add"] : []), "--pathspec-from-file=-", "--pathspec-file-nul"], { cwd: folder, stdin: `${files.join("\0")}\0` });
  }

  /**
   * The folder's working tree as a commit on top of its HEAD: what git tracks as it now is, and the files it does not
   * track up to `SNAPSHOT_FILE_BYTES`. HEAD itself when nothing differs; null when it could not be made. The folder's
   * index, HEAD, stash and files are left as they are.
   */
  private async snapshot(folder: string): Promise<string | null> {
    const head = await this.sha(folder, "HEAD");
    if (!head) return null;
    return this.withIndex(folder, async (index) => {
      if ((await this.gitWith(index, ["add", "--update", "--ignore-errors"], { cwd: folder })).code !== 0) return null;
      const small = (await this.untracked(folder)).filter((file) => {
        try {
          const stat = fs.lstatSync(path.join(folder, file));
          return stat.isFile() && stat.size <= SNAPSHOT_FILE_BYTES;
        } catch {
          return false;
        }
      });
      if (small.length) await this.addUntracked(folder, index, small, false);
      const tree = (await this.gitWith(index, ["write-tree"], { cwd: folder })).stdout.trim();
      const same = await this.git(["rev-parse", "--verify", "--quiet", `${head}^{tree}`], { cwd: folder, ok: true });
      if (!tree) return null;
      if (same.code === 0 && same.stdout.trim() === tree) return head;
      // Never signed: a person's commit.gpgSign would ask for their key.
      const made = await this.gitWith(index, ["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", "Tomrade: reviewed"], { cwd: folder, env: SNAPSHOT_AUTHOR });
      return made.code === 0 ? made.stdout.trim() || null : null;
    });
  }

  /** One read of a target; where it compares the working tree with a snapshot, through an index that knows the untracked files. */
  private async reading<T>(target: Target, read: (target: Target) => Promise<T>): Promise<T> {
    if (!target.untrackedToo) return read(target);
    const answer = await this.withIndex(target.dir, async (index) => {
      const fresh = await this.untracked(target.dir);
      if (fresh.length) await this.addUntracked(target.dir, index, fresh, true);
      return { value: await read({ ...target, index }) };
    });
    // Without an index of its own the answer is still git's, less exact about files it does not track.
    return answer ? answer.value : read({ ...target, untrackedToo: false });
  }

  /** A read of the target's range: through its own index when it has one. */
  private async run(target: Target, args: string[], stdin?: string): Promise<{ stdout: string; code: number }> {
    return target.index ? this.gitWith(target.index, args, { cwd: target.dir, stdin }) : this.git(args, { cwd: target.dir, ok: true, stdin });
  }

  private async sha(dir: string, ref: string): Promise<string | null> {
    const out = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir, ok: true });
    return out.code === 0 ? out.stdout.trim() || null : null;
  }

  /** The folder on this machine that has the branch checked out: a worktree, or the checkout itself. */
  private async folderOf(projectId: string, itemId: string, branch: string, checkout: string | null): Promise<string | null> {
    if (checkout) {
      const list = await this.git(["worktree", "list", "--porcelain"], { cwd: checkout, ok: true });
      if (list.code === 0) {
        for (const block of list.stdout.split(/\r?\n\r?\n/)) {
          const lines = block.split(/\r?\n/);
          const dir = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
          if (dir && lines.includes(`branch refs/heads/${branch}`) && fs.existsSync(dir)) return dir;
        }
      }
    }
    const own = this.worktreeOf(projectId, itemId);
    if (!own || !fs.existsSync(own)) return null;
    const head = await this.git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: own, ok: true });
    return head.code === 0 && head.stdout.trim() === branch ? own : null;
  }

  private async commits(dir: string, base: string, head: string): Promise<ChangeCommit[]> {
    const out = await this.git(["log", `--max-count=${COMMITS_MAX}`, "--format=%H%x1f%s%x1f%an%x1f%at%x1e", `${base}..${head}`], { cwd: dir, ok: true });
    if (out.code !== 0) return [];
    return out.stdout
      .split("\x1e")
      .map((row) => row.trim().split("\x1f"))
      .filter((row) => row.length === 4)
      .map(([sha, subject, author, at]) => ({ sha, subject, author, at: Number(at) * 1000 }));
  }

  /** How much the ticket's branch changes, counted without reading a line of it; null as `changes` is. */
  async summary(projectId: string, itemId: string): Promise<ChangesSummary | null> {
    const target = await this.target(projectId, itemId, {});
    if (!target) return null;
    const listed = await this.listed(target, false);
    return { files: listed.length, additions: listed.reduce((n, f) => n + (f.additions ?? 0), 0), deletions: listed.reduce((n, f) => n + (f.deletions ?? 0), 0) };
  }

  /** The folder a code link's files are in on this machine; null when its branch is checked out nowhere here. */
  async rootOf(projectId: string, itemId: string, linkId?: string): Promise<string | null> {
    return (await this.target(projectId, itemId, { linkId }))?.view.root ?? null;
  }

  private async target(projectId: string, itemId: string, opts: ChangesOptions): Promise<Target | null> {
    const links = currentLinks(this.store, projectId, itemId).filter((l) => l.branch);
    const link = links.find((l) => l.id === opts.linkId) ?? primaryOf(links);
    const repo = link ? this.ctx.repos.get(projectId, link.repoId) : null;
    if (!link || !repo) return null;
    const known = this.ctx.repos.checkout(repo.remote).checkout;
    const checkout = known && fs.existsSync(known) ? known : null;
    const folder = await this.folderOf(projectId, itemId, link.branch, checkout);
    const dir = checkout ?? folder;
    if (!dir) return null;

    let base: string | null;
    let head: string | null;
    if (link.mergedSha) {
      head = await this.sha(dir, link.mergedSha);
      base = head ? await this.sha(dir, `${head}^1`) : null;
    } else {
      head = (await this.sha(dir, `refs/heads/${link.branch}`)) ?? (await this.sha(dir, `refs/remotes/origin/${link.branch}`));
      const local = this.store.repoState(projectId, repo.id)?.remote === "none";
      const onto = (local ? null : await this.sha(dir, `refs/remotes/origin/${repo.defaultBranch}`)) ?? (await this.sha(dir, `refs/heads/${repo.defaultBranch}`));
      const fork = head && onto ? await this.git(["merge-base", onto, head], { cwd: dir, ok: true }) : null;
      base = fork && fork.code === 0 ? fork.stdout.trim() || null : null;
    }
    if (!base || !head) return null;

    const commits = await this.commits(dir, base, head);
    const mark = this.store.reviewed(projectId, link.id);
    const reviewed = mark && (await this.sha(dir, mark.sha)) ? mark : null;
    // Once merged, what came since a review is the default branch's work as much as the ticket's.
    const since = reviewed && !link.mergedSha;
    const scopes: ChangeScopeKind[] = ["branch", ...(folder ? (["uncommitted"] as const) : []), ...(commits.length ? (["commit"] as const) : []), ...(since ? (["since"] as const) : [])];
    const repos = new Map(links.map((l) => [l.id, this.ctx.repos.get(projectId, l.repoId)?.name ?? ""]));
    const view = { linkId: link.id, links: links.map((l) => ({ id: l.id, branch: l.branch, repoName: repos.get(l.id) ?? "" })), scopes, reviewed, commits, root: folder };
    const asked = opts.scope ?? { kind: "branch" };

    if (asked.kind === "since" && since) {
      const scope: ChangeScope = { kind: "since" };
      if (folder) return { link, dir: folder, range: { from: reviewed.sha, to: null }, untrackedToo: true, view: { ...view, scope, base: reviewed.sha, head: null } };
      return { link, dir, range: { from: reviewed.sha, to: head }, view: { ...view, scope, base: reviewed.sha, head } };
    }

    if (asked.kind === "uncommitted" && folder) {
      const at = await this.sha(folder, "HEAD");
      return { link, dir: folder, range: { from: at ?? EMPTY_TREE, to: null }, view: { ...view, scope: { kind: "uncommitted" }, base: at, head: null } };
    }
    const commit = asked.kind === "commit" && asked.sha.length >= 7 ? commits.find((c) => c.sha.startsWith(asked.sha)) : undefined;
    if (commit) {
      const parent = await this.sha(dir, `${commit.sha}^1`);
      const scope: ChangeScope = { kind: "commit", sha: commit.sha };
      return { link, dir, range: { from: parent ?? EMPTY_TREE, to: commit.sha }, view: { ...view, scope, base: parent, head: commit.sha } };
    }
    // A scope this machine cannot show (no worktree here, a commit the branch no longer has, nothing reviewed yet) falls back to the branch.
    return { link, dir, range: { from: base, to: head }, view: { ...view, scope: { kind: "branch" }, base, head } };
  }

  private diffArgs(range: Range, ignoreWhitespace: boolean): string[] {
    // Prefixes and quoting are pinned: a person's diff.noprefix or core.quotePath would change what the parser reads.
    return ["-c", "core.quotePath=false", "--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--src-prefix=a/", "--dst-prefix=b/", ...(ignoreWhitespace ? ["-w"] : []), range.from, ...(range.to ? [range.to] : [])];
  }

  private async listed(target: Target, ignoreWhitespace: boolean): Promise<ListedFile[]> {
    const out = await this.run(target, [...this.diffArgs(target.range, ignoreWhitespace), "--raw", "--numstat", "-z"]);
    return out.code === 0 ? parseFileList(out.stdout) : [];
  }

  /** The patch of these files (of every file when `only` is null) by path; null when git could not hand it over whole. */
  private async patch(target: Target, ignoreWhitespace: boolean, only: ListedFile[] | null, maxBytes = Infinity, full = false): Promise<Map<string, PatchFile> | null> {
    const paths = only ? ["--", ...only.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]))] : [];
    // Every unchanged line as context: the whole file comes back as one hunk.
    const out = await this.run(target, [...this.diffArgs(target.range, ignoreWhitespace), ...(full ? [`--unified=${WHOLE_FILE}`] : []), ...paths]);
    // Cut off by the runner's own limit: what arrived is still good up to its last whole line when a limit was asked for.
    if (out.code !== 0 && (maxBytes === Infinity || !out.stdout)) return null;
    return new Map(parsePatch(out.stdout, out.code === 0 ? maxBytes : Math.min(maxBytes, out.stdout.length - 1)).map((f) => [f.path, f]));
  }

  private async generated(dir: string, paths: string[]): Promise<Set<string>> {
    const found = new Set(paths.filter(looksGenerated));
    const rest = paths.filter((p) => !found.has(p));
    if (!rest.length) return found;
    const out = await this.git(["check-attr", "-z", "--stdin", "linguist-generated"], { cwd: dir, ok: true, stdin: `${rest.join("\0")}\0` });
    if (out.code !== 0) return found;
    const fields = out.stdout.split("\0");
    for (let i = 0; i + 2 < fields.length; i += 3) if (fields[i + 2] === "set" || fields[i + 2] === "true") found.add(fields[i]);
    return found;
  }

  private async untracked(folder: string, only?: string): Promise<string[]> {
    const out = await this.git(["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", ...(only ? ["--", only] : [])], { cwd: folder, ok: true });
    if (out.code !== 0) return [];
    return out.stdout.split("\0").filter((p) => p && !p.endsWith("/"));
  }

  /** A file git does not track yet, read from the folder: every line of it is an addition. */
  private newFile(folder: string, file: string, generated: boolean, maxBytes: number | null): ChangedFile | null {
    const full = path.resolve(folder, file);
    if (!full.startsWith(path.resolve(folder) + path.sep)) return null;
    let size: number;
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isFile()) return null;
      size = stat.size;
    } catch {
      return null;
    }
    const row: ChangedFile = { path: file, oldPath: null, status: "added", additions: null, deletions: 0, binary: false, generated, truncated: false, hunks: null };
    const want = maxBytes === null ? 8000 : Math.min(size, maxBytes);
    const bytes = Buffer.alloc(Math.min(size, want));
    const fd = fs.openSync(full, "r");
    try {
      fs.readSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    // What git itself goes by: a NUL early on means it is not text.
    if (bytes.subarray(0, 8000).includes(0)) return { ...row, binary: true, deletions: null };
    if (maxBytes === null) return { ...row, truncated: true };
    const cut = size > bytes.length;
    const text = bytes.toString("utf8");
    const hunks = addedFileHunks(cut ? text.slice(0, text.lastIndexOf("\n") + 1) : text);
    return { ...row, additions: cut ? null : (hunks[0]?.lines.length ?? 0), truncated: cut, hunks };
  }

  private async files(target: Target, ignoreWhitespace: boolean): Promise<ChangedFile[]> {
    const listed = await this.listed(target, ignoreWhitespace);
    // With an index of its own, git lists the files it does not track among the rest.
    const fresh = target.range.to === null && !target.index ? await this.untracked(target.dir) : [];
    const generated = await this.generated(target.dir, [...listed.map((f) => f.path), ...fresh]);

    // What fits in one answer, in git's order; the rest keeps its counts and waits for `changeFile`.
    let lines = 0;
    let chars = 0;
    const read: ListedFile[] = [];
    for (const file of listed) {
      const size = (file.additions ?? 0) + (file.deletions ?? 0);
      const spec = file.path.length + (file.oldPath?.length ?? 0) + 2;
      if (file.binary || generated.has(file.path) || size > BULK_FILE_LINES || read.length >= BULK_FILES || lines + size > BULK_LINES || chars + spec > PATHSPEC_CHARS) continue;
      lines += size;
      chars += spec;
      read.push(file);
    }
    const patch = read.length ? await this.patch(target, ignoreWhitespace, read.length === listed.length ? null : read) : new Map<string, PatchFile>();
    const wanted = new Set(patch ? read.map((f) => f.path) : []);
    const files: ChangedFile[] = listed.map((file) => {
      const row = { ...file, generated: generated.has(file.path) };
      if (file.binary) return { ...row, truncated: false, hunks: null };
      if (!wanted.has(file.path)) return { ...row, truncated: true, hunks: null };
      const hunks = patch!.get(file.path)?.hunks ?? [];
      // Lines are counted, bytes are not: one minified line can weigh megabytes.
      const bytes = hunks.reduce((sum, h) => sum + h.lines.reduce((n, l) => n + l.text.length, 0), 0);
      return bytes > BULK_FILE_BYTES ? { ...row, truncated: true, hunks: null } : { ...row, truncated: false, hunks };
    });

    let count = read.length;
    for (const file of fresh) {
      const within = count < BULK_FILES && lines < BULK_LINES && !generated.has(file);
      const row = this.newFile(target.dir, file, generated.has(file), within ? BULK_FILE_BYTES : null);
      if (!row) continue;
      // A file too large for the answer comes back cut; here it is left whole for `changeFile` instead.
      files.push(row.truncated ? { ...row, additions: null, hunks: null } : row);
      if (row.truncated || !row.hunks) continue;
      count++;
      lines += row.additions ?? 0;
    }
    return files;
  }

  private async file(target: Target, file: string, ignoreWhitespace: boolean, full: boolean): Promise<ChangedFile | null> {
    const listed = (await this.listed(target, ignoreWhitespace)).find((f) => f.path === file);
    const generated = (await this.generated(target.dir, [file])).has(file);
    if (!listed) {
      if (target.range.to !== null || target.index || !(await this.untracked(target.dir, file)).includes(file)) return null;
      return this.newFile(target.dir, file, generated, FILE_BYTES);
    }
    if (listed.binary) return { ...listed, generated, truncated: false, hunks: null };
    const patch = await this.patch(target, ignoreWhitespace, [listed], FILE_BYTES, full);
    if (!patch) return { ...listed, generated, truncated: true, hunks: null };
    const parsed = patch.get(file);
    return { ...listed, generated, truncated: parsed?.truncated ?? false, hunks: parsed?.hunks ?? [] };
  }
}
