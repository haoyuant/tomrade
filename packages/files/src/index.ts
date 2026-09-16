// cordis FIRST, and not for show: a `declare module "cordis"` in a package
// loaded before cordis itself declares a NEW module instead of augmenting it.
import type {} from "cordis";
export { Files, FilesConfig, LOCAL_BACKEND, folderName } from "./service.js";
export { GitFileStore, IDS_DIR, IDS_FILE, normalizeRel, parseLedger, type GitRemoteTarget, type GitStoreOptions, type Ledger } from "./git-store.js";
export { createGitBackend, type GitBackendOptions } from "./git-backend.js";
export { isTextMime, looksBinary, mimeOf } from "./mime.js";
export { MIGRATIONS, OpsStore, RemoteStore, TABLES, type FileOpKind, type FileOpRow, type RemoteRow } from "./store.js";
export {
  FileMovedOnError,
  FilesUnavailableError,
  InvalidPathError,
  UnknownBackendError,
  type ConflictChoice,
  type ConnectionState,
  type FileChange,
  type FileConflict,
  type FileContent,
  type FileEntry,
  type FileStore,
  type FileVersion,
  type FilesBackend,
  type FilesBackendView,
  type FilesConnection,
  type FilesInfo,
  type FilesStatus,
  type FilesSyncState,
  type FilesSyncPolicy,
  type FileSyncPreference,
  type SyncMode,
  type OpenStoreOptions,
  type StoreEnv,
  type WriteOptions
} from "./types.js";
export type {} from "./channels.js";
export { Files as default } from "./service.js";
