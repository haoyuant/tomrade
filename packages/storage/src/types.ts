import type { z } from "zod";
import type { GitCredential } from "./git.js";

/**
 * Where a project's folder stands relative to what this machine has published.
 * `local` means there is nothing beyond this machine to be in step with.
 */
export type SyncState = "local" | "synced" | "ahead" | "behind" | "diverged" | "syncing" | "offline" | "error" | "unavailable";

export interface StorageStatus {
  state: SyncState;
  /** Human-readable, non-secret: the folder, or "github.com/acme/app · main". */
  location: string | null;
  /** One line for the state — "3 commits behind origin", "git not found", "folder not found". */
  detail?: string;
  lastSyncAt: number | null;
}

export type GitOrigin = "dedicated" | "shared" | "none";

/** Who can read a remote: anyone, only those given access, or the host can't say. */
export type RemoteVisibility = "public" | "private" | "unknown";

/** Everything the project's storage block draws. */
export interface StorageInfo {
  projectId: string;
  /** The folder holding `.tomrade/`, or null until the Hub is configured. */
  dir: string | null;
  git: GitOrigin;
  /** For a dedicated repository: the provider and non-secret config Tomrade pushes with. */
  remote: { provider: string; config: Record<string, unknown> } | null;
  /** What the folder's own git says about its origin, for a shared checkout: where teammates will find it. */
  origin: { url: string | null; branch: string | null } | null;
  /** In a shared checkout: commit the `.tomrade` subtree after publishing. */
  autoCommit: boolean;
  /** Plugin namespaces whose tables travel in the folder, and every namespace that could. */
  exports: string[];
  /** `private`: declared for the people the project is shared with only, so it never travels to a public remote. */
  exportable: { namespace: string; tables: string[]; private: boolean }[];
  /** Who can read the dedicated repository's remote, as its provider last said; null without a remote or before it was asked. */
  visibility: RemoteVisibility | null;
  logWindowDays: number;
}

/**
 * A destination that needs an account behind it. Generic on purpose: the
 * renderer draws "connect", "connected as", and "disconnect" without knowing
 * which host it is talking to.
 *
 * The secret is the provider's to keep — per machine, in its own settings
 * section — because one account serves every project. It must never reach a
 * project's config, which is committed alongside the code.
 */
export interface ProviderConnection {
  /**
   * What the panel asks for. With `signIn` it offers that first — signing in
   * to `name` in the browser — and the secret becomes the fallback.
   */
  prompt: { label: string; help?: string; url?: string; signIn?: { name: string } };
  status(): Promise<ConnectionState>;
  connect(secret: string): Promise<ConnectionState>;
  /** Start a sign-in the person finishes elsewhere; the state carries `pending` until it lands. */
  signIn?(): Promise<ConnectionState>;
  /** Also cancels a sign-in under way. */
  disconnect(): Promise<void>;
}

export interface ConnectionState {
  connected: boolean;
  label?: string;
  detail?: string;
  /** A sign-in waiting on the person: the code to enter at `url`, until `expiresAt`. */
  pending?: { code: string; url: string; expiresAt: number };
  /** A step the account needs outside Tomrade, such as choosing which repositories it may use. */
  action?: { label: string; url: string; needed: boolean };
}

/** A git remote, as a provider resolves it from its config. The URL may carry a credential; it is scrubbed before display. */
export interface RemoteTarget {
  url: string;
  branch: string;
}

/**
 * A provider is a remote transport for a dedicated repository: it turns its
 * non-secret config into a git remote, and may know how to find or create one.
 * It never sees SQLite and never touches a folder itself.
 */
export interface StorageProvider<C = unknown> {
  /** Stable across releases: the catalog stores this id, not a package name. */
  id: string;
  title: string;
  description?: string;
  /** Per-project, non-secret. `.meta({ format: "password" })` is refused at registration. */
  configSchema: z.ZodType<C>;
  defaults: C;
  /** The settings section holding this provider's credentials, if it needs any. */
  settingsSection?: string;
  toRemote(config: C): Promise<RemoteTarget> | RemoteTarget;
  /** Bring the destination into existence — create the repository, say. */
  ensureRemote?(config: C): Promise<void>;
  /** Who can read the destination. Without it, every remote of this provider is "unknown". */
  visibility?(config: C): Promise<RemoteVisibility>;
  /** Candidates the user picks from, so nothing has to be typed by hand. */
  browse?(): Promise<{ label: string; config: C }[]>;
  /** A config for a destination that does not exist yet, from a name alone. */
  draft?(name: string): Promise<C> | C;
  connection?: ProviderConnection;
  /**
   * How git authenticates to this provider's remotes, asked before each of
   * Tomrade's git commands; null leaves the user's own git credentials in
   * charge. The secret stays with the helper, never in the remote URL.
   */
  credential?(): GitCredential | null;
}

/** What the renderer gets: the schema as JSON Schema, so a form is drawn without the provider's code. */
export interface StorageProviderView {
  id: string;
  title: string;
  description?: string;
  schema: Record<string, unknown>;
  defaults: unknown;
  settingsSection?: string;
  browsable: boolean;
  creatable: boolean;
  connection?: ProviderConnection["prompt"];
}

export class UnknownProviderError extends Error {
  constructor(public readonly providerId: string) {
    super(`Unknown storage provider: ${providerId}`);
    this.name = "UnknownProviderError";
  }
}

/** The folder holds a project, but not this one. */
export class ForeignProjectError extends Error {
  constructor(
    public readonly expected: string,
    public readonly found: string,
    names?: { expected: string; found: string }
  ) {
    super(names ? `That folder holds “${names.found}”, not “${names.expected}”` : `That folder holds project ${found}, not ${expected}`);
    this.name = "ForeignProjectError";
  }
}

/** Local and the folder both moved and the merge could not settle it. */
export class DivergedError extends Error {
  constructor(public readonly projectId: string) {
    super(`Project ${projectId} has local changes and its folder has moved on — resolve before syncing`);
    this.name = "DivergedError";
  }
}

/** The artifact was written by a build with a newer core schema. */
export class NewerSchemaError extends Error {
  constructor(
    public readonly found: number,
    public readonly supported: number
  ) {
    super(`That project was written with core schema ${found}; this build understands ${supported}. Update Tomrade first.`);
    this.name = "NewerSchemaError";
  }
}

/** Tomrade drives git only in a folder it made for the project alone. */
export class SharedCheckoutError extends Error {
  constructor(public readonly dir: string) {
    super(`${dir} is inside your own repository; Tomrade writes .tomrade there but never pushes it. Use a folder of its own to publish to a remote.`);
    this.name = "SharedCheckoutError";
  }
}

export class HubUnconfiguredError extends Error {
  constructor() {
    super("Choose where Tomrade keeps its files first (the Hub folder)");
    this.name = "HubUnconfiguredError";
  }
}
