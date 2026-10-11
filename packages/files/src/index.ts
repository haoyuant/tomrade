// cordis FIRST, and not for show: a `declare module "cordis"` in a package
// loaded before cordis itself declares a NEW module instead of augmenting it.
import type {} from "cordis";
export { Files, FilesConfig, LOCAL_BACKEND, folderName } from "./service.js";
export { BINARY_LIMIT, GitFileStore, IDS_DIR, IDS_FILE, normalizeRel, parseLedger, type GitRemoteTarget, type GitStoreOptions, type Ledger } from "./git-store.js";
export { createGitBackend, type GitBackendOptions } from "./git-backend.js";
export { buildAgentIndex, estimateTokens, formatSize, shortDate, type AgentIndex, type AgentIndexInput } from "./agent-index.js";
export { DEFAULT_AGENT_POLICY, DEFAULT_SYNC_POLICY, listingAt, policyAt, readStoredPolicy, validPolicy, type StoredPolicy } from "./git-sync.js";
export { isTextMime, looksBinary, mimeOf } from "./mime.js";
export { MIGRATIONS, OpsStore, RemoteStore, TABLES, type FileOpKind, type FileOpRow, type RemoteRow } from "./store.js";
export {
  FileChangedError,
  FileMovedOnError,
  FilesUnavailableError,
  InvalidPathError,
  UnknownBackendError,
  type AttachmentInput,
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
  type FilesAgentPolicy,
  type FileListPreference,
  type FileSearchInput,
  type FileSearchHit,
  type FileSearchResult,
  type ListMode,
  type PathPolicy,
  type PathPreference,
  type SyncMode,
  type OpenStoreOptions,
  type StoreEnv,
  type SaveResult,
  type WriteEntry,
  type WriteOptions
} from "./types.js";
export type {} from "./channels.js";
export { Files as default } from "./service.js";
