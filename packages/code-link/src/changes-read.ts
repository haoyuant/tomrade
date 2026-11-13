import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { contract } from "@tomradex/contracts";
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
/** Where the folder at each end of a run is kept from being collected. */
const runRef = (linkId: string, id: string, end: "before" | "after") => `refs/tomrade/runs/${linkId}/${id}/${end}`;
/** The runs kept for one code link; older ones go, and their commits with them. */
const RUNS_KEPT = 30;
/** The largest picture read for a comparison. */
const IMAGE_BYTES = 4 * 1024 * 1024;
/** A snapshot is nobody's commit: it must not fail for want of the person's identity, nor carry it. */
const SNAPSHOT_AUTHOR = { GIT_AUTHOR_NAME: "Tomrade", GIT_AUTHOR_EMAIL: "tomrade@localhost", GIT_COMMITTER_NAME: "Tomrade", GIT_COMMITTER_EMAIL: "tomrade@localhost" };

const GENERATED_NAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "Gemfile.lock", "composer.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "go.sum", "flake.lock"]);

/** A lockfile or a build output by its name alone; `.gitattributes` adds the repository's own. */
export function looksGenerated(file: string): boolean {
  const parts = file.split("/");
  const name = parts.at(-1) ?? "";
  return GENERATED_NAMES.has(name) || /\.min\.(js|css)$/.test(name) || /\.(js|css)\.map$/.test(name) || parts.slice(0, -1).includes("dist");
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The pictures a diff shows, told by their first bytes. Never SVG: it can carry script. */
function rasterMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(PNG)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
  return null;
}

