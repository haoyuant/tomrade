import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GIT_ENV, GitFolder, type Git } from "@tomrade/storage";
import type { FilesAgentPolicy, FilesSyncPolicy, ListMode, PathPolicy, PathPreference, SyncMode } from "./types.js";

/** A version made portable: the pair a ticket pins, and where the file was then. Its bytes travel beside the record. */
export interface VersionRecord {
  fileId: string;
  versionId: string;
  path: string;
}

export interface SyncConflict {
  ours: string | null;
  theirs: string | null;
  base: string | null;
}

/** Machine-local: what the last successful exchange with one remote target left, keyed by git blob ids. */
export interface SyncState {
  v: 2;
  baseline: Record<string, string>;
  conflicts: Record<string, SyncConflict>;
  policy?: FilesSyncPolicy;
  /** Baseline for the listing dimension; absent on a state written before it existed. */
  agents?: FilesAgentPolicy;
  head?: string;
}

export const emptySyncState = (): SyncState => ({ v: 2, baseline: {}, conflicts: {} });

/** The id git gives these bytes, so what the remote already holds is recognised without asking git. */
export const blobId = (bytes: Buffer): string => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export const contains = (parent: string, child: string): boolean => !parent || parent === child || child.startsWith(`${parent}/`);

/** One resolver for every path dimension: sharing, listing, and whatever comes next. */
export function policyAt<M extends string>(policy: PathPolicy<M>, rel: string, directory = false): PathPreference<M> {
  const rule = policy.rules.filter((r) => contains(r.path, rel)).sort((a, b) => b.path.length - a.path.length)[0];
  const mode = rule?.mode ?? policy.default;
  return {
    mode,
    source: rule ? (rule.path === rel ? "explicit" as const : "inherited" as const) : "default" as const,
    sourcePath: rule?.path ?? null,
    mixed: directory && policy.rules.some((r) => contains(rel, r.path) && r.mode !== mode)
  };
}

export const DEFAULT_SYNC_POLICY: FilesSyncPolicy = { default: "shared", rules: [] };
/** Files are a knowledge source by default; the person takes individual paths back out of the index. */
export const DEFAULT_AGENT_POLICY: FilesAgentPolicy = { default: "listed", rules: [] };

export const SYNC_MODES: SyncMode[] = ["shared", "local"];
export const LIST_MODES: ListMode[] = ["listed", "unlisted"];

/**
 * What `policy.json` holds, locally and on the remote. Version 1 was the sync
 * policy alone, at the top level; it is read as such and rewritten as v2.
 */
export interface StoredPolicy {
  v: 2;
  sync: FilesSyncPolicy;
  agents: FilesAgentPolicy;
}

export const emptyStoredPolicy = (): StoredPolicy => ({ v: 2, sync: { ...DEFAULT_SYNC_POLICY }, agents: { ...DEFAULT_AGENT_POLICY } });

/** Accepts either version and never throws: an unreadable policy is no policy, not a broken store. */
export function readStoredPolicy(value: unknown): StoredPolicy | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.v === 2) {
    return {
      v: 2,
      sync: validPolicy(raw.sync, SYNC_MODES) ?? { ...DEFAULT_SYNC_POLICY },
      agents: validPolicy(raw.agents, LIST_MODES) ?? { ...DEFAULT_AGENT_POLICY }
    };
  }
  const legacy = validPolicy(raw, SYNC_MODES);
  return legacy ? { v: 2, sync: legacy, agents: { ...DEFAULT_AGENT_POLICY } } : null;
}

/** Null when the shape is not a policy over these modes. Rule paths must already be normalized. */
export function validPolicy<M extends string>(value: unknown, modes: M[]): PathPolicy<M> | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { default?: unknown; rules?: unknown };
  if (!modes.includes(raw.default as M) || !Array.isArray(raw.rules)) return null;
  const rules: Array<{ path: string; mode: M }> = [];
  for (const rule of raw.rules) {
    if (!rule || typeof rule !== "object") return null;
    const { path: p, mode } = rule as { path?: unknown; mode?: unknown };
    if (typeof p !== "string" || !p || !modes.includes(mode as M)) return null;
    rules.push({ path: p, mode: mode as M });
  }
  return { default: raw.default as M, rules };
}

/** Atomic machine-local metadata, deliberately outside the versioned tree. */
export function saveJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}

export function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export function remoteDirectory(input = ""): string {
  const rel = input.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!rel) return "";
  if (rel.startsWith("/") || rel.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || p.includes("\0")) || /^[A-Za-z]:/.test(rel)) throw new Error("Invalid remote directory");
  return rel;
}

interface IndexEntry {
  mode: string;
  oid: string;
}

