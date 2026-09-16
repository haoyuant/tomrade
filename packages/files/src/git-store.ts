import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FileReference } from "@tomrade/domain";
import { GIT_ENV, GitFolder, type Git } from "@tomrade/storage";
import { isTextMime, looksBinary, mimeOf } from "./mime.js";
import {
  FileMovedOnError,
  InvalidPathError,
  type ConflictChoice,
  type FileChange,
  type FileConflict,
  type FileContent,
  type FileEntry,
  type FileStore,
  type FileVersion,
  type FilesStatus,
  type WriteOptions
} from "./types.js";

export const IDS_DIR = ".tomrade-files";
export const IDS_FILE = `${IDS_DIR}/ids.jsonl`;
const KEEP = ".keep";
const TEXT_LIMIT = 2 * 1024 * 1024;
const BINARY_LIMIT = 8 * 1024 * 1024;
const TREE_LIMIT = 20_000;
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export interface GitRemoteTarget {
  url: string;
  branch: string;
}

export interface GitStoreOptions {
  git: Git;
  gitBinary: string;
  dir: string;
  /** Resolved on every use, so a changed credential is picked up. Null: this machine only. */
  remote: (() => Promise<GitRemoteTarget> | GitRemoteTarget) | null;
  /** Bring the remote into being before the first push. */
  ensureRemote?: () => Promise<void>;
  /** Non-secret, for status lines; the folder when null. */
  location: string | null;
  warn(message: string): void;
  onChange(): void;
  watch?: boolean;
  /** Outside edits are saved this long after the last one. */
  settleMs?: number;
  /** A save is pushed this long after it, when there is a remote. */
  pushMs?: number;
}

/** Relative, forward-slashed, inside the store, nothing hidden. "" is the root. */
export function normalizeRel(input: string): string {
  const cleaned = input.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  if (!cleaned) return "";
  const parts = cleaned.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.startsWith(".")) throw new InvalidPathError(input);
  }
  return parts.join("/");
}

const hidden = (rel: string): boolean => rel.split("/").some((part) => part.startsWith("."));

interface LedgerLine {
  id: string;
  path: string | null;
  at: number;
}

export interface Ledger {
  byId: Map<string, { path: string | null; at: number }>;
  byPath: Map<string, string>;
}

/**
 * The id ledger is append-only and merges by union, so both machines' lines
 * survive a clash; the latest `at` per id wins, and a path names the id that
 * last claimed it.
 */
export function parseLedger(text: string): Ledger {
  const lines: LedgerLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw) as Partial<LedgerLine>;
      if (typeof line.id === "string" && (typeof line.path === "string" || line.path === null) && typeof line.at === "number") lines.push(line as LedgerLine);
    } catch {
      // a torn line from a sync tool; the next save rewrites nothing, later lines still count
    }
  }
  lines.sort((a, b) => a.at - b.at);
  const byId = new Map<string, { path: string | null; at: number }>();
  for (const line of lines) byId.set(line.id, { path: line.path, at: line.at });
  const byPath = new Map<string, string>();
  for (const [id, { path: p }] of [...byId].sort((a, b) => a[1].at - b[1].at)) if (p !== null) byPath.set(p, id);
  return { byId, byPath };
}

const execBuffer = (binary: string, args: string[], cwd: string): Promise<Buffer | null> =>
  new Promise((resolve) => {
    execFile(binary, args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...GIT_ENV } }, (error, stdout) => resolve(error ? null : (stdout as Buffer)));
  });

interface StagedChange {
  status: "A" | "M" | "D" | "R" | "T";
  from?: string;
  path: string;
}

const changeOf = (xy: string): FileChange | undefined => {
  if (UNMERGED.has(xy)) return "conflicted";
  if (xy === "??" || xy[0] === "A" || xy[1] === "A") return "added";
  if (xy[0] === "R" || xy[1] === "R") return "renamed";
  if (xy[0] === "D" || xy[1] === "D") return "deleted";
  if (xy[0] === "M" || xy[1] === "M" || xy[0] === "T" || xy[1] === "T") return "modified";
  return undefined;
};