/** `folder` is `root` or a folder in it, whichever way either is spelled. */
function inside(root: string, folder: string): boolean {
  const real = (dir: string) => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  };
  const [outer, inner] = [real(root), real(folder)];
  return inner === outer || inner.startsWith(outer + path.sep);
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
    return this.reading(target, async (t) => ({ ...t.view, files: t.view.unavailable ? [] : await this.files(t, Boolean(opts.ignoreWhitespace)) }));
  }

  /** One file of that answer with every hunk, up to `FILE_BYTES`; null when the scope does not change it. */
  async changeFile(projectId: string, itemId: string, opts: ChangesOptions & ChangeFileOptions): Promise<ChangedFile | null> {
    const target = await this.target(projectId, itemId, opts);
    if (!target || target.view.unavailable) return null;
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

  /**
   * A run begins on a ticket: every code link of it checked out where the run works has its folder kept as a commit,
   * before the run writes there. A folder that cannot be kept is recorded so, and the run has no diff to show. True
   * when the run began somewhere it had not.
   */
  async startRun(projectId: string, itemId: string, id: string, source: string, cwd?: string | null): Promise<boolean> {
    let begun = false;
    for (const link of currentLinks(this.store, projectId, itemId).filter((l) => l.branch)) {
      if (this.store.changeRuns(projectId, link.id).some((run) => run.id === id)) continue;
      const root = await this.rootOf(projectId, itemId, link.id);
      if (!root || (cwd && !inside(root, cwd))) continue;
      const before = await this.keep(root, runRef(link.id, id, "before"));
      this.store.startChangeRun(projectId, link.id, { id, source, startedAt: Date.now(), before: before?.sha ?? null }, root, before?.left ?? "");
      for (const old of this.store.changeRuns(projectId, link.id).slice(RUNS_KEPT)) await this.dropRun(projectId, link.id, old.id, root);
      begun = true;
    }
    return begun;
  }

  /**
   * The run is over: each folder it began in is kept again. One it changed nothing in is forgotten there; one where a
   * file too large to keep was written, changed or removed meanwhile has no end, since its diff would leave that out.
   * True when the run was running.
   */
  async endRun(projectId: string, id: string): Promise<boolean> {
    const open = this.store.openChangeRuns(projectId, id);
    for (const run of open) {
      const kept = fs.existsSync(run.root) ? await this.keep(run.root, runRef(run.linkId, id, "after")) : null;
      const after = kept && kept.left === run.leftOut ? kept.sha : null;
      if (run.before && after && (await this.sameTree(run.root, run.before, after))) await this.dropRun(projectId, run.linkId, id, run.root);
      else this.store.endChangeRun(projectId, run.linkId, id, after, Date.now());
    }
    return open.length > 0;
  }

  /** The folder as a commit that `ref` keeps, with what that commit leaves out. */
  private async keep(folder: string, ref: string): Promise<{ sha: string; left: string } | null> {
    const made = await this.snapshotWith(folder);
    if (!made) return null;
    const kept = await this.git(["update-ref", ref, made.sha], { cwd: folder, ok: true });
    return kept.code === 0 ? made : null;
  }

  private async sameTree(dir: string, one: string, other: string): Promise<boolean> {
    if (one === other) return true;
    const trees = await this.git(["rev-parse", `${one}^{tree}`, `${other}^{tree}`], { cwd: dir, ok: true });
    const [a, b] = trees.stdout.trim().split(/\s+/);
    return trees.code === 0 && !!a && a === b;
  }

  private async dropRun(projectId: string, linkId: string, id: string, dir: string): Promise<void> {
    if (fs.existsSync(dir)) for (const end of ["before", "after"] as const) await this.git(["update-ref", "-d", runRef(linkId, id, end)], { cwd: dir, ok: true });
    this.store.dropChangeRun(projectId, linkId, id);
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
    return (await this.snapshotWith(folder))?.sha ?? null;
  }

  /** `snapshot`, with what it left out: the untracked files it did not copy, each with its size and when it was written, as one text to compare with another snapshot's. */
  private async snapshotWith(folder: string): Promise<{ sha: string; left: string } | null> {
    const head = await this.sha(folder, "HEAD");
    if (!head) return null;
    return this.withIndex(folder, async (index) => {
      if ((await this.gitWith(index, ["add", "--update", "--ignore-errors"], { cwd: folder })).code !== 0) return null;
      const left: string[] = [];
      const small = (await this.untracked(folder)).filter((file) => {
        try {
          const stat = fs.lstatSync(path.join(folder, file));
          if (stat.isFile() && stat.size <= SNAPSHOT_FILE_BYTES) return true;
          left.push(`${file}\t${stat.size}\t${stat.mtimeMs}`);
        } catch {
          // Gone since it was listed.
        }
        return false;
      });
      if (small.length) await this.addUntracked(folder, index, small, false);
      const tree = (await this.gitWith(index, ["write-tree"], { cwd: folder })).stdout.trim();
      const same = await this.git(["rev-parse", "--verify", "--quiet", `${head}^{tree}`], { cwd: folder, ok: true });
      if (!tree) return null;
      if (same.code === 0 && same.stdout.trim() === tree) return { sha: head, left: left.join("\n") };
      // Never signed: a person's commit.gpgSign would ask for their key.
      const made = await this.gitWith(index, ["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", "Tomrade: reviewed"], { cwd: folder, env: SNAPSHOT_AUTHOR });
      const sha = made.code === 0 ? made.stdout.trim() : "";
      return sha ? { sha, left: left.join("\n") } : null;
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
    const runs = this.store.changeRuns(projectId, link.id);
    if (runs.length) scopes.push("run");
    const view = { linkId: link.id, links: links.map((l) => ({ id: l.id, branch: l.branch, repoName: repos.get(l.id) ?? "" })), scopes, reviewed, commits, root: folder, runs, report: this.report(projectId, itemId, link) };
    const asked = opts.scope ?? { kind: "branch" };

    if (asked.kind === "run") {
      const run = runs.find((r) => r.id === asked.id);
      const from = run?.before ? await this.sha(dir, run.before) : null;
      const to = run?.after ? await this.sha(dir, run.after) : null;
      // A run without both ends is said to have none, rather than shown as something else's changes.
      return { link, dir, range: { from: from ?? base, to: to ?? head }, view: { ...view, scope: asked, base: from, head: to, unavailable: !from || !to } };
    }

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

  /** What was last submitted for the delivery a code link is of. */
  private report(projectId: string, itemId: string, link: CodeLinkView): string | null {
    const delivery = this.store.deliveries(projectId, itemId).find((d) => d.sequence === link.delivery);
    const submissions = contract(this.ctx, "items")?.get(projectId, itemId)?.evidence.submissions ?? [];
    return submissions.filter((s) => s.deliveryId === delivery?.id).sort((a, b) => b.submittedAt - a.submittedAt)[0]?.report ?? null;
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

  /** One side of a binary file as a picture: as a commit has it, or as the folder does when `ref` is null. Null for anything else. */
  private async picture(dir: string, ref: string | null, file: string): Promise<string | null> {
    try {
      let bytes: Buffer;
      if (ref) {
        bytes = (await execGit(this.binary, ["show", `${ref}:${file}`], { cwd: dir, encoding: "buffer", maxBuffer: IMAGE_BYTES })).stdout;
      } else {
        // The folder's own file, never one a link leads out of it.
        const root = await fs.promises.realpath(dir);
        const full = await fs.promises.realpath(path.join(root, file));
        if (!full.startsWith(root + path.sep) || (await fs.promises.stat(full)).size > IMAGE_BYTES) return null;
        bytes = await fs.promises.readFile(full);
      }
      const mime = rasterMime(bytes);
      return mime ? `data:${mime};base64,${bytes.toString("base64")}` : null;
    } catch {
      return null;
    }
  }

  private async file(target: Target, file: string, ignoreWhitespace: boolean, full: boolean): Promise<ChangedFile | null> {
    const listed = (await this.listed(target, ignoreWhitespace)).find((f) => f.path === file);
    const generated = (await this.generated(target.dir, [file])).has(file);
    if (!listed) {
      if (target.range.to !== null || target.index || !(await this.untracked(target.dir, file)).includes(file)) return null;
      const fresh = this.newFile(target.dir, file, generated, FILE_BYTES);
      if (!fresh?.binary) return fresh;
      const after = await this.picture(target.dir, null, file);
      return { ...fresh, image: after ? { before: null, after } : null };
    }
    if (listed.binary) {
      const before = listed.status === "added" ? null : await this.picture(target.dir, target.range.from, listed.oldPath ?? listed.path);
      const after = listed.status === "deleted" ? null : await this.picture(target.dir, target.range.to, listed.path);
      return { ...listed, generated, truncated: false, hunks: null, image: before || after ? { before, after } : null };
    }
    const patch = await this.patch(target, ignoreWhitespace, [listed], FILE_BYTES, full);
    if (!patch) return { ...listed, generated, truncated: true, hunks: null };
    const parsed = patch.get(file);
    return { ...listed, generated, truncated: parsed?.truncated ?? false, hunks: parsed?.hunks ?? [] };
  }
}
