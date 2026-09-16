import type { z } from "zod";
import type { FileReference } from "@tomrade/domain";

/** Where a project's files stand against what they are shared through. `local` means nothing beyond this machine to be in step with. */
export type FilesSyncState = "local" | "synced" | "ahead" | "behind" | "diverged" | "conflicted" | "syncing" | "offline" | "error" | "unavailable";

export interface FilesStatus {
  state: FilesSyncState;
  /** Non-secret: "github.com/acme/docs · main", or the folder. */
  location: string | null;
  detail?: string;
  lastSyncAt: number | null;
  conflicts: number;
  ahead: number;
  behind: number;
  /** The latest version, null until something has been saved. */
  head: string | null;
}

export type FileChange = "added" | "modified" | "deleted" | "renamed" | "conflicted";

export interface FileEntry {
  /** Relative to the store root, forward slashes, no leading slash. */
  path: string;
  name: string;
  kind: "file" | "dir";
  size: number;
  modifiedAt: number;
  /** Stable across renames; null for folders and for files not yet saved as a version. */
  fileId: string | null;
  /** Pending against the latest version, when anything is. */
  change?: FileChange;
}

export interface FileContent {
  path: string;
  name: string;
  fileId: string | null;
  /** The version this content is from; null for a working copy that is not saved yet. */
  versionId: string | null;
  mime: string;
  size: number;
  encoding: "utf8" | "base64";
  body: string;
  /** Large bodies are cut short; `size` says how much there is. */
  truncated: boolean;
}

export interface FileVersion {
  versionId: string;
  at: number;
  author: string;
  message: string;
  /** Where the file lived at this version. */
  path: string;
}

export interface FileConflict {
  path: string;
  fileId: string | null;
  /** Both sides changed it; both added it; one side deleted what the other edited. */
  kind: "content" | "add-add" | "modify-delete" | "delete-modify";
  binary: boolean;
  /** Each side's text; null where that side has no file, or it is binary. */
  ours: string | null;
  theirs: string | null;
}

export type ConflictChoice = "ours" | "theirs" | "both";

export interface WriteOptions {
  /** The version's message; a default names the path. */
  message?: string;
}

/**
 * The store contract every backend fulfils. Paths are relative and
 * forward-slashed; a `{ fileId, versionId }` pair reads the same bytes for ever.
 */
export interface FileStore {
  readonly dir: string;
  /** One level of a folder; the root when `dir` is omitted. */
  list(dir?: string): Promise<FileEntry[]>;
  /** Every entry, depth first, folders before files. */
  tree(): Promise<FileEntry[]>;
  read(path: string): Promise<FileContent | null>;
  readVersion(ref: FileReference): Promise<FileContent | null>;
  /** The exact pair when that version holds that file, else null. */
  resolveVersion(ref: FileReference): Promise<FileReference | null>;
  /** Where a file is now, or null when it is gone. */
  locate(fileId: string): Promise<string | null>;
  history(path: string, limit?: number): Promise<FileVersion[]>;
  write(path: string, body: Buffer, opts?: WriteOptions): Promise<FileContent>;
  mkdir(path: string): Promise<void>;
  move(from: string, to: string, opts?: WriteOptions): Promise<void>;
  /** Copy a file or folder to a new path, minted as a fresh id — never the source's. Refuses an existing destination. */
  copy(from: string, to: string, opts?: WriteOptions): Promise<void>;
  remove(path: string, opts?: WriteOptions): Promise<void>;
  /** Save whatever changed outside the store — an editor, Finder — as a version. True when something was. */
  settle(message?: string): Promise<boolean>;
  status(): Promise<FilesStatus>;
  /** Save, take the remote's changes, push. Conflicts are left for `conflicts()`/`resolve()`. */
  sync(): Promise<FilesStatus>;
  conflicts(): Promise<FileConflict[]>;
  resolve(path: string, choice: ConflictChoice): Promise<void>;
  close(): void;
}

export interface ConnectionState {
  connected: boolean;
  label?: string;
  detail?: string;
}

/** An account behind a backend; the secret stays in the backend's own settings section. */
export interface FilesConnection {
  prompt: { label: string; help?: string; url?: string };
  status(): Promise<ConnectionState>;
  connect(secret: string): Promise<ConnectionState>;
  disconnect(): Promise<void>;
}

export interface OpenStoreOptions<C> {
  projectId: string;
  /** This machine's copy, beside the project's own folder. */
  dir: string;
  /** The remote the project shares, or null for a store that lives here only. */
  remote: C | null;
  /** Non-fatal trouble goes here, prefixed by the caller. */
  warn(message: string): void;
  /** The store's files changed underneath the app: a sync, an outside edit. */
  onChange(): void;
  /** What the service was configured with; a backend takes what applies to it. */
  env: StoreEnv;
}

export interface StoreEnv {
  gitBinary: string;
  watch: boolean;
  settleMs: number;
  pushMs: number;
}

/**
 * A backend is a way of keeping a project's files: versions on this machine
 * and, when configured, a remote every machine on the project shares. Its
 * config is per project and travels with it, so it must hold no secret.
 */
export interface FilesBackend<C = unknown> {
  /** Stable across releases: the project stores this id, not a package name. */
  id: string;
  title: string;
  description?: string;
  configSchema: z.ZodType<C>;
  defaults: C;
  /** The settings section holding this backend's credentials, if it needs any. */
  settingsSection?: string;
  connection?: FilesConnection;
  open(opts: OpenStoreOptions<C>): Promise<FileStore> | FileStore;
  /** Candidates the user picks from, so nothing has to be typed by hand. */
  browse?(): Promise<{ label: string; config: C }[]>;
  /** A config for a remote that does not exist yet, from a name alone. */
  draft?(name: string): Promise<C> | C;
  /** One non-secret line naming the remote, for status. */
  describe?(config: C): string;
}

/** What the renderer gets: the schema as JSON Schema, so a form is drawn without the backend's code. */
export interface FilesBackendView {
  id: string;
  title: string;
  description?: string;
  schema: Record<string, unknown>;
  defaults: unknown;
  settingsSection?: string;
  browsable: boolean;
  creatable: boolean;
  connection?: FilesConnection["prompt"];
}

export interface FilesInfo {
  projectId: string;
  /** This machine's copy, or null until the project has a folder. */
  dir: string | null;
  remote: { backend: string; config: Record<string, unknown> } | null;
  status: FilesStatus;
}

export class UnknownBackendError extends Error {
  constructor(public readonly backendId: string) {
    super(`Unknown files backend: ${backendId}`);
    this.name = "UnknownBackendError";
  }
}

export class InvalidPathError extends Error {
  constructor(public readonly path: string) {
    super(`Not a file path inside the store: ${JSON.stringify(path)}`);
    this.name = "InvalidPathError";
  }
}

export class FilesUnavailableError extends Error {
  constructor(public readonly projectId: string, reason: string) {
    super(`Files are not available for project ${projectId}: ${reason}`);
    this.name = "FilesUnavailableError";
  }
}