/**
 * A disposable git index over the remote's tip, never connected to the local
 * history. No checkout is made, so remote symlinks, attributes and hooks
 * cannot touch the filesystem; read-tree keeps every path outside the scope
 * exactly, and update-index changes only what is ours. Only the tip is
 * fetched: a monorepo's history stays where it is.
 */
export class GitProjection {
  readonly dir: string;
  readonly folder: GitFolder;
  readonly prefix: string;
  readonly key: string;
  private entries = new Map<string, IndexEntry>();

  constructor(private git: Git, private binary: string, local: string, readonly target: { url: string; branch: string; directory?: string }) {
    const directory = remoteDirectory(target.directory);
    this.prefix = directory ? `${directory}/` : "";
    this.key = createHash("sha256").update(JSON.stringify([target.url, target.branch, directory])).digest("hex");
    this.dir = path.join(local, ".git", "files-sync", "transport", this.key);
    this.folder = new GitFolder(git, this.dir);
  }

  private run(args: string[], ok = false) {
    return this.git(args, { cwd: this.dir, ok });
  }

  /** Bring the index to the remote's tip. False when the remote cannot be reached. */
  async fetch(): Promise<boolean> {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(path.join(this.dir, ".git"))) await this.run(["init", "-q", "-b", this.target.branch]);
    await this.folder.ensureIdentity();
    await this.folder.setRemote(this.target.url);
    const probe = await this.folder.probe(this.target.branch);
    if (probe === "offline") return false;
    if (probe === "exists") {
      if ((await this.run(["fetch", "-q", "--depth", "1", "origin", this.target.branch], true)).code !== 0) return false;
      await this.run(["update-ref", "HEAD", `refs/remotes/origin/${this.target.branch}`]);
      await this.run(["read-tree", "HEAD"]);
    } else {
      await this.run(["update-ref", "-d", "HEAD"], true);
      await this.run(["read-tree", "--empty"]);
    }
    this.entries.clear();
    const listing = await this.run(["ls-files", "--stage", "-z"]);
    for (const item of listing.stdout.split("\0").filter(Boolean)) {
      const tab = item.indexOf("\t");
      const [mode, oid] = item.slice(0, tab).split(" ");
      this.entries.set(item.slice(tab + 1), { mode: mode!, oid: oid! });
    }
    for (const [p, e] of this.entries) {
      if ((this.prefix && this.prefix.startsWith(`${p}/`)) || (p.startsWith(this.prefix) && e.mode !== "100644" && e.mode !== "100755")) throw new Error(`Remote scope contains unsupported entry: ${p}`);
    }
    return true;
  }

  /** Every path in scope, relative to it, with what git has there. */
  listing(): Map<string, IndexEntry> {
    const out = new Map<string, IndexEntry>();
    for (const [p, e] of this.entries) if (p.startsWith(this.prefix)) out.set(p.slice(this.prefix.length), e);
    return out;
  }

  paths(): string[] {
    return [...this.listing().keys()];
  }

  has(rel: string): boolean {
    return this.entries.has(this.prefix + rel);
  }

  oid(rel: string): string | undefined {
    return this.entries.get(this.prefix + rel)?.oid;
  }

  async read(rel: string): Promise<Buffer | null> {
    const entry = this.entries.get(this.prefix + rel);
    if (!entry) return null;
    return new Promise((resolve, reject) =>
      execFile(this.binary, ["cat-file", "blob", entry.oid], { cwd: this.dir, encoding: "buffer", maxBuffer: 128 * 1024 * 1024, env: { ...process.env, ...GIT_ENV } }, (error, stdout) => (error ? reject(error) : resolve(stdout as Buffer)))
    );
  }

  /** Put bytes at a path, or remove it with null. Bytes the remote already has there cost nothing. */
  async write(rel: string, bytes: Buffer | null): Promise<void> {
    const full = this.prefix + rel;
    const current = this.entries.get(full);
    if (bytes === null) {
      if (!current) return;
      await this.run(["update-index", "--force-remove", "--", full]);
      this.entries.delete(full);
      return;
    }
    const oid = blobId(bytes);
    if (current?.oid === oid) return;
    const temporary = path.join(this.dir, ".git", "projection-blob");
    fs.writeFileSync(temporary, bytes);
    const written = (await this.run(["hash-object", "-w", "--", temporary])).stdout.trim();
    const mode = current?.mode ?? "100644";
    await this.run(["update-index", "--add", "--cacheinfo", mode, written, full]);
    this.entries.set(full, { mode, oid: written });
  }

  /** Commit what changed on top of the fetched tip and push, never forced. */
  async push(): Promise<boolean> {
    const changed = await this.run(["diff", "--cached", "--quiet"], true);
    const head = await this.run(["rev-parse", "--verify", "HEAD"], true);
    if (changed.code !== 0 || head.code !== 0) await this.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "Synchronize shared files"]);
    return this.folder.push(this.target.branch);
  }
}
