// cordis FIRST, and not for show: a `declare module "cordis"` in a package
// loaded before cordis itself declares a NEW module instead of augmenting it,
// and every later file then sees a Context without inject/plugin/get.
import type {} from "cordis";
import type {} from "@tomradex/ipc";
import type { RemoteRef } from "@tomradex/hub";
import type { SyncProgress } from "@tomradex/git";
import type { HubManifest } from "./hub.js";
import type { RestoreSummary } from "./restore.js";
import type { AttentionView, ConnectionState, StorageInfo, StorageProviderView, StorageStatus } from "./types.js";

declare module "@tomradex/ipc" {
  interface Channels {
    "storage.providers": () => StorageProviderView[];
    "storage.info": (projectId: string) => StorageInfo;
    "storage.status": (projectId: string) => StorageStatus;
    /** Tickets the last merge committed with delivery evidence that still needs a person; entries drop out once settled. */
    "storage.attention": (projectId: string) => AttentionView[];
    /** Re-point the project at a folder: empty → written; holding this project → adopted; holding another → refused. */
    "storage.setFolder": (projectId: string, dir: string) => StorageInfo;
    "storage.setAutoCommit": (projectId: string, on: boolean) => StorageInfo;
    "storage.setExports": (projectId: string, namespaces: string[]) => StorageInfo;
    /** Give a dedicated repository a remote and push. Refused for a shared checkout. */
    "storage.bind": (projectId: string, providerId: string, config: Record<string, unknown>) => StorageStatus;
    "storage.unbind": (projectId: string) => StorageInfo;
    "storage.sync": (projectId: string) => StorageStatus;
    /** Open a folder holding a project this machine does not know; returns its id. */
    "storage.attach": (dir: string) => string;
    /** Clone a published project into the Hub and open it; returns its id. */
    "storage.attachRemote": (providerId: string, config: Record<string, unknown>) => string;
    /** Drop the cache and read the folder again. */
    "storage.rebuild": (projectId: string) => StorageStatus;
    "storage.browse": (providerId: string) => { label: string; config: unknown }[];
    "storage.draft": (providerId: string, name: string) => unknown;
    "storage.connection": (providerId: string) => ConnectionState;
    "storage.connect": (providerId: string, secret: string) => ConnectionState;
    "storage.signIn": (providerId: string) => ConnectionState;
    "storage.disconnect": (providerId: string) => void;
    /** The Hub folder's own remote and what its portable catalog offers to attach. */
    "storage.hubInfo": () => { dir: string | null; remote: RemoteRef | null; status: StorageStatus; manifest: HubManifest | null; attachable: string[] };
    "storage.hubBind": (providerId: string, config: Record<string, unknown>) => StorageStatus;
    "storage.hubUnbind": () => void;
    "storage.hubSync": () => StorageStatus;
    /** Bring back every project the Hub knows and this machine does not; returns their ids. */
    "storage.hubAttachAll": () => string[];
    /** Projects the Hub names that are not on this machine yet, and where each one's restore stands. */
    "storage.restores": () => RestoreSummary;
    /** Try this project's restore again now. Progress arrives as `storage.restoresChanged`. */
    "storage.restore": (projectId: string) => RestoreSummary;
    /** Open the folder holding a project that has no remote to come back from. */
    "storage.locate": (projectId: string, dir: string) => string;
    /** Take a project this machine does not have out of the Hub's catalog, on every machine. Deletes nothing. */
    "storage.removeFromHub": (projectId: string) => RestoreSummary;
  }
  interface Broadcasts {
    /** This project's rows or its sync state moved; refetch everything keyed by it. */
    "storage.changed": (projectId: string) => void;
    /** A project's sync moved on a step or along its transfer; null once it ended. */
    "storage.progress": (projectId: string, progress: SyncProgress | null) => void;
    /** A restore started, moved a step, finished or stopped to wait. */
    "storage.restoresChanged": () => void;
    /** A merge left delivery evidence to settle, or the list changed. */
    "storage.attentionChanged": (projectId: string) => void;
  }
}
