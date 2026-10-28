import type { z } from "zod";
import type { FileReference } from "@tomradex/domain";
import type { ConnectionState, ProviderConnection as FilesConnection } from "@tomradex/storage";

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
  /** True for a store that keeps no versions — no git on this machine: no history, undo, ticket pins or sharing. */
  versionless?: boolean;
}

export type FileChange = "added" | "modified" | "deleted" | "renamed" | "conflicted";

/** Sharing intent, independent of whether a remote is connected or reachable. */
export type SyncMode = "shared" | "local";

/** Whether Tomrade mentions a path to agents unasked. Never a permission: an unlisted path still reads and writes. */
export type ListMode = "listed" | "unlisted";

/** Closest ancestor wins; an exact rule overrides the parent. Paths are Files-relative. */
export interface PathPolicy<M extends string> {
  default: M;
  rules: Array<{ path: string; mode: M }>;
}

export interface PathPreference<M extends string> {
  mode: M;
  source: "explicit" | "inherited" | "default";
  sourcePath: string | null;
  /** A folder contains descendants with a different effective setting. */
  mixed: boolean;
}

export type FilesSyncPolicy = PathPolicy<SyncMode>;
export type FileSyncPreference = PathPreference<SyncMode>;
/**
 * What the agent index and the browsing tools mention on their own. It governs
 * disclosure, not access: reads and writes by path are never refused, and a
 * path the person names in conversation or pins to a ticket always works.
 */
export type FilesAgentPolicy = PathPolicy<ListMode>;
export type FileListPreference = PathPreference<ListMode>;

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
  /** Absent for backends that do not implement selective sharing. */
  sync?: FileSyncPreference;
  /** Absent for backends that do not implement the agent index. */
  listing?: FileListPreference;
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
  /** sha-256 of the whole file, as `WriteOptions.expect` compares it. Absent where a backend cannot vouch for the bytes. */
  hash?: string;
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
  /**
   * The `hash` the writer last read: a file that no longer has it is left
   * alone and the write throws `FileChangedError`. `null` means the path must
   * be free. Omitted, the write lands whatever is there.
   */
  expect?: string | null;
}

/** One file of a `writeMany`: every `expect` is checked before any byte lands. */
export interface WriteEntry {
  path: string;
  body: Buffer;
  expect?: string | null;
}

/** A file a ticket body is about to link to, as the editor holds it until the body is saved. */
export interface AttachmentInput {
  name: string;
  base64: string;
}

/** What a guarded save got: the new version, or what is there now instead. */
export type SaveResult = { ok: true; content: FileContent } | { ok: false; current: FileContent | null };

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
  /** Several files as one version; refused whole when any `expect` fails. */
  writeMany?(entries: WriteEntry[], opts?: { message?: string }): Promise<void>;
  mkdir(path: string): Promise<void>;
  move(from: string, to: string, opts?: WriteOptions): Promise<void>;
  /** Copy a file or folder to a new path, minted as a fresh id — never the source's. Refuses an existing destination. */
  copy(from: string, to: string, opts?: WriteOptions): Promise<void>;
  remove(path: string, opts?: WriteOptions): Promise<void>;
  /** Save whatever changed outside the store — an editor, Finder — as a version. True when something was. */
  settle(message?: string): Promise<boolean>;
  /**
   * The current version, or null before the first save. With `restore`, what
   * makes an operation undoable: the service notes the version before and
   * after it, and puts the touched paths back later.
   */
  head?(): Promise<string | null>;
  /**
   * Put `paths` back as they were at version `to`, as a new version. Refused
   * with `FileMovedOnError` when any of them differs from how version `from`
   * left it — someone changed it since, and that change is not ours to lose.
   * Returns the new version, or null when nothing needed to change.
   */
  restore?(paths: string[], from: string, to: string, message: string): Promise<string | null>;
  status(): Promise<FilesStatus>;
  /** Local-only files retain the same local version and undo guarantees. */
  syncPolicy?(): Promise<FilesSyncPolicy>;
  /** Atomic batch. Empty path changes the root default; inherit removes an exception.
   * Changing a folder rule preserves explicit descendant exceptions.
   * This controls future sharing, not erasure of already published history.
   */
  setSyncRules?(paths: string[], mode: SyncMode | "inherit"): Promise<FilesSyncPolicy>;
  /** Which paths Tomrade names to agents unasked. Disclosure only; reads are never refused. */
  agentPolicy?(): Promise<FilesAgentPolicy>;
  /** Atomic batch, same shape as `setSyncRules`: empty path sets the root default, `inherit` drops an exception. */
  setAgentRules?(paths: string[], mode: ListMode | "inherit"): Promise<FilesAgentPolicy>;
  /** Literal or regular-expression search over the working copy. Absent when a backend cannot search. */
  search?(input: FileSearchInput): Promise<FileSearchResult>;
  /** Save, take the remote's changes, push. Conflicts are left for `conflicts()`/`resolve()`. `quiet`: the periodic sweep, which tells only of what changed. */
  sync(opts?: { quiet?: boolean }): Promise<FilesStatus>;
  /** Whether outside edits are being watched, so a sweep is not what saves them. */
  watching?(): boolean;
  conflicts(): Promise<FileConflict[]>;
  resolve(path: string, choice: ConflictChoice): Promise<void>;
  close(): void;
}

