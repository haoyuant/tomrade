import type {} from "cordis";
import type {} from "@tomradex/ipc";
import type { FileDescription, FileReference, Item } from "@tomradex/domain";
import type { AttachmentInput, ConflictChoice, ConnectionState, FileConflict, FileContent, FileEntry, FileVersion, FilesAgentPolicy, FilesBackendView, FilesInfo, FilesStatus, FilesSyncPolicy, ListMode, SaveResult, SyncMode } from "./types.js";
import type { AgentIndex } from "./agent-index.js";

declare module "@tomradex/ipc" {
  interface Channels {
    "files.backends": () => FilesBackendView[];
    "files.info": (projectId: string) => FilesInfo;
    "files.status": (projectId: string) => FilesStatus;
    /** Every entry, folders before files, depth first; the renderer nests them by path. */
    "files.tree": (projectId: string) => FileEntry[];
    "files.list": (projectId: string, dir?: string) => FileEntry[];
    "files.read": (projectId: string, path: string) => FileContent | null;
    /** An immutable version, as a ticket pinned it — null when it is gone or was never there. */
    "files.readVersion": (projectId: string, ref: FileReference) => FileContent | null;
    /** Where a file is now, by its id. */
    "files.locate": (projectId: string, fileId: string) => string | null;
    "files.history": (projectId: string, path: string, limit?: number) => FileVersion[];
    "files.write": (projectId: string, path: string, body: string, opts?: { encoding?: "utf8" | "base64"; message?: string }) => FileContent;
    /** A text save that will not land over somebody else's: `expect` is the `hash` the editor read, null for a new file. */
    "files.save": (projectId: string, path: string, body: string, opts?: { expect?: string | null; message?: string }) => SaveResult;
    /** Copy files or folders from this machine into a folder of the store. */
    "files.import": (projectId: string, dir: string, sources: string[]) => FileEntry[];
    /** Each returns the history record it made (`files:<id>`, for `oplog.revert`), or null when nothing changed. */
    "files.mkdir": (projectId: string, path: string) => string | null;
    "files.move": (projectId: string, from: string, to: string) => string | null;
    /** Copy a file or folder to a new path, as a version of its own with a fresh fileId. */
    "files.copy": (projectId: string, from: string, to: string) => string | null;
    "files.remove": (projectId: string, path: string) => string | null;
    "files.sync": (projectId: string) => FilesStatus;
    "files.syncPolicy": (projectId: string) => FilesSyncPolicy;
    "files.setSyncRules": (projectId: string, paths: string[], mode: SyncMode | "inherit") => FilesSyncPolicy;
    /** Which paths Tomrade names to agents on its own. Disclosure, never access. */
    "files.agentPolicy": (projectId: string) => FilesAgentPolicy;
    "files.setAgentRules": (projectId: string, paths: string[], mode: ListMode | "inherit") => FilesAgentPolicy;
    /** Exactly what an agent is told this project holds, for the person to read before an agent does. */
    "files.agentIndex": (projectId: string, opts?: { budget?: number; focus?: string[]; native?: boolean }) => AgentIndex | null;
    "files.conflicts": (projectId: string) => FileConflict[];
    "files.resolve": (projectId: string, path: string, choice: ConflictChoice) => FilesStatus;
    "files.resolveAll": (projectId: string, choice: ConflictChoice) => FilesStatus;
    /** Share the project's files through a backend's remote, and sync at once. */
    "files.bind": (projectId: string, backendId: string, config: Record<string, unknown>) => FilesStatus;
    "files.unbind": (projectId: string) => FilesInfo;
    "files.browse": (backendId: string) => { label: string; config: unknown }[];
    "files.draft": (backendId: string, name: string) => unknown;
    "files.connection": (backendId: string) => ConnectionState;
    "files.connect": (backendId: string, secret: string) => ConnectionState;
    "files.signIn": (backendId: string) => ConnectionState;
    "files.disconnect": (backendId: string) => void;
    /** Pin a file's latest version to a ticket as material or an output artifact. */
    "files.attach": (projectId: string, itemId: string, input: { path: string; role: "input" | "output"; name?: string }) => Item;
    /** Pin several latest file versions to a ticket in one item write. */
    "files.attachMany": (projectId: string, itemId: string, input: { paths: string[]; role: "input" | "output" }) => Item;
    /** The top-level folder a ticket's files land in: its workstream's name. */
    "files.folderFor": (projectId: string, itemId: string) => string;
    /** Copy files from this machine into the ticket's workstream folder and pin them. */
    "files.importFor": (projectId: string, itemId: string, input: { sources: string[]; role: "input" | "output" }) => Item;
    /** Files for a ticket body to link to, saved as one version under `<workstream>/attachments/<KEY>/`, in input order. */
    "files.addAttachments": (projectId: string, itemId: string, files: AttachmentInput[]) => FileDescription[];
    /** A file's latest content by its id, wherever it has moved; null when it is not here (deleted, or not synced yet). */
    "files.readById": (projectId: string, fileId: string) => FileContent | null;
  }
  interface Broadcasts {
    /** This project's files or their sync state moved. `paths` names the files that changed when the writer knows them; without it, refetch everything keyed by the project. */
    "files.changed": (projectId: string, paths?: string[]) => void;
  }
}