/**
 * A folder of files kept as a git repository: every save is a version, ids
 * follow files across renames, and a remote — when the backend supplies one —
 * is fetched, merged and pushed. Conflicts are left in the working copy for a
 * person to settle; nothing here ever forces.
 */
export class GitFileStore implements FileStore {
  readonly dir: string;
  private readonly g: GitFolder;
  private branch = "main";
  private watcher: fs.FSWatcher | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private quietUntil = 0;
  private syncing = false;
  private syncQueue: Promise<FilesStatus> | null = null;
  private lastSyncAt: number | null = null;
  private problem: { state: "offline" | "error"; detail: string } | null = null;
  private ensured = false;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: GitStoreOptions) {
    this.dir = opts.dir;
    this.g = new GitFolder(opts.git, opts.dir);
  }

  private git(args: string[], o: { ok?: boolean } = {}) {
    return this.opts.git(args, { cwd: this.dir, ...o });
  }

  /** Index-changing git calls run one at a time; an agent's write must not interleave with the watcher's save. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private abs(rel: string): string {
    return path.join(this.dir, ...rel.split("/"));
  }

  private quiet(ms = 1_500): void {
    this.quietUntil = Date.now() + ms;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  async open(): Promise<this> {
    fs.mkdirSync(this.dir, { recursive: true });
    const remote = this.opts.remote ? await this.opts.remote() : null;
    if (remote) this.branch = remote.branch || "main";
    if (!fs.existsSync(path.join(this.dir, ".git"))) await this.git(["init", "-q", "-b", this.branch]);
    await this.g.ensureIdentity();
    if (remote) {
      await this.g.setRemote(remote.url);
      // A fresh copy adopts what the remote has, so two machines never start unrelated histories over the same files.
      if (!(await this.head())) {
        const probe = await this.g.probe(this.branch);
        if (probe === "exists" && (await this.g.fetch(this.branch))) await this.git(["reset", "-q", "--hard", `origin/${this.branch}`], { ok: true });
        else if (probe === "offline") this.problem = { state: "offline", detail: "Could not reach the remote" };
      }
    } else await this.g.removeRemote();
    this.scaffold();
    if (!(await this.head())) await this.commitAll("Files store created");
    this.watch();
    return this;
  }

  private scaffold(): void {
    const write = (rel: string, body: string) => {
      const file = path.join(this.dir, rel);
      if (!fs.existsSync(file)) fs.writeFileSync(file, body, "utf8");
    };
    write(".gitattributes", ["# One line per file id; git keeps both sides of a clash and Tomrade takes the latest.", `${IDS_FILE} merge=union`, ""].join("\n"));
    write(".gitignore", [".DS_Store", "Thumbs.db", "*.tmp", ""].join("\n"));
    fs.mkdirSync(path.join(this.dir, IDS_DIR), { recursive: true });
    write(IDS_FILE, "");
  }

  close(): void {
    this.closed = true;
    this.unwatch();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }

  private watch(): void {
    if (this.opts.watch === false || this.watcher) return;
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, (_event, name) => {
        const rel = String(name ?? "").replace(/\\/g, "/");
        if (rel === ".git" || rel.startsWith(".git/") || rel.endsWith(".tmp")) return;
        if (Date.now() < this.quietUntil) return;
        this.scheduleSettle();
      });
      this.watcher.on("error", () => this.unwatch());
    } catch {
      // no recursive watch here; the periodic sync still saves outside edits
    }
  }

  private unwatch(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private scheduleSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.settle("Edited outside Tomrade")
        .then((saved) => saved && this.afterChange())
        .catch((error) => this.opts.warn(`save failed: ${message(error)}`));
    }, this.opts.settleMs ?? 1_500);
    this.settleTimer.unref?.();
  }

  private afterChange(): void {
    this.opts.onChange();
    if (this.opts.remote) this.schedulePush();
  }

  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.sync().catch((error) => this.opts.warn(`sync failed: ${message(error)}`));
    }, this.opts.pushMs ?? 3_000);
    this.pushTimer.unref?.();
  }

  // ── git plumbing ────────────────────────────────────────────────────────────

  async head(): Promise<string | null> {
    const r = await this.git(["rev-parse", "--verify", "-q", "HEAD"], { ok: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** The blob or tree a path names at a version, or null when it is not there. Same id, same content. */
  private async objectAt(rev: string, rel: string): Promise<string | null> {
    const r = await this.git(["rev-parse", "--verify", "-q", `${rev}:${rel}`], { ok: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  private merging(): boolean {
    return fs.existsSync(path.join(this.dir, ".git", "MERGE_HEAD"));
  }

  private readLedger(): Ledger {
    try {
      return parseLedger(fs.readFileSync(path.join(this.dir, IDS_FILE), "utf8"));
    } catch {
      return { byId: new Map(), byPath: new Map() };
    }
  }

  /** Every path with a pending change, keyed by path; renames are keyed by their new name. */
  private async statusMap(): Promise<Map<string, FileChange>> {
    const r = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { ok: true });
    const out = new Map<string, FileChange>();
    if (r.code !== 0) return out;
    const tokens = r.stdout.split("\0");
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.length < 4) continue;
      const xy = token.slice(0, 2);
      const p = token.slice(3);
      if (xy[0] === "R" || xy[0] === "C") i++;
      const change = changeOf(xy);
      if (change) out.set(p, change);
    }
    return out;
  }

  private async unmergedPaths(): Promise<string[]> {
    return [...(await this.statusMap())].filter(([, change]) => change === "conflicted").map(([p]) => p);
  }

  private async stagedChanges(): Promise<StagedChange[]> {
    const r = await this.git(["diff", "--cached", "--name-status", "-M", "-z"], { ok: true });
    const changes: StagedChange[] = [];
    if (r.code !== 0) {
      // No HEAD to diff against: everything in the index is new.
      const all = await this.git(["ls-files", "-z", "--cached"], { ok: true });
      for (const p of all.stdout.split("\0").filter(Boolean)) changes.push({ status: "A", path: p });
      return changes;
    }
    const tokens = r.stdout.split("\0");
    for (let i = 0; i < tokens.length; i++) {
      const status = tokens[i]!;
      if (!status) continue;
      const kind = status[0] as StagedChange["status"];
      if (kind === "R" || (kind as string) === "C") {
        changes.push({ status: "R", from: tokens[i + 1]!, path: tokens[i + 2]! });
        i += 2;
      } else {
        changes.push({ status: kind, path: tokens[i + 1]! });
        i += 1;
      }
    }
    return changes;
  }

  /**
   * Give every saved file an id, carry ids across renames, and close the ids of
   * deleted files. `carry` names the id a path had at the version being
   * restored, so a file that comes back is the same file, not a new one.
   */
  private async recordIds(changes: StagedChange[], carry: Map<string, string> = new Map()): Promise<void> {
    const ledger = this.readLedger();
    const at = Date.now();
    const lines: LedgerLine[] = [];
    const claimed = new Set<string>();
    const carriedIds = new Set(carry.values());
    for (const change of changes) {
      if (hidden(change.path) || change.path.endsWith(`/${KEEP}`) || change.path === KEEP) continue;
      if (change.status === "D") {
        const id = ledger.byPath.get(change.path);
        // An id about to be claimed again elsewhere — a move being put back — is not closed.
        if (id && !carriedIds.has(id)) lines.push({ id, path: null, at });
        continue;
      }
      const wanted = carry.get(change.path);
      if (wanted && ledger.byPath.get(change.path) === wanted) continue;
      if ((ledger.byPath.get(change.path) && !wanted) || claimed.has(change.path)) continue;
      const carried = change.status === "R" && change.from ? ledger.byPath.get(change.from) : undefined;
      lines.push({ id: wanted ?? carried ?? randomUUID(), path: change.path, at });
      claimed.add(change.path);
    }
    if (!lines.length) return;
    fs.appendFileSync(path.join(this.dir, IDS_FILE), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
    await this.git(["add", "--", IDS_FILE]);
  }

  /** Stage everything but files still in conflict, and commit when there is anything to commit. */
  private async commitAll(msg: string, carry?: Map<string, string>): Promise<boolean> {
    const pending = await this.statusMap();
    const conflicted = [...pending].filter(([, change]) => change === "conflicted").map(([p]) => p);
    if (conflicted.length) {
      // `add -A .` would mark the clashes resolved, markers and all, and an
      // exclude pathspec does not stop it: name the other paths one by one.
      const others = [...pending.keys()].filter((p) => !conflicted.includes(p));
      for (let i = 0; i < others.length; i += 200) await this.git(["add", "-A", "--", ...others.slice(i, i + 200)]);
      return false;
    }
    await this.git(["add", "-A"]);
    const changes = await this.stagedChanges();
    if (!changes.length && !this.merging()) return false;
    await this.recordIds(changes, carry);
    await this.g.ensureIdentity();
    this.quiet();
    await this.git(["commit", "-q", "--no-edit", "-m", msg]);
    return true;
  }

  private async lastVersionOf(rel: string): Promise<string | null> {
    const r = await this.git(["log", "-1", "--format=%H", "--", rel], { ok: true });
    const sha = r.stdout.trim();
    return r.code === 0 && sha ? sha : null;
  }

  private showBuffer(spec: string): Promise<Buffer | null> {
    return execBuffer(this.opts.gitBinary, ["show", spec], this.dir);
  }

  private contentOf(rel: string, bytes: Buffer, fileId: string | null, versionId: string | null): FileContent {
    const mime = mimeOf(rel);
    const base = { path: rel, name: rel.split("/").pop() ?? rel, fileId, versionId, size: bytes.length };
    if (isTextMime(mime) && !looksBinary(bytes)) {
      const truncated = bytes.length > TEXT_LIMIT;
      return { ...base, mime, encoding: "utf8", body: (truncated ? bytes.subarray(0, TEXT_LIMIT) : bytes).toString("utf8"), truncated };
    }
    const truncated = bytes.length > BINARY_LIMIT;
    return { ...base, mime: isTextMime(mime) ? "application/octet-stream" : mime, encoding: "base64", body: truncated ? "" : bytes.toString("base64"), truncated };
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  private entryOf(rel: string, isDir: boolean, stat: fs.Stats, ledger: Ledger, changes: Map<string, FileChange>): FileEntry {
    const prefix = `${rel}/`;
    const change = isDir ? ([...changes].some(([p, c]) => c === "conflicted" && p.startsWith(prefix)) ? "conflicted" : undefined) : changes.get(rel);
    return {
      path: rel,
      name: rel.split("/").pop() ?? rel,
      kind: isDir ? "dir" : "file",
      size: isDir ? 0 : stat.size,
      modifiedAt: Math.round(stat.mtimeMs),
      fileId: isDir ? null : (ledger.byPath.get(rel) ?? null),
      ...(change ? { change } : {})
    };
  }

  private async readDir(rel: string, ledger: Ledger, changes: Map<string, FileChange>): Promise<FileEntry[]> {
    const abs = rel ? this.abs(rel) : this.dir;
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith(".") || !(d.isFile() || d.isDirectory())) continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      try {
        entries.push(this.entryOf(p, d.isDirectory(), fs.statSync(this.abs(p)), ledger, changes));
      } catch {
        // gone between readdir and stat
      }
    }
    return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.kind === "dir" ? -1 : 1));
  }

  async list(dir = ""): Promise<FileEntry[]> {
    const rel = normalizeRel(dir);
    return this.readDir(rel, this.readLedger(), await this.statusMap());
  }

  async tree(): Promise<FileEntry[]> {
    const ledger = this.readLedger();
    const changes = await this.statusMap();
    const out: FileEntry[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await this.readDir(rel, ledger, changes)) {
        if (out.length >= TREE_LIMIT) return;
        out.push(entry);
        if (entry.kind === "dir") await walk(entry.path);
      }
    };
    await walk("");
    return out;
  }

  async read(p: string): Promise<FileContent | null> {
    const rel = normalizeRel(p);
    if (!rel) return null;
    let bytes: Buffer;
    try {
      if (!fs.statSync(this.abs(rel)).isFile()) return null;
      bytes = await fs.promises.readFile(this.abs(rel));
    } catch {
      return null;
    }
    const pending = (await this.statusMap()).get(rel);
    return this.contentOf(rel, bytes, this.readLedger().byPath.get(rel) ?? null, pending ? null : await this.lastVersionOf(rel));
  }

  private async commitOf(versionId: string): Promise<string | null> {
    if (!/^[0-9a-f]{40}$/i.test(versionId)) return null;
    const r = await this.git(["rev-parse", "--verify", "-q", `${versionId}^{commit}`], { ok: true });
    return r.code === 0 && r.stdout.trim() === versionId ? versionId : null;
  }

  private async pathAt(ref: FileReference): Promise<string | null> {
    const sha = await this.commitOf(ref.versionId);
    if (!sha) return null;
    const ledger = await this.g.show(sha, IDS_FILE);
    if (ledger === null) return null;
    const p = parseLedger(ledger).byId.get(ref.fileId)?.path;
    if (!p) return null;
    const exists = await this.git(["cat-file", "-e", `${sha}:${p}`], { ok: true });
    return exists.code === 0 ? p : null;
  }

  async readVersion(ref: FileReference): Promise<FileContent | null> {
    const p = await this.pathAt(ref);
    if (!p) return null;
    const bytes = await this.showBuffer(`${ref.versionId}:${p}`);
    return bytes ? this.contentOf(p, bytes, ref.fileId, ref.versionId) : null;
  }

  async resolveVersion(ref: FileReference): Promise<FileReference | null> {
    return (await this.pathAt(ref)) ? { fileId: ref.fileId, versionId: ref.versionId } : null;
  }

  async locate(fileId: string): Promise<string | null> {
    const p = this.readLedger().byId.get(fileId)?.path ?? null;
    return p && fs.existsSync(this.abs(p)) ? p : null;
  }

  async history(p: string, limit = 50): Promise<FileVersion[]> {
    const rel = normalizeRel(p);
    if (!rel) return [];
    const r = await this.git(["log", "--follow", `-n${limit}`, "--format=%x1e%H%x1f%at%x1f%an%x1f%s", "--name-only", "--", rel], { ok: true });
    if (r.code !== 0) return [];
    return r.stdout
      .split("\x1e")
      .filter((chunk) => chunk.trim())
      .map((chunk) => {
        const [head = "", ...rest] = chunk.split("\n");
        const [versionId = "", at = "0", author = "", msg = ""] = head.split("\x1f");
        const file = rest.map((line) => line.trim()).find(Boolean) ?? rel;
        return { versionId, at: Number(at) * 1000, author, message: msg, path: file };
      })
      .filter((v) => v.versionId);
  }

  // ── writes ──────────────────────────────────────────────────────────────────

  write(p: string, body: Buffer, opts: WriteOptions = {}): Promise<FileContent> {
    return this.locked(async () => {
      const rel = normalizeRel(p);
      if (!rel) throw new InvalidPathError(p);
      const abs = this.abs(rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new Error(`${rel} is a folder`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      this.quiet();
      const tmp = `${abs}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, abs);
      await this.commitAll(opts.message ?? `Saved ${rel}`);
      this.afterChange();
      const content = await this.read(rel);
      if (!content) throw new Error(`${rel} vanished while saving`);
      return content;
    });
  }

  mkdir(p: string): Promise<void> {
    return this.locked(async () => {
      const rel = normalizeRel(p);
      if (!rel) throw new InvalidPathError(p);
      const abs = this.abs(rel);
      if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) throw new Error(`${rel} is a file`);
      this.quiet();
      fs.mkdirSync(abs, { recursive: true });
      // git keeps no empty folders; a hidden marker makes this one travel.
      const keep = path.join(abs, KEEP);
      if (!fs.existsSync(keep)) fs.writeFileSync(keep, "", "utf8");
      if (await this.commitAll(`Created folder ${rel}`)) this.afterChange();
    });
  }

  move(from: string, to: string, opts: WriteOptions = {}): Promise<void> {
    return this.locked(async () => {
      const src = normalizeRel(from);
      const dst = normalizeRel(to);
      if (!src || !dst) throw new InvalidPathError(src ? to : from);
      if (dst === src || dst.startsWith(`${src}/`)) throw new Error(`Cannot move ${src} into itself`);
      if (!fs.existsSync(this.abs(src))) throw new Error(`${src} does not exist`);
      if (fs.existsSync(this.abs(dst))) throw new Error(`${dst} already exists`);
      this.quiet();
      fs.mkdirSync(path.dirname(this.abs(dst)), { recursive: true });
      fs.renameSync(this.abs(src), this.abs(dst));
      if (await this.commitAll(opts.message ?? `Moved ${src} to ${dst}`)) this.afterChange();
    });
  }

  copy(from: string, to: string, opts: WriteOptions = {}): Promise<void> {
    return this.locked(async () => {
      const src = normalizeRel(from);
      const dst = normalizeRel(to);
      if (!src || !dst) throw new InvalidPathError(src ? to : from);
      if (dst === src || dst.startsWith(`${src}/`)) throw new Error(`Cannot copy ${src} into itself`);
      if (!fs.existsSync(this.abs(src))) throw new Error(`${src} does not exist`);
      if (fs.existsSync(this.abs(dst))) throw new Error(`${dst} already exists`);
      this.quiet();
      fs.mkdirSync(path.dirname(this.abs(dst)), { recursive: true });
      fs.cpSync(this.abs(src), this.abs(dst), { recursive: true });
      if (await this.commitAll(opts.message ?? `Copied ${src} to ${dst}`)) this.afterChange();
    });
  }

  remove(p: string, opts: WriteOptions = {}): Promise<void> {
    return this.locked(async () => {
      const rel = normalizeRel(p);
      if (!rel) throw new InvalidPathError(p);
      if (!fs.existsSync(this.abs(rel))) return;
      this.quiet();
      fs.rmSync(this.abs(rel), { recursive: true, force: true });
      if (await this.commitAll(opts.message ?? `Deleted ${rel}`)) this.afterChange();
    });
  }

  /** git keeps no folders, so one that a removed path leaves empty would linger on disk as a phantom entry. */
  private pruneEmptyParents(rel: string): void {
    for (let dir = path.posix.dirname(rel); dir && dir !== "."; dir = path.posix.dirname(dir)) {
      const abs = this.abs(dir);
      try {
        if (fs.readdirSync(abs).length) return;
        fs.rmdirSync(abs);
      } catch {
        return;
      }
    }
  }

  settle(msg = "Saved"): Promise<boolean> {
    return this.locked(() => this.commitAll(msg));
  }

  /**
   * Undo and redo, one operation's paths at a time. Outside edits are saved
   * first so the comparison sees the working copy; a path that is not as
   * version `from` left it has moved on and refuses the whole restore. Ids
   * come back with their files: a path gets the id it had at `to`.
   */
  restore(paths: string[], from: string, to: string, message: string): Promise<string | null> {
    return this.locked(async () => {
      const rels = [...new Set(paths.map(normalizeRel).filter(Boolean))];
      if (!rels.length) return null;
      await this.commitAll("Edited outside Tomrade");
      if ((await this.unmergedPaths()).length) throw new Error("Settle the files in conflict first");
      for (const rel of rels) {
        if ((await this.objectAt("HEAD", rel)) !== (await this.objectAt(from, rel))) throw new FileMovedOnError(rel);
      }
      const ledgerAtTo = await this.g.show(to, IDS_FILE);
      const wanted = ledgerAtTo === null ? new Map<string, string>() : parseLedger(ledgerAtTo).byPath;
      const carry = new Map<string, string>();
      this.quiet(5_000);
      for (const rel of rels) {
        // The path becomes exactly what it was at `to`: a folder is emptied first so nothing added since lingers.
        fs.rmSync(this.abs(rel), { recursive: true, force: true });
        if ((await this.objectAt(to, rel)) === null) {
          this.pruneEmptyParents(rel);
          continue;
        }
        await this.git(["checkout", to, "--", rel]);
        for (const [p, id] of wanted) if (p === rel || p.startsWith(`${rel}/`)) carry.set(p, id);
      }
      if (!(await this.commitAll(message, carry))) return null;
      this.afterChange();
      return this.head();
    });
  }

  // ── sync ────────────────────────────────────────────────────────────────────

  async status(): Promise<FilesStatus> {
    const conflicts = this.closed ? 0 : (await this.unmergedPaths()).length;
    const head = this.closed ? null : await this.head();
    const base: Omit<FilesStatus, "state"> = { location: this.opts.location ?? this.dir, lastSyncAt: this.lastSyncAt, conflicts, ahead: 0, behind: 0, head };
    if (this.closed) return { ...base, state: "unavailable" };
    if (this.syncing) return { ...base, state: "syncing" };
    if (conflicts) return { ...base, state: "conflicted", detail: conflicts === 1 ? "1 file needs a decision" : `${conflicts} files need a decision` };
    if (!this.opts.remote) return { ...base, state: "local" };
    const ab = await this.g.aheadBehind(this.branch);
    if (this.problem) return { ...base, ...(ab ?? {}), state: this.problem.state, detail: this.problem.detail };
    if (!ab) return { ...base, state: "ahead", detail: "Not pushed yet" };
    const state = ab.ahead && ab.behind ? "diverged" : ab.ahead ? "ahead" : ab.behind ? "behind" : "synced";
    return { ...base, ...ab, state };
  }

  sync(): Promise<FilesStatus> {
    if (this.syncQueue) return this.syncQueue;
    this.syncQueue = this.locked(async () => {
      if (!this.closed) await this.doSync();
      return this.status();
    }).finally(() => {
      this.syncQueue = null;
    });
    return this.syncQueue;
  }

  /** Save, then — with a remote — probe, fetch, merge, push. Leaves `problem` for `status()` to report. */
  private async doSync(): Promise<void> {
    this.syncing = true;
    this.opts.onChange();
    try {
      await this.commitAll("Saved");
      if (!this.opts.remote) return;
      const remote = await this.opts.remote();
      this.branch = remote.branch || "main";
      await this.g.setRemote(remote.url);
      if (this.opts.ensureRemote && !this.ensured) {
        await this.opts.ensureRemote();
        this.ensured = true;
      }
      const probe = await this.g.probe(this.branch);
      if (probe === "offline") {
        this.problem = { state: "offline", detail: "Could not reach the remote" };
        return;
      }
      if (probe === "absent") {
        this.problem = (await this.g.push(this.branch)) ? null : { state: "error", detail: "The remote refused the push" };
        if (!this.problem) this.lastSyncAt = Date.now();
        return;
      }
      if (!(await this.g.fetch(this.branch))) {
        this.problem = { state: "offline", detail: "Could not fetch from the remote" };
        return;
      }
      // A merge still waiting on a person is not retried over.
      if ((await this.unmergedPaths()).length) return;
      const before = await this.g.aheadBehind(this.branch);
      if (before && before.behind > 0) {
        this.quiet(5_000);
        const merged = await this.git(["merge", "-q", "--no-edit", "--allow-unrelated-histories", `origin/${this.branch}`], { ok: true });
        if (merged.code !== 0) {
          if ((await this.unmergedPaths()).length) {
            this.problem = null;
            return;
          }
          await this.git(["merge", "--abort"], { ok: true });
          this.problem = { state: "error", detail: `Merge failed: ${merged.stderr?.trim().split("\n").pop() ?? "unknown"}` };
          return;
        }
      }
      const after = await this.g.aheadBehind(this.branch);
      if (after && after.ahead > 0 && !(await this.g.push(this.branch))) {
        this.problem = { state: "error", detail: "The remote moved on; will retry" };
        return;
      }
      this.problem = null;
      this.lastSyncAt = Date.now();
    } catch (error) {
      this.problem = { state: "error", detail: message(error) };
    } finally {
      this.syncing = false;
      this.opts.onChange();
    }
  }

  // ── conflicts ───────────────────────────────────────────────────────────────

  private async stage(n: 2 | 3, rel: string): Promise<Buffer | null> {
    const exists = await this.git(["cat-file", "-e", `:${n}:${rel}`], { ok: true });
    return exists.code === 0 ? this.showBuffer(`:${n}:${rel}`) : null;
  }

  async conflicts(): Promise<FileConflict[]> {
    const r = await this.git(["status", "--porcelain=v1", "-z"], { ok: true });
    if (r.code !== 0) return [];
    const ledger = this.readLedger();
    const out: FileConflict[] = [];
    const tokens = r.stdout.split("\0");
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.length < 4) continue;
      const xy = token.slice(0, 2);
      if (xy[0] === "R" || xy[0] === "C") i++;
      if (!UNMERGED.has(xy) || xy === "DD") continue;
      const rel = token.slice(3);
      const ours = await this.stage(2, rel);
      const theirs = await this.stage(3, rel);
      const binary = (ours ? looksBinary(ours) : false) || (theirs ? looksBinary(theirs) : false) || !isTextMime(mimeOf(rel));
      const kind: FileConflict["kind"] = xy === "AA" ? "add-add" : xy === "UD" || xy === "AU" ? "modify-delete" : xy === "DU" || xy === "UA" ? "delete-modify" : "content";
      out.push({ path: rel, fileId: ledger.byPath.get(rel) ?? null, kind, binary, ours: ours && !binary ? ours.toString("utf8") : null, theirs: theirs && !binary ? theirs.toString("utf8") : null });
    }
    return out;
  }

  resolve(p: string, choice: ConflictChoice): Promise<void> {
    return this.locked(async () => {
      const rel = normalizeRel(p);
      if (!rel) throw new InvalidPathError(p);
      if (!(await this.unmergedPaths()).includes(rel)) throw new Error(`${rel} is not in conflict`);
      const ours = await this.stage(2, rel);
      const theirs = await this.stage(3, rel);
      this.quiet(5_000);
      const keep = async (bytes: Buffer | null, at: string) => {
        if (bytes) {
          fs.mkdirSync(path.dirname(this.abs(at)), { recursive: true });
          fs.writeFileSync(this.abs(at), bytes);
          await this.git(["add", "--", at]);
        } else {
          fs.rmSync(this.abs(at), { force: true });
          await this.git(["rm", "-q", "--cached", "--ignore-unmatch", "--", at], { ok: true });
        }
      };
      if (choice === "ours") await keep(ours, rel);
      else if (choice === "theirs") await keep(theirs, rel);
      else if (ours && theirs) {
        await keep(ours, rel);
        await keep(theirs, this.sibling(rel, "theirs"));
      } else await keep(ours ?? theirs, rel);
      if (!(await this.unmergedPaths()).length && this.merging()) await this.commitAll("Merged remote changes");
      this.afterChange();
    });
  }

  /** "notes (theirs).md", or "notes (theirs 2).md" when that is taken too. */
  private sibling(rel: string, tag: string): string {
    const ext = path.posix.extname(rel);
    const stem = rel.slice(0, rel.length - ext.length);
    for (let n = 1; ; n++) {
      const candidate = `${stem} (${tag}${n > 1 ? ` ${n}` : ""})${ext}`;
      if (!fs.existsSync(this.abs(candidate))) return candidate;
    }
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