export interface FileSearchInput {
  /** Searched independently; each hit says which one it answered. */
  queries: string[];
  /** Limit to this folder (or file) of the store. */
  path?: string;
  /** Glob over the path's last segment, e.g. `*.md`. */
  glob?: string;
  /** Hits per query, across all files. */
  max: number;
  /** Treat each query as a regular expression instead of a literal string. */
  regex?: boolean;
  caseSensitive?: boolean;
}

export interface FileSearchHit {
  query: string;
  path: string;
  line: number;
  /** The matching line, clipped. */
  text: string;
}

export interface FileSearchResult {
  hits: FileSearchHit[];
  /** Queries whose hits were cut off at `max`. */
  truncated: string[];
}

/** An account behind a backend, the same shape as a storage provider's; the secret stays in the backend's own settings section. */
export type { ConnectionState, ProviderConnection as FilesConnection } from "@tomradex/storage";

export interface OpenStoreOptions<C> {
  projectId: string;
  /** This machine's copy, beside the project's own folder. */
  dir: string;
  /** The remote the project shares, or null for a store that lives here only. */
  remote: C | null;
  /** Non-fatal trouble goes here, prefixed by the caller. */
  warn(message: string): void;
  /** The store's files changed underneath the app: a sync, an outside edit. `paths` when the store knows which. */
  onChange(paths?: string[]): void;
  /** What the service was configured with; a backend takes what applies to it. */
  env: StoreEnv;
  /** The project's own repository, asked on every sync; a backend sharing through git keeps out of its root and the store's folder. */
  projectRepository?(): Promise<ProjectRepository | null>;
}

/** The repository Tomrade drives for the project itself, with `.tomrade/` at its root. */
export interface ProjectRepository {
  url: string;
  branch: string;
  /** The top-level folder its checkout keeps the files store in. */
  folder: string;
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
  /** The git repository a config shares through, so a remote that cannot work is refused before it is saved. */
  repository?(config: C): Promise<{ url: string; branch: string; directory?: string }> | { url: string; branch: string; directory?: string };
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

/** A path has changed since the operation being undone or redone; the restore is refused, not forced. */
export class FileMovedOnError extends Error {
  constructor(public readonly path: string) {
    super(`${path} has changed since — undo it by hand if you still want to`);
    this.name = "FileMovedOnError";
  }
}

/** A guarded write found other bytes than the writer read: somebody saved in between. */
export class FileChangedError extends Error {
  constructor(public readonly path: string) {
    super(`${path} changed since it was read`);
    this.name = "FileChangedError";
  }
}

/**
 * The project's own checkout pulls whatever Files publishes there: at the root
 * Files would take `.tomrade/`, and in the store's own folder two repositories
 * would commit the same files, local-only ones included.
 */
export class ProjectRepositoryError extends Error {
  constructor(public readonly folder: string) {
    super(`This repository holds the project itself: share Files through a folder in it other than ${folder}/, such as project-files, or through another branch or repository`);
    this.name = "ProjectRepositoryError";
  }
}

export class FilesUnavailableError extends Error {
  constructor(public readonly projectId: string, reason: string) {
    super(`Files are not available for project ${projectId}: ${reason}`);
    this.name = "FilesUnavailableError";
  }
}
