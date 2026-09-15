import type {} from "cordis";
import type {} from "@tomrade/ipc";
import type { FileReference, Item } from "@tomrade/domain";
import type { ConflictChoice, ConnectionState, FileConflict, FileContent, FileEntry, FileVersion, FilesBackendView, FilesInfo, FilesStatus } from "./types.js";

declare module "@tomrade/ipc" {
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
    /** Copy files or folders from this machine into a folder of the store. */
    "files.import": (projectId: string, dir: string, sources: string[]) => FileEntry[];
    "files.mkdir": (projectId: string, path: string) => void;
    "files.move": (projectId: string, from: string, to: string) => void;
    "files.remove": (projectId: string, path: string) => void;
    "files.sync": (projectId: string) => FilesStatus;
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
    "files.disconnect": (backendId: string) => void;
    /** Pin a file's latest version to a ticket as material or an output artifact. */
    "files.attach": (projectId: string, itemId: string, input: { path: string; role: "input" | "output"; name?: string }) => Item;
    /** Pin several latest file versions to a ticket in one item write. */
    "files.attachMany": (projectId: string, itemId: string, input: { paths: string[]; role: "input" | "output" }) => Item;
  }
  interface Broadcasts {
    /** This project's files or their sync state moved; refetch everything keyed by it. */
    "files.changed": (projectId: string) => void;
  }
}
