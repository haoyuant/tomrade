import type { z } from "zod";

/**
 * Where a project's shareable copy stands relative to its destination.
 * `local` means no destination is bound; there is nothing to sync.
 */
export type SyncState = "local" | "synced" | "ahead" | "behind" | "diverged" | "offline" | "error" | "unavailable";

export interface StorageStatus {
  state: SyncState;
  /** Human-readable, non-secret: "github.com/acme/app · main · .tomrade". */
  location: string | null;
  /** Provider text for the state — "origin/main is 3 commits ahead", "git not found". */
  detail?: string;
  lastSyncAt: number | null;
}

/**
 * A provider's whole job: get one directory to and from somewhere. It never sees
 * SQLite — the live database stays in userData and only ever exchanges the text
 * artifact this directory holds.
 */
export interface StorageHandle {
  readonly location: string;
  /** The directory `.tomrade/` is written into. */
  readonly dir: string;
  /** Bring `dir` up to date. Never merges content itself. */
  pull(): Promise<{ changed: boolean }>;
  /** Publish `dir`. A no-op provider (a plain folder) may ignore the message. */
  push(message: string): Promise<void>;
  status(): Promise<Omit<StorageStatus, "lastSyncAt">>;
  /** Notify when the destination changed underneath us. */
  watch?(onChange: () => void): () => void;
  dispose(): Promise<void>;
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
  /** What to ask for, and where the user gets it. */
  prompt: { label: string; help?: string; url?: string };
  status(): Promise<ConnectionState>;
  connect(secret: string): Promise<ConnectionState>;
  disconnect(): Promise<void>;
}

export interface ConnectionState {
  connected: boolean;
  /** Who we are connected as, for the renderer to show — never the secret. */
  label?: string;
  detail?: string;
}

export interface StorageProvider<C = unknown> {
  /** Stable across releases: the binding stores this id, not a package name. */
  id: string;
  title: string;
  description?: string;
  /**
   * Per-project, non-secret configuration. Rendered from `z.toJSONSchema()`;
   * `.meta({ format: "password" })` is refused here — credentials belong in a
   * `ctx.settings` section the provider registers instead.
   */
  configSchema: z.ZodType<C>;
  defaults: C;
  /** The settings section holding this provider's credentials, if it needs any. */
  settingsSection?: string;
  /**
   * Resolve the destination from the config ALONE — never from a project id.
   * An attach has to read the manifest before it knows which project it fetched,
   * so a location that depended on the id could not be opened to find it.
   */
  open(config: C, opts: { create: boolean }): Promise<StorageHandle>;
  /** Candidates the user picks from, so nothing has to be typed by hand. */
  browse?(): Promise<{ label: string; config: C }[]>;
  /** A config for a destination that does not exist yet, from a name alone. */
  draft?(name: string): Promise<C> | C;
  /** Set when the destination needs an account; the renderer collects it inline. */
  connection?: ProviderConnection;
}

/** What the renderer gets: the schema as JSON Schema, so a form is drawn without the provider's code. */
export interface StorageProviderView {
  id: string;
  title: string;
  description?: string;
  schema: Record<string, unknown>;
  defaults: unknown;
  settingsSection?: string;
  /** Whether this provider can list candidates to pick from. */
  browsable: boolean;
  /** Whether a destination can be created from a name alone. */
  creatable: boolean;
  /** Present when an account is needed; what to ask for and where to get it. */
  connection?: ProviderConnection["prompt"];
}

export class UnknownProviderError extends Error {
  constructor(public readonly providerId: string) {
    super(`Unknown storage provider: ${providerId}`);
    this.name = "UnknownProviderError";
  }
}

/** The destination holds a project, but not this one. */
export class ForeignProjectError extends Error {
  constructor(
    public readonly expected: string,
    public readonly found: string
  ) {
    super(`That location holds project ${found}, not ${expected}`);
    this.name = "ForeignProjectError";
  }
}

/** Local and the destination both moved; nothing is overwritten without a human choosing. */
export class DivergedError extends Error {
  constructor(public readonly projectId: string) {
    super(`Project ${projectId} has local changes and the destination has moved on — resolve before syncing`);
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
