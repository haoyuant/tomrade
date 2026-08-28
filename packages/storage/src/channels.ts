// cordis FIRST, and not for show: a `declare module "cordis"` in a package
// loaded before cordis itself declares a NEW module instead of augmenting it,
// and every later file then sees a Context without inject/plugin/get.
import type {} from "cordis";
import type {} from "@tomrade/ipc";
import type { StorageBinding } from "./bindings.js";
import type { ConnectionState, StorageProviderView, StorageStatus } from "./types.js";

declare module "@tomrade/ipc" {
  interface Channels {
    "storage.providers": () => StorageProviderView[];
    "storage.status": (projectId: string) => StorageStatus;
    "storage.binding": (projectId: string) => StorageBinding | null;
    "storage.bind": (projectId: string, providerId: string, config: Record<string, unknown>) => StorageStatus;
    "storage.unbind": (projectId: string) => void;
    "storage.sync": (projectId: string) => StorageStatus;
    /** Bring in a project this machine does not know; returns its id. */
    "storage.attach": (providerId: string, config: Record<string, unknown>) => string;
    "storage.browse": (providerId: string) => { label: string; config: unknown }[];
    /** A config for a destination that does not exist yet, from a name alone. */
    "storage.draft": (providerId: string, name: string) => unknown;
    "storage.connection": (providerId: string) => ConnectionState;
    "storage.connect": (providerId: string, secret: string) => ConnectionState;
    "storage.disconnect": (providerId: string) => void;
  }
  interface Broadcasts {
    /** This project's rows or its sync state moved; refetch everything keyed by it. */
    "storage.changed": (projectId: string) => void;
  }
}
