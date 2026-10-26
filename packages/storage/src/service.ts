import fs from "node:fs";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { Db, ProjectDb } from "@tomradex/db";
import type { CatalogProject, Hub, RemoteRef } from "@tomradex/hub";
import type {} from "@tomradex/settings";
import type {} from "@tomradex/alerts";
import type { Oplog } from "@tomradex/oplog";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/write";
import type {} from "./channels.js";
import { GitFolder, GitMissingError, clearStaleIndexLock, cleanRemote, gitRunner, type Git, type GitCredential } from "@tomradex/git";
import { HUB_MANIFEST, emptyHub, hubProjectOf, mergeHubManifests, readHubManifest, writeHubManifest, type HubManifest, type HubBackend } from "./hub.js";
import { LOG_DIR, appendLog, compactLog, parseLog, parseOpId, readLogs, toLine, type DeviceLog, type LogLine } from "./log.js";
import { CORE_RULES, evidenceAttention, mergeStates, type Attention, type ConflictNote, type LogOp, type MergeState, type Renumbered, type TableRule } from "./merge.js";
import { Restorer, fetchProject, type Adoption, type RestoreEntry, type RestoreSummary } from "./restore.js";
import {
  ARTIFACT_DIR,
  ConflictMarkersError,
  artifactStamp,
  DEFAULT_LOG_WINDOW_DAYS,
  TornArtifactError,
  digestState,
  exportState,
  hasArtifact,
  importPlugins,
  importState,
  parseArtifact,
  primaryKeyOf,
  projectIdOf,
  readArtifact,
  refreshSupportFiles,
  restoreLf,
  serializeState,
  writeArtifact,
  type ProjectState
} from "./state.js";
import {
  ForeignProjectError,
  HubUnconfiguredError,
  SharedCheckoutError,
  UnknownProviderError,
  UnpublishedEditsError,
  type AttentionView,
  type ConnectionState,
  type GitOrigin,
  type RemoteVisibility,
  type StorageInfo,
  type StorageProvider,
  type StorageProviderView,
  type StorageStatus,
  type SyncState,
  type SyncSummary
} from "./types.js";
import { STORAGE_WORDS } from "./words.js";
import { bestEffort, contract, errorMessage, localeOf, type StorageReader } from "@tomradex/contracts";

// "synced" with writes still waiting reads as ahead.
const STATE_WORD: Record<SyncState, Extract<Parameters<ReturnType<typeof STORAGE_WORDS>>[0], `state${string}`>> = {
  local: "stateLocal",
  synced: "stateAhead",
  ahead: "stateAhead",
  behind: "stateBehind",
  diverged: "stateDiverged",
  syncing: "stateSyncing",
  offline: "stateOffline",
  error: "stateError",
  unavailable: "stateUnavailable"
};

declare module "cordis" {
  interface Context {
    storage: Storage;
  }
  interface Events {
    "storage/registered"(providerId: string): void;
    "storage/unregistered"(providerId: string): void;
    "storage/synced"(projectId: string, status: StorageStatus): void;
    /** A merge committed with delivery evidence that disagrees with itself; the list is what still needs a person. */
    "storage/attention"(projectId: string, notes: Attention[]): void;
    /** The folder's copy replaced the local rows; caches for this project are stale. */
    "storage/imported"(projectId: string): void;
    /** A project the Hub named came back to this machine. */
    "storage/restored"(projectId: string): void;
  }
}

export const StorageConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** Which git to run. A GUI-launched app has a thin PATH; the user can name one in Settings. */
    gitBinary: z.string().default("git"),
    /** The log is written through at once; the snapshot follows after this quiet period… */
    snapshotIdleMs: z.number().int().min(0).default(5_000),
    /** …and no later than this after the first unpublished write. */
    snapshotMaxMs: z.number().int().min(0).default(30_000),
    /** Watch each project's `.tomrade/` for changes made by someone else (a pull, a sync tool). */
    watch: z.boolean().default(true),
    /** Backstop sweep: publish anything the timers missed. 0 disables. */
    reconcileMs: z.number().int().min(0).default(300_000),
    /** Bring back, without being asked, every project the Hub names and this machine lacks. */
    autoRestore: z.boolean().default(true),
    /** How long a remote's answer to "who can read you?" stands before the next push asks again. */
    visibilityMs: z.number().int().min(0).default(600_000),
    /** How long the remote's answer stands for a status read; it doubles while nothing moves, up to five minutes. */
    remoteFreshMs: z.number().int().min(0).default(30_000),
    /** After the remote could not be reached, the first wait before asking again; it doubles each time, up to ten minutes. */
    remoteRetryMs: z.number().int().min(0).default(15_000),
    /** How long a folder may disagree with its manifest and still read as mid-sync; past it, the status is an error and the person is told once. */
    tornErrorMs: z.number().int().min(0).default(600_000)
  })
);
export type StorageConfig = z.infer<typeof StorageConfig>;

const LOCAL: StorageStatus = { state: "local", location: null, lastSyncAt: null };
const DAY = 86_400_000;
const QUIET_MAX_MS = 300_000;
const RETRY_MAX_MS = 600_000;
/** A publish or a refresh about to act on the remote takes an answer this young, such as the one a refresh just got. */
const ACT_FRESH_MS = 2_000;

type RemoteProbe = "exists" | "absent" | "offline";
/** One folder's remote branch: the ask under way, and the last answer. */
interface RemoteAsk {
  pending: Promise<RemoteProbe> | null;
  probe: RemoteProbe | null;
  at: number;
  /** Answers in a row in which the remote did not move. */
  quiet: number;
  /** Answers in a row in which it could not be reached. */
  failures: number;
  /** The answer came with a fetch, not from our own push: something to act on. */
  fetched: boolean;
}


export const slugOf = (name: string): string =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";

/**
 * The project's folder is the truth; the cache follows it. This service keeps
 * the two in step: every write lands in the folder's log at once and in its
 * snapshot shortly after; a change made to the folder by anyone else is read
 * back in. Git is driven only in folders Tomrade made for a project alone.
 */
export class Storage extends Service implements StorageReader {
  static provide = "storage";
  static inject = ["db", "hub", "oplog"];
  static Config = StorageConfig;

  /** Resolves when the boot reconcile has run; tests await it. */
  ready: Promise<void> = Promise.resolve();

  private registry = new Map<string, StorageProvider>();
  private connectedProviders = new Set<string>();
  private watchers = new Map<string, fs.FSWatcher>();
  private watchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private maxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** After our own write the watcher hears an echo; ignore events until then. */
  private quietUntil = new Map<string, number>();
  private publishing = new Set<string>();
  /** Each project's folder and git work, one at a time; see `inTurn`. */
  private turns = new Map<string, Promise<void>>();
  /** Why the folder's last commit or push failed, until one succeeds: the folder is ahead of git whatever the digests say. */
  private gitFailed = new Map<string, string>();
  private lastState = new Map<string, SyncState>();
  private lastStatus = new Map<string, StorageStatus>();
  /** Base snapshots for projects whose cache is in memory (tests). */
  private publishedMem = new Map<string, ProjectState>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private hubWriteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Why the Hub folder's manifest cannot be read, until it reads again: nothing is written over it meanwhile. */
  private hubUnreadable: string | null = null;
  /** Projects removed on purpose on this machine; the Hub's catalog must not bring them back. */
  private tombstones = new Map<string, number>();
  private attentionByProject = new Map<string, Attention[]>();
  /** Folders whose files do not match their manifest: since when, and whether the person has been told. */
  private torn = new Map<string, { since: number; told: boolean }>();
  /** A folder's digest as status last read it, kept while its files are the ones it read. */
  private folderSeen = new Map<string, { stamp: string; verify: boolean; digest: string | null }>();
  /** The local digest as status last computed it, kept while the cache file and what decides the export are unchanged. */
  private digestSeen = new Map<string, { db: ProjectDb; key: string; digest: string }>();
  /** The last reason a project's folder was not read or written, so the log says it once rather than on every try. */
  private gaveUpWhy = new Map<string, string>();
  private closing = false;
  private hubBackend: HubBackend | null = null;
  private restorer!: Restorer;

  useHubBackend(backend: HubBackend): () => void {
    if (this.hubBackend) throw new Error("A Hub backend is already installed");
    this.hubBackend = backend;
    return () => { this.hubBackend = null; };
  }
  private readonly home: Context;
  private readonly runGit: Git;

  constructor(
    ctx: Context,
    public readonly config: StorageConfig
  ) {
    super(ctx, "storage");
    this.home = ctx;
    this.runGit = gitRunner(config.gitBinary, undefined, () => this.credentials());
  }

  [Service.init]() {
    this.restorer = new Restorer({
      manifest: () => this.hubManifest(),
      known: (id) => this.entry(id) !== null || this.tombstones.has(id),
      provider: (id) => this.registry.get(id) ?? null,
      git: this.runGit,
      projectsDir: () => (this.hub.dir ? path.join(this.hub.dir, "projects") : null),
      folderFor: (name) => this.folderFor(name),
      adopt: (id, dir, remote, how) => this.adopt(id, dir, remote, how),
      changed: () => this.home.get("ipc")?.send("storage.restoresChanged"),
      restored: (id) => this.restored(id),
      warn: (m) => this.home.logger.warn(`storage: ${m}`),
      auto: this.config.autoRestore
    });
    this.home.on("write/committed", (intent) => this.onCommitted(intent.projectId));
    // An undo or redo moves rows without a write; the folder is stale all the same.
    this.home.on("oplog/reverted", (projectId) => this.onCommitted(projectId));
    this.home.on("projects/created", (project) => void this.materialize(project.id).catch((e) => this.warn(project.id, e)));
    this.home.on("projects/removed", (projectId) => {
      this.forget(projectId);
      this.tombstones.set(projectId, Date.now());
      this.hubBackend?.removeProject(projectId);
      this.scheduleHubWrite();
    });
    this.home.on("hub/configured", () => void this.reconcileAll("configured").then(() => this.restoreMissing()));
    // A plugin that loads after its project's folder was read takes in what it missed before it reads its own tables.
    this.home.on("db/registered", (namespace, scope) => {
      if (scope !== "project") return;
      for (const entry of this.hub.catalog.projects()) if (entry.unimported.includes(namespace)) this.takeInLate(entry.id);
    });
    this.home.on("db/opened", (projectId) => this.takeInLate(projectId));
    // A destination switched on late may be the one a waiting project needs.
    this.home.on("storage/registered", (providerId) => this.requeue((e) => e.state === "needs-provider" && e.provider?.id === providerId));

    if (this.config.reconcileMs > 0) {
      // A pass slower than the interval is not joined by another: their turns would pile up, and a write's publish would wait behind them all.
      let sweeping = false;
      this.reconcileTimer = setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        void this.reconcileAll("reconcile").finally(() => (sweeping = false));
      }, this.config.reconcileMs);
      this.reconcileTimer.unref?.();
    }

    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("storage.providers", () => ctx.storage.describe());
      ctx.ipc.handle("storage.info", (projectId) => ctx.storage.info(projectId));
      ctx.ipc.handle("storage.status", (projectId) => ctx.storage.statusFor(projectId));
      ctx.ipc.handle("storage.attention", (projectId) => ctx.storage.attentionViews(projectId));
      ctx.ipc.handle("storage.setFolder", (projectId, dir) => ctx.storage.setFolder(projectId, dir));
      ctx.ipc.handle("storage.setAutoCommit", (projectId, on) => ctx.storage.setAutoCommit(projectId, on));
      ctx.ipc.handle("storage.setExports", (projectId, namespaces) => ctx.storage.setExports(projectId, namespaces));
      ctx.ipc.handle("storage.bind", (projectId, providerId, config) => ctx.storage.bind(projectId, providerId, config));
      ctx.ipc.handle("storage.unbind", (projectId) => ctx.storage.unbind(projectId));
      ctx.ipc.handle("storage.sync", (projectId) => ctx.storage.sync(projectId));
      ctx.ipc.handle("storage.attach", (dir) => ctx.storage.attach(dir));
      ctx.ipc.handle("storage.attachRemote", (providerId, config) => ctx.storage.attachRemote(providerId, config));
      ctx.ipc.handle("storage.rebuild", (projectId) => ctx.storage.rebuild(projectId));
      ctx.ipc.handle("storage.browse", (providerId) => ctx.storage.browse(providerId));
      ctx.ipc.handle("storage.draft", (providerId, name) => ctx.storage.draft(providerId, name));
      ctx.ipc.handle("storage.connection", (providerId) => ctx.storage.connection(providerId));
      ctx.ipc.handle("storage.connect", (providerId, secret) => ctx.storage.connect(providerId, secret));
      ctx.ipc.handle("storage.signIn", (providerId) => ctx.storage.signIn(providerId));
      ctx.ipc.handle("storage.disconnect", (providerId) => ctx.storage.disconnect(providerId));
      ctx.ipc.handle("storage.hubInfo", () => ctx.storage.hubInfo());
      ctx.ipc.handle("storage.hubBind", (providerId, config) => ctx.storage.bindHub(providerId, config));
      ctx.ipc.handle("storage.hubUnbind", () => ctx.storage.unbindHub());
      ctx.ipc.handle("storage.hubSync", () => ctx.storage.syncHub());
      ctx.ipc.handle("storage.hubAttachAll", () => ctx.storage.attachAll());
      ctx.ipc.handle("storage.restores", () => ctx.storage.restores());
      ctx.ipc.handle("storage.restore", (projectId) => ctx.storage.restore(projectId));
      ctx.ipc.handle("storage.locate", (projectId, dir) => ctx.storage.locate(projectId, dir));
      ctx.ipc.handle("storage.removeFromHub", (projectId) => ctx.storage.removeFromHub(projectId));
    });

    this.home.inject(["contributions"], (ctx) => {
      ctx.contributions.statusItem({
        id: "storage",
        text: ({ projectId }) => {
          if (!projectId) return null;
          const entry = ctx.storage.entry(projectId);
          if (!entry?.dir) return null;
          const state = ctx.storage.cachedState(projectId);
          const where = entry.git === "dedicated" && entry.remote ? entry.remote.provider : path.basename(entry.dir);
          const waiting = ctx.storage.pending(projectId)?.count ?? 0;
          if (state === "synced" && !waiting) return where;
          const w = STORAGE_WORDS(localeOf(ctx));
          const word = w(STATE_WORD[state]);
          // How many of this machine's writes have not left it yet: the number to worry about before quitting.
          return waiting ? `${where} · ${word} · ${w("unsynced", { n: waiting })}` : `${where} · ${word}`;
        }
      });
    });

    this.ready = this.reconcileAll("boot");
    // Destinations register just after this service; let them arrive before anything is judged missing.
    let restoreBoot: ReturnType<typeof setTimeout> | null = null;
    void this.ready.then(() => {
      if (this.closing) return;
      restoreBoot = setTimeout(() => void this.restoreMissing(), 1_000);
      restoreBoot.unref?.();
    });

    return () => {
      this.closing = true;
      this.restorer.close();
      if (restoreBoot) clearTimeout(restoreBoot);
      if (this.reconcileTimer) clearInterval(this.reconcileTimer);
      if (this.hubWriteTimer) clearTimeout(this.hubWriteTimer);
      for (const t of [...this.idleTimers.values(), ...this.maxTimers.values(), ...this.watchTimers.values()]) clearTimeout(t);
      this.idleTimers.clear();
      this.maxTimers.clear();
      this.watchTimers.clear();
      for (const w of this.watchers.values()) w.close();
      this.watchers.clear();
    };
  }

  // ── plumbing ────────────────────────────────────────────────────────────────

  private get hub(): Hub {
    return this.ctx.hub;
  }

  private get oplog(): Oplog {
    return this.ctx.oplog;
  }

  private db(projectId: string): ProjectDb {
    return (this.ctx.db as Db).for(projectId);
  }

  private warn(projectId: string, error: unknown): void {
    this.home.logger.warn(`storage: ${projectId}: ${errorMessage(error)}`);
  }

  /** The catalog's row for a project, or null when this machine does not know it. */
  entry(projectId: string): CatalogProject | null {
    return this.hub.catalog.project(projectId);
  }

  private mustEntry(projectId: string): CatalogProject {
    const entry = this.entry(projectId);
    if (!entry) throw new Error(`Project ${projectId} is not on this machine`);
    return entry;
  }

  private git(dir: string): GitFolder {
    return new GitFolder(this.runGit, dir);
  }

  private get mcpBase(): string | null {
    return contract(this.ctx, "mcp")?.url ?? null;
  }

  private mcpUrl(projectId: string): string | null {
    const base = this.mcpBase;
    return base ? `${base}/${projectId}` : null;
  }

  /**
   * Run `work` once the project's earlier work is done. Two publishes that met
   * — the periodic catch-up and a write's own — both staged everything, and
   * the one that committed second found nothing left and failed. Whatever runs
   * here calls the `…InTurn` methods, never `publish` or `refresh`, which would
   * wait for the turn it holds.
   */
  private inTurn<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const turn = (this.turns.get(projectId) ?? Promise.resolve()).then(work);
    const done = turn.then(
      () => undefined,
      () => undefined
    );
    this.turns.set(projectId, done);
    void done.then(() => {
      if (this.turns.get(projectId) === done) this.turns.delete(projectId);
    });
    return turn;
  }

  private quiet(projectId: string, ms = 1_500): void {
    this.quietUntil.set(projectId, Date.now() + ms);
  }

  private notify(projectId: string): void {
    const ipc = this.home.get("ipc");
    ipc?.send("storage.changed", projectId);
  }

  private readonly remoteAsks = new Map<string, RemoteAsk>();

  /**
   * ls-remote, then fetch: at most one at a time per folder and branch, joined
   * by whoever asks meanwhile. A status read takes the last answer while it is
   * fresh; an unreachable remote is asked again only after a growing wait.
   */
  private askRemote(dir: string, branch: string, use: "status" | "act"): Promise<RemoteProbe> {
    const key = `${dir}\0${branch}`;
    let ask = this.remoteAsks.get(key);
    if (!ask) this.remoteAsks.set(key, (ask = { pending: null, probe: null, at: 0, quiet: 0, failures: 0, fetched: false }));
    if (ask.pending) return ask.pending;
    // A clock set back makes every answer stale rather than fresh for ever.
    const age = Date.now() - ask.at;
    if (ask.probe === "offline" && age >= 0 && age < this.retryAfter(ask.failures)) return Promise.resolve("offline");
    const base = this.config.remoteFreshMs;
    const fresh = use === "act" ? (ask.fetched ? Math.min(ACT_FRESH_MS, base) : 0) : Math.min(base * 2 ** Math.min(ask.quiet, 10), Math.max(base, QUIET_MAX_MS));
    if (ask.probe && ask.probe !== "offline" && age >= 0 && age < fresh) return Promise.resolve(ask.probe);
    const current = ask;
    current.pending = (async () => {
      const g = this.git(dir);
      const before = await g.tip(branch);
      let probe = await g.probe(branch);
      if (probe === "exists" && !(await g.fetch(branch))) probe = "offline";
      current.quiet = probe === "offline" ? current.quiet : (await g.tip(branch)) === before ? current.quiet + 1 : 0;
      current.failures = probe === "offline" ? current.failures + 1 : 0;
      if (probe === "offline") this.home.logger.info(`storage: cannot reach the remote of ${dir}; asking again in ${Math.round(this.retryAfter(current.failures) / 1000)} s`);
      Object.assign(current, { probe, at: Date.now(), fetched: probe === "exists" });
      return probe;
    })().finally(() => (current.pending = null));
    return current.pending;
  }

  private retryAfter(failures: number): number {
    return Math.min(this.config.remoteRetryMs * 2 ** Math.min(Math.max(failures - 1, 0), 10), RETRY_MAX_MS);
  }

  /** Our push just landed: the remote holds what we hold, and it moved. */
  private pushedTo(dir: string, branch: string): void {
    this.remoteAsks.set(`${dir}\0${branch}`, { pending: null, probe: "exists", at: Date.now(), quiet: 0, failures: 0, fetched: false });
  }

  private remember(projectId: string, status: StorageStatus): StorageStatus {
    this.lastState.set(projectId, status.state);
    this.lastStatus.set(projectId, status);
    return status;
  }

  /** Moves whenever this device writes to the project: compare two readings to tell whether a call wrote. */
  writeMark(projectId: string): number {
    return (this.ctx.db as Db).has(projectId) ? this.ownTop(projectId) : 0;
  }

  /** This device's newest own oplog row, by its device sequence: what a publish now would carry. */
  private ownTop(projectId: string): number {
    const row = this.db(projectId).prepare("SELECT MAX(device_seq) AS m FROM oplog WHERE device = ?").get(this.hub.deviceId) as { m: number | null };
    return row.m ?? 0;
  }

  private markSynced(projectId: string, upTo: number): void {
    const entry = this.entry(projectId);
    if (entry && (entry.syncedDeviceSeq ?? -1) < upTo) this.hub.catalog.patchProject(projectId, { syncedDeviceSeq: upTo });
  }

  /**
   * Writes made here that have not reached where the project is shared — the remote, or the
   * folder when there is none. Null when this machine cannot tell yet (never published since
   * the count began) or the project does not sync at all.
   */
  pending(projectId: string): { count: number; since: number | null } | null {
    const entry = this.entry(projectId);
    if (!entry?.dir || entry.syncedDeviceSeq === null || !(this.ctx.db as Db).has(projectId)) return null;
    const row = this.db(projectId).prepare("SELECT COUNT(*) AS n, MIN(at) AS first FROM oplog WHERE device = ? AND device_seq > ?").get(this.hub.deviceId, entry.syncedDeviceSeq) as { n: number; first: number | null };
    return { count: row.n, since: row.first };
  }

  /** What an agent or the quit dialog is told about a project's sync, without touching the network. */
  syncSummary(projectId: string): SyncSummary {
    const entry = this.entry(projectId);
    if (!entry?.dir) return { state: "local", location: null, detail: undefined, lastSyncAt: null, pending: null };
    const status = this.lastStatus.get(projectId);
    return { state: this.cachedState(projectId), location: status?.location ?? entry.dir, detail: status?.detail, lastSyncAt: entry.lastSyncAt, pending: this.pending(projectId) };
  }

  /** Every project's unsynced writes on this device, for the quit dialog. */
  pendingAll(): { projectId: string; name: string; count: number }[] {
    return this.hub.catalog
      .projects()
      .filter((entry) => entry.dir && (this.ctx.db as Db).has(entry.id))
      .map((entry) => ({ projectId: entry.id, name: entry.name, count: this.pending(entry.id)?.count ?? 0 }))
      .filter((p) => p.count > 0);
  }

  /** The last computed state, for surfaces that must answer synchronously. */
  cachedState(projectId: string): SyncState {
    return this.lastState.get(projectId) ?? (this.entry(projectId)?.dir ? "synced" : "local");
  }

  /** `<dir>/.tomrade`, for whoever reads what travels beside the state files (playbooks, docs). */
  artifactDirFor(projectId: string): string | null {
    const dir = this.entry(projectId)?.dir;
    return dir ? path.join(dir, ARTIFACT_DIR) : null;
  }

  // ── providers ────────────────────────────────────────────────────────────────

  /** Reversible: the provider, and its option in every project sheet, goes with the plugin that registered it. */
  register<C>(provider: StorageProvider<C>): () => void {
    if (this.registry.has(provider.id)) throw new Error(`storage provider "${provider.id}" is already registered`);
    // A remote's config is written into the project's folder; a secret in it would be too.
    const schema = z.toJSONSchema(provider.configSchema) as { properties?: Record<string, { format?: string }> };
    for (const [name, field] of Object.entries(schema.properties ?? {})) {
      if (field.format === "password") throw new Error(`storage provider "${provider.id}" puts a secret in its config ("${name}"); register a settings section instead`);
    }
    return this.ctx.effect(() => {
      this.registry.set(provider.id, provider as StorageProvider);
      this.home.emit("storage/registered", provider.id);
      return () => {
        this.registry.delete(provider.id);
        this.home.emit("storage/unregistered", provider.id);
      };
    }, `storage.register(${provider.id})`);
  }

  get(providerId: string): StorageProvider {
    const provider = this.registry.get(providerId);
    if (!provider) throw new UnknownProviderError(providerId);
    return provider;
  }

  has(providerId: string): boolean {
    return this.registry.has(providerId);
  }

  describe(): StorageProviderView[] {
    return [...this.registry.values()]
      .map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        schema: z.toJSONSchema(p.configSchema) as Record<string, unknown>,
        defaults: p.defaults,
        settingsSection: p.settingsSection,
        browsable: typeof p.browse === "function",
        creatable: typeof p.draft === "function",
        connection: p.connection?.prompt
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  browse(providerId: string): Promise<{ label: string; config: unknown }[]> {
    const provider = this.get(providerId);
    return provider.browse ? provider.browse() : Promise.resolve([]);
  }

  async draft(providerId: string, name: string): Promise<unknown> {
    const provider = this.get(providerId);
    if (!provider.draft) throw new Error(`"${provider.title}" cannot make a destination from a name`);
    return provider.draft(name);
  }

  async connection(providerId: string): Promise<ConnectionState> {
    const provider = this.get(providerId);
    return this.connected(providerId, provider.connection ? await provider.connection.status() : { connected: true });
  }

  async connect(providerId: string, secret: string): Promise<ConnectionState> {
    const provider = this.get(providerId);
    // Another account may reach what this one could not, so a connect always retries.
    this.connectedProviders.delete(providerId);
    return this.connected(providerId, provider.connection ? await provider.connection.connect(secret) : { connected: true });
  }

  /** Begin a sign-in finished in the browser; `connection()` reports when it lands. */
  async signIn(providerId: string): Promise<ConnectionState> {
    const connection = this.get(providerId).connection;
    if (!connection?.signIn) throw new Error(`storage provider "${providerId}" has no sign-in`);
    return connection.signIn();
  }

  async disconnect(providerId: string): Promise<void> {
    this.connectedProviders.delete(providerId);
    await this.get(providerId).connection?.disconnect();
  }

  /** The account may be what a project waiting to come back needed: on the turn to connected — a sign-in landing, say — those try again. */
  private connected(providerId: string, state: ConnectionState): ConnectionState {
    if (!state.connected) this.connectedProviders.delete(providerId);
    else if (!this.connectedProviders.has(providerId)) {
      this.connectedProviders.add(providerId);
      this.requeue((e) => e.provider?.id === providerId && (e.state === "needs-connection" || e.state === "failed"));
    }
    return state;
  }

  // ── the folder ───────────────────────────────────────────────────────────────

  /** A fresh folder under the Hub for a project, named after it, never colliding. */
  private folderFor(name: string): string {
    const hubDir = this.hub.dir;
    if (!hubDir) throw new HubUnconfiguredError();
    const base = path.join(hubDir, "projects", slugOf(name));
    let candidate = base;
    for (let n = 2; fs.existsSync(candidate); n++) candidate = `${base}-${n}`;
    return candidate;
  }

  /** Give a project without a folder one, and write it. No-op until the Hub is configured. */
  async materialize(projectId: string): Promise<void> {
    const entry = this.entry(projectId);
    if (!entry || entry.dir || !this.hub.dir) return;
    const dir = this.folderFor(entry.name || projectId);
    fs.mkdirSync(dir, { recursive: true });
    this.hub.catalog.patchProject(projectId, { dir, git: "none", exports: this.defaultExports("none") });
    await this.publish(projectId, "create");
    this.watch(projectId);
  }

  /** Namespaces that travel by default: all of them in a folder of Tomrade's own, none inside someone's code checkout. */
  private defaultExports(origin: GitOrigin): string[] {
    if (origin === "shared") return [];
    return this.exportable().map((e) => e.namespace);
  }

  /** What the user can choose to carry. Tables declared `always` travel regardless, so they are not a choice. */
  private exportable(): { namespace: string; tables: string[]; private: boolean }[] {
    return (this.ctx.db as Db)
      .registrations("project")
      .map((r) => {
        const chosen = Object.entries(r.tables).filter(([, s]) => s.export && !s.export.always);
        return { namespace: r.namespace, tables: chosen.map(([t]) => t), private: chosen.some(([, s]) => s.export && s.export.private === true) };
      })
      .filter((e) => e.tables.length)
      .sort((a, b) => a.namespace.localeCompare(b.namespace));
  }

  /** What may travel to a remote this visible: anything but `private` namespaces when it is public. */
  private allowedExports(namespaces: string[], visibility: RemoteVisibility | null): string[] {
    if (visibility !== "public") return namespaces;
    const closed = new Set(this.exportable().filter((e) => e.private).map((e) => e.namespace));
    return namespaces.filter((n) => !closed.has(n));
  }

  /**
   * Ask the provider who can read the project's remote, at most once per
   * `visibilityMs` — and so before a push once the last answer is that old.
   * A public remote has its `private` namespaces unticked; one that doesn't
   * answer keeps the last answer.
   */
  private async checkVisibility(projectId: string, force = false): Promise<void> {
    const entry = this.entry(projectId);
    if (!entry?.remote || entry.git !== "dedicated" || !this.has(entry.remote.provider)) return;
    if (!force && entry.visibilityAt !== null && Date.now() - entry.visibilityAt < this.config.visibilityMs) return;
    const provider = this.get(entry.remote.provider);
    let visibility: RemoteVisibility = "unknown";
    if (provider.visibility) {
      try {
        visibility = await Promise.race([
          provider.visibility(provider.configSchema.parse(entry.remote.config)),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in 10 s")), 10_000).unref?.())
        ]);
      } catch (error) {
        this.home.logger.warn(`storage: could not tell who can read the remote of ${projectId} — ${errorMessage(error)}`);
        return;
      }
    }
    const current = this.mustEntry(projectId);
    const exports = this.allowedExports(current.exports, visibility);
    this.hub.catalog.patchProject(projectId, { visibility, visibilityAt: Date.now(), exports });
    if (visibility !== current.visibility || exports.length !== current.exports.length) this.notify(projectId);
  }

  private async detectOrigin(dir: string, markedDedicated: boolean): Promise<GitOrigin> {
    try {
      return await this.git(dir).origin(markedDedicated);
    } catch (error) {
      if (error instanceof GitMissingError) return "none";
      throw error;
    }
  }

  async info(projectId: string): Promise<StorageInfo> {
    const entry = this.mustEntry(projectId);
    let origin: StorageInfo["origin"] = null;
    if (entry.dir && entry.git !== "none") {
      try {
        const g = this.git(entry.dir);
        origin = { url: await g.remoteUrl(), branch: await g.currentBranch() };
      } catch {
        origin = null;
      }
    }
    return {
      projectId,
      dir: entry.dir,
      git: entry.git,
      remote: entry.remote,
      origin,
      autoCommit: entry.autoCommit,
      exports: entry.exports,
      exportable: this.exportable(),
      visibility: entry.git === "dedicated" && entry.remote ? entry.visibility : null,
      logWindowDays: DEFAULT_LOG_WINDOW_DAYS
    };
  }

  // ── write-through ────────────────────────────────────────────────────────────

  private onCommitted(projectId: string): void {
    if (this.closing) return;
    try {
      this.appendTail(projectId);
    } catch (error) {
      this.warn(projectId, error);
    }
    this.schedule(projectId);
  }

  /** Every oplog row of ours the folder's log does not have yet, appended now. */
  private appendTail(projectId: string): void {
    const entry = this.entry(projectId);
    if (!entry?.dir || !fs.existsSync(entry.dir)) return;
    const device = this.hub.deviceId;
    const rows = this.oplog.since(projectId, entry.lastLoggedSeq);
    if (!rows.length) return;
    const lines = rows.filter((r) => r.device === device).map(toLine).filter((l): l is LogLine => l !== null);
    this.quiet(projectId);
    appendLog(entry.dir, device, lines);
    this.hub.catalog.patchProject(projectId, { lastLoggedSeq: rows[rows.length - 1].seq });
  }

  private schedule(projectId: string): void {
    if (this.closing || !this.entry(projectId)?.dir) return;
    const fire = () => {
      clearTimeout(this.idleTimers.get(projectId));
      clearTimeout(this.maxTimers.get(projectId));
      this.idleTimers.delete(projectId);
      this.maxTimers.delete(projectId);
      void this.publish(projectId, "write").catch((e) => this.warn(projectId, e));
    };
    clearTimeout(this.idleTimers.get(projectId));
    const idle = setTimeout(fire, this.config.snapshotIdleMs);
    idle.unref?.();
    this.idleTimers.set(projectId, idle);
    if (!this.maxTimers.has(projectId)) {
      const max = setTimeout(fire, this.config.snapshotMaxMs);
      max.unref?.();
      this.maxTimers.set(projectId, max);
    }
  }

  private checkpointOf(projectId: string): Record<string, number> {
    const rows = this.db(projectId).prepare("SELECT device, MAX(device_seq) AS m FROM oplog WHERE device_seq IS NOT NULL GROUP BY device").all() as { device: string; m: number }[];
    return Object.fromEntries(rows.map((r) => [r.device, r.m]));
  }

  private exportFor(projectId: string, entry: CatalogProject, at = Date.now()): ProjectState {
    const registrations = (this.ctx.db as Db).registrations("project");
    return exportState(this.db(projectId), projectId, {
      registrations,
      exports: this.allowedExports(entry.exports, entry.visibility),
      repo: entry.git === "dedicated" ? "dedicated" : undefined,
      checkpoint: this.checkpointOf(projectId),
      at,
      withhold: entry.withheld,
      carry: this.unregistered(projectId, new Set(registrations.map((r) => r.namespace)))
    });
  }

  /** The digest of what this machine would write now; the export already carries it, so it is not hashed twice. */
  private localDigest(projectId: string, entry: CatalogProject): string {
    const state = this.exportFor(projectId, entry);
    return state.manifest.snapshot?.digest ?? digestState(state);
  }

  /**
   * The local digest for status, which is asked on every change anywhere in the project. SQLite's
   * own counters say whether the file moved: a row this connection wrote, a commit by any other,
   * a schema change. Tables carried for a plugin that is not loaded come from elsewhere, so then
   * nothing is kept.
   */
  private statusDigest(projectId: string, entry: CatalogProject): string {
    const db = this.db(projectId);
    const registrations = (this.ctx.db as Db).registrations("project");
    if (Object.keys(this.unregistered(projectId, new Set(registrations.map((r) => r.namespace)))).length) return this.localDigest(projectId, entry);
    const counters = db.prepare("SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version, (SELECT schema_version FROM pragma_schema_version) AS schema").get();
    const key = JSON.stringify([
      counters,
      this.allowedExports(entry.exports, entry.visibility),
      entry.git,
      entry.withheld,
      registrations.map((r) => [r.namespace, r.scope, r.tables])
    ]);
    const seen = this.digestSeen.get(projectId);
    if (seen && seen.db === db && seen.key === key) return seen.digest;
    const digest = this.localDigest(projectId, entry);
    this.digestSeen.set(projectId, { db, key, digest });
    return digest;
  }

  /**
   * A plugin that is not loaded — not yet, early in a launch, or switched off —
   * cannot say what its tables hold, and its silence is not a deletion: the
   * folder keeps what it last had for it, for this machine and every other.
   */
  private unregistered(projectId: string, registered: Set<string>): ProjectState["plugins"] {
    const dir = this.publishedDir(projectId);
    if (dir) {
      // Read the published copy only when a namespace in it has no plugin here.
      let namespaces: string[] = [];
      try {
        namespaces = fs.readdirSync(path.join(dir, ARTIFACT_DIR, "plugins"));
      } catch {
        return {};
      }
      if (namespaces.every((ns) => registered.has(ns))) return {};
    }
    const published = this.loadPublished(projectId)?.plugins ?? {};
    return Object.fromEntries(Object.entries(published).filter(([ns]) => !registered.has(ns)));
  }

  /** The namespaces of `state` the cache could not take in, for want of their plugin here. */
  private unimportedOf(state: ProjectState): string[] {
    const registered = new Set((this.ctx.db as Db).registrations("project").map((r) => r.namespace));
    return Object.keys(state.plugins ?? {}).filter((ns) => !registered.has(ns)).sort();
  }

  /**
   * Into the cache, now that their plugin is here: the tables the folder had
   * when it was read without it. Its old cached rows would otherwise be
   * published over what someone else changed meanwhile.
   */
  private takeInLate(projectId: string): void {
    const entry = this.entry(projectId);
    const pool = this.ctx.db as Db;
    if (!entry?.unimported.length || !pool.has(projectId)) return;
    const registrations = pool.registrations("project");
    const ready = entry.unimported.filter((ns) => registrations.some((r) => r.namespace === ns));
    if (!ready.length) return;
    const published = this.loadPublished(projectId)?.plugins ?? {};
    try {
      importPlugins(this.db(projectId), Object.fromEntries(ready.flatMap((ns) => (published[ns] ? [[ns, published[ns]]] : []))), registrations);
    } catch (error) {
      this.warn(projectId, error);
      return;
    }
    this.hub.catalog.patchProject(projectId, { unimported: entry.unimported.filter((ns) => !ready.includes(ns)) });
  }

  /** The base for a three-way merge: what this machine last wrote to or read from the folder. */
  private publishedDir(projectId: string): string | null {
    const file = (this.ctx.db as Db).pathFor(projectId);
    return file === ":memory:" ? null : path.join(path.dirname(file), "published");
  }

  private savePublished(projectId: string, state: ProjectState): void {
    const dir = this.publishedDir(projectId);
    if (!dir) {
      this.publishedMem.set(projectId, state);
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, body] of serializeState(state)) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, "utf8");
    }
  }

  loadPublished(projectId: string): ProjectState | null {
    const dir = this.publishedDir(projectId);
    if (!dir) return this.publishedMem.get(projectId) ?? null;
    try {
      return readArtifact(dir, { verify: this.verifies(projectId) });
    } catch {
      return null;
    }
  }

  /**
   * Write the snapshot (the log is already there), remember it as the base, and
   * in a dedicated repository commit and push. Skips the write when the bytes
   * would be identical.
   */
  async publish(projectId: string, reason = "write"): Promise<StorageStatus> {
    if (!this.entry(projectId)?.dir) return this.remember(projectId, LOCAL);
    return this.published(projectId, await this.inTurn(projectId, () => this.writeOut(projectId, reason)));
  }

  private async publishInTurn(projectId: string, reason: string): Promise<StorageStatus> {
    if (!this.entry(projectId)?.dir) return this.remember(projectId, LOCAL);
    return this.published(projectId, await this.writeOut(projectId, reason));
  }

  /** Where the project stands after a publish; the window hears of one that wrote. */
  private async published(projectId: string, wrote: boolean): Promise<StorageStatus> {
    const status = await this.statusFor(projectId);
    if (wrote) {
      this.home.emit("storage/synced", projectId, status);
      this.notify(projectId);
    }
    return status;
  }

  /** The folder written and committed, and pushed where it has a remote; false when it could not be written yet. */
  private async writeOut(projectId: string, reason: string, opts: { leaving?: boolean } = {}): Promise<boolean> {
    const first = this.entry(projectId);
    if (!first?.dir || !fs.existsSync(first.dir) || this.lost(first)) return false;
    const dir = first.dir;
    this.appendTail(projectId);
    // Someone else's change may be sitting in the folder; take it (merging if
    // need be) before writing over it. A folder that does not read cleanly —
    // mid-sync, conflicted, from a newer build — is left as it is: written over,
    // another machine would take our snapshot for its own work undone.
    if (hasArtifact(dir) && reason !== "merge") {
      const { state: onDisk, problem } = this.readFolder(dir, this.verifies(projectId));
      if (problem) return this.gaveUp(projectId, "not written", problem);
      if (onDisk && (onDisk.manifest.snapshot?.digest ?? digestState(onDisk)) !== first.lastPublishedDigest) {
        await this.refreshInTurn(projectId);
        // A pull during the refresh may have brought in what this build cannot read.
        const after = hasArtifact(dir) ? this.readFolder(dir, this.verifies(projectId)).problem : undefined;
        if (after) return this.gaveUp(projectId, "not written", after);
      }
    }
    this.gaveUpWhy.delete(projectId);
    // A quit never waits on the network; it goes by the last answer.
    if (!opts.leaving) await this.checkVisibility(projectId);
    const entry = this.mustEntry(projectId);
    const now = Date.now();
    const upTo = this.ownTop(projectId);
    const state = this.exportFor(projectId, entry, now);
    const digest = state.manifest.snapshot!.digest;
    this.publishing.add(projectId);
    this.quiet(projectId, 3_000);
    try {
      if (digest !== entry.lastPublishedDigest || !hasArtifact(dir) || this.manifestChanged(dir, state)) {
        writeArtifact(dir, state, { mcpUrl: this.mcpUrl(projectId) });
        compactLog(dir, this.hub.deviceId, (state.manifest.logWindowDays ?? DEFAULT_LOG_WINDOW_DAYS) * DAY, now);
        this.savePublished(projectId, state);
        this.hub.catalog.patchProject(projectId, { lastPublishedDigest: digest, lastSyncAt: now });
      } else {
        refreshSupportFiles(dir, { mcpUrl: this.mcpUrl(projectId) });
      }
      restoreLf(dir);
      const counts = Object.entries(state.tables).filter(([, rows]) => rows.length);
      const summary = `tomrade: ${reason} — ${counts.map(([t, rows]) => `${rows.length} ${t}`).join(", ") || "empty project"}`;
      // The folder is where the project is shared unless a remote is; then only a push counts.
      let delivered = true;
      try {
        if (entry.git === "dedicated") delivered = await (opts.leaving ? this.pushOnLeaving(entry, summary) : this.pushDedicated(projectId, entry, summary));
        else if (entry.git === "shared" && entry.autoCommit) await this.git(dir).commit(summary, ARTIFACT_DIR);
      } catch (error) {
        // A hook or a signing key said no: the status says why, and the next reconcile tries again.
        this.gitFailed.set(projectId, errorMessage(error));
        this.notify(projectId);
        throw error;
      }
      this.gitFailed.delete(projectId);
      if (delivered) this.markSynced(projectId, upTo);
    } finally {
      this.publishing.delete(projectId);
      this.quiet(projectId);
    }
    return true;
  }

  /**
   * The folder held this project once and holds none now. Another project may
   * have it by then, so it is not refilled unasked; choosing the folder again
   * claims it back. A code checkout is the exception: a branch without
   * `.tomrade/` is ordinary there.
   */
  private lost(entry: CatalogProject): boolean {
    return !!entry.dir && entry.lastPublishedDigest !== null && entry.git !== "shared" && fs.existsSync(entry.dir) && !hasArtifact(entry.dir);
  }

  /** The manifest carries more than the digest covers (repo, exports); a change there is a change worth writing. */
  private manifestChanged(dir: string, state: ProjectState): boolean {
    try {
      const current = JSON.parse(fs.readFileSync(path.join(dir, ARTIFACT_DIR, "project.json"), "utf8")) as ProjectState["manifest"];
      const strip = (m: ProjectState["manifest"]) => JSON.stringify({ ...m, snapshot: m.snapshot ? { ...m.snapshot, at: 0 } : undefined });
      return strip(current) !== strip(state.manifest);
    } catch {
      return true;
    }
  }

  /** Commit the folder, then bring the remote's news in before pushing ours out. */
  private async pushDedicated(projectId: string, entry: CatalogProject, summary: string): Promise<boolean> {
    const g = this.git(entry.dir!);
    await g.commit(summary);
    const remote = await this.remoteOf(entry);
    if (!remote) return true;
    const probe = await this.askRemote(entry.dir!, remote.branch, "act");
    if (probe === "offline") return false; // the commit waits
    const counts = probe === "exists" ? await g.aheadBehind(remote.branch) : null;
    if (counts && counts.behind > 0) {
      if (counts.ahead === 0) {
        await g.fastForward(remote.branch);
        this.absorbFolder(projectId);
      } else {
        await this.mergeRemote(projectId, this.mustEntry(projectId), g, remote.branch);
      }
    }
    await g.push(remote.branch);
    this.pushedTo(entry.dir!, remote.branch);
    return true;
  }

  /**
   * On the way out only our own commits travel, in one try, and only when
   * there are any: the remote's news waits for the next launch, which merges
   * it, so a quit never waits on a fetch or a merge.
   */
  private async pushOnLeaving(entry: CatalogProject, summary: string): Promise<boolean> {
    const g = this.git(entry.dir!);
    const committed = await g.commit(summary);
    const remote = await this.remoteOf(entry);
    if (!remote) return true;
    // Against the last-known remote tip; without one, assume there is something to push.
    if (committed || ((await g.aheadBehind(remote.branch))?.ahead ?? 1) > 0) await g.push(remote.branch);
    return true;
  }

  private async remoteOf(entry: CatalogProject): Promise<{ url: string; branch: string } | null> {
    if (!entry.remote || !this.has(entry.remote.provider)) return null;
    const provider = this.get(entry.remote.provider);
    const target = await provider.toRemote(provider.configSchema.parse(entry.remote.config));
    if (entry.dir) await this.cleanOrigin(entry.dir, target.url);
    return target;
  }

  /** Every registered provider's helper, for each of Tomrade's own git commands. */
  private credentials(): GitCredential[] {
    const out = new Map<string, GitCredential>();
    for (const provider of this.registry.values()) {
      const credential = provider.credential?.();
      if (credential && !out.has(credential.url)) out.set(credential.url, credential);
    }
    return [...out.values()];
  }

  /** Remotes once carried the token in their URL; whenever a folder's remote is used, a credential left there goes. */
  private async cleanOrigin(dir: string, url: string): Promise<void> {
    if (!fs.existsSync(dir)) return;
    try {
      await this.git(dir).dropRemoteCredential(url);
    } catch (error) {
      this.home.logger.warn(`storage: could not clean the remote of ${dir} — ${errorMessage(error)}`);
    }
  }

  // ── reading the folder back ──────────────────────────────────────────────────

  /**
   * While a table is withheld the folder's digest counts a file git never
   * carried, so its snapshot is read without the check until one that does arrives.
   */
  private verifies(projectId: string): boolean {
    return !this.entry(projectId)?.withheld.length;
  }

  /** Read the folder; a torn or conflicted artifact is reported as a status, not thrown. */
  private readFolder(dir: string, verify = true): { state: ProjectState | null; problem?: { state: SyncState; detail: string } } {
    try {
      const state = readArtifact(dir, { verify });
      this.torn.delete(dir);
      return { state };
    } catch (error) {
      if (error instanceof TornArtifactError) return { state: null, problem: this.tornProblem(dir) };
      this.torn.delete(dir);
      if (error instanceof ConflictMarkersError) return { state: null, problem: { state: "error", detail: error.message } };
      return { state: null, problem: { state: "error", detail: errorMessage(error) } };
    }
  }

  /**
   * The folder's digest for status, which asks on every change to the project: read and verified
   * again only once a file there changed. A problem is never kept, so a torn folder is judged anew.
   */
  private folderDigest(dir: string, verify: boolean): { digest: string | null; problem?: { state: SyncState; detail: string } } {
    const stamp = artifactStamp(dir);
    const seen = this.folderSeen.get(dir);
    if (seen && seen.stamp === stamp && seen.verify === verify) return { digest: seen.digest };
    const { state, problem } = this.readFolder(dir, verify);
    if (problem) {
      this.folderSeen.delete(dir);
      return { digest: null, problem };
    }
    const digest = state ? (state.manifest.snapshot?.digest ?? digestState(state)) : null;
    this.folderSeen.set(dir, { stamp, verify, digest });
    return { digest };
  }

  /**
   * Files that do not match their manifest are usually still arriving. Ones
   * that go on not matching are something else — a checkout that rewrote
   * them, a hand edit — and sync stands still on both sides until someone
   * acts, so past `tornErrorMs` it is an error and the person hears it once.
   */
  private tornProblem(dir: string): { state: SyncState; detail: string } {
    const now = Date.now();
    let seen = this.torn.get(dir);
    if (!seen) this.torn.set(dir, (seen = { since: now, told: false }));
    if (now - seen.since < this.config.tornErrorMs) return { state: "syncing", detail: "The folder is still being written or synced" };
    const minutes = Math.max(1, Math.round((now - seen.since) / 60_000));
    const w = STORAGE_WORDS(localeOf(this.home));
    const detail = w("tornDetail", { minutes, dir });
    if (!seen.told) {
      seen.told = true;
      const entry = this.hub.catalog.projects().find((e) => e.dir === dir);
      this.home.logger.warn(`storage: ${entry?.id ?? dir}: the files in ${dir} have not matched their manifest for ${minutes} min; nothing is read from or written to the folder until they do`);
      this.home.get("alerts")?.notify({ title: w("tornTitle", { name: entry?.name ?? path.basename(dir) }), body: detail });
      if (entry) this.notify(entry.id);
    }
    return { state: "error", detail };
  }

  /** A folder left alone because it does not read: said in the log once per reason, never silently. */
  private gaveUp(projectId: string, what: string, problem: { state: SyncState; detail: string }): false {
    const why = `${what}: ${problem.state} — ${problem.detail}`;
    if (this.gaveUpWhy.get(projectId) !== why) {
      this.gaveUpWhy.set(projectId, why);
      const line = `storage: ${projectId}: folder ${why}`;
      if (problem.state === "error") this.home.logger.warn(line);
      else this.home.logger.info(line);
    }
    return false;
  }

  private importForeignLogs(projectId: string, dir: string): number {
    const own = this.hub.deviceId;
    let imported = 0;
    for (const log of readLogs(dir)) {
      if (log.device === own) continue;
      imported += this.oplog.importForeign(projectId, log.ops.flatMap((op) => this.foreignOp(op)));
    }
    return imported;
  }

  private foreignOp(op: LogLine) {
    const id = parseOpId(op.id);
    if (!id) return [];
    return [
      {
        device: id.device,
        deviceSeq: id.seq,
        entity: op.entity as "item" | "board" | "view",
        entityId: op.entityId,
        op: op.op as "create" | "update" | "delete" | "purge" | "rank",
        baseVersion: op.base,
        by: op.by as "human",
        at: op.at,
        runId: op.runId ?? null,
        patch: op.patch
      }
    ];
  }

  /**
   * Take in a folder that moved: replace the cache when it has nothing
   * unpublished, merge when both moved. Reads the catalog afresh — a publish
   * may have landed while the caller awaited git — and runs in one tick, so no
   * write slips in between the export it compares and the import.
   */
  private absorbFolder(projectId: string): void {
    const entry = this.mustEntry(projectId);
    if (!entry.dir) return;
    const { state, problem } = this.readFolder(entry.dir, this.verifies(projectId));
    if (problem) this.gaveUp(projectId, "not read", problem);
    if (!state) return;
    if (projectIdOf(state) !== projectId) throw new ForeignProjectError(projectId, projectIdOf(state));
    const onDisk = state.manifest.snapshot?.digest ?? digestState(state);
    if (onDisk === entry.lastPublishedDigest) return;
    const local = this.localDigest(projectId, entry);
    if (local === entry.lastPublishedDigest) this.importInto(projectId, entry, state);
    else {
      this.mergeWith(projectId, entry, this.loadPublished(projectId), state, readLogs(entry.dir));
      // The merge lives in the cache only; the folder catches up on the usual write schedule.
      this.schedule(projectId);
    }
  }

  /**
   * Replace the cache with `state`. `base` is what the folder holds — the state
   * itself after a plain import, the folder's older snapshot after a merge — and
   * becomes what the next refresh compares the folder against.
   */
  private importInto(projectId: string, entry: CatalogProject, state: ProjectState, base: ProjectState = state): void {
    const registrations = (this.ctx.db as Db).registrations("project");
    // What a public remote must not get is not taken from it either, whatever its manifest lists: this machine's copy stands.
    const closed = new Set(entry.visibility === "public" ? this.exportable().filter((e) => e.private).map((e) => e.namespace) : []);
    const taken = { ...state, plugins: Object.fromEntries(Object.entries(state.plugins ?? {}).filter(([ns]) => !closed.has(ns))) };
    const always = (ns: string) => registrations.some((r) => r.namespace === ns && Object.values(r.tables).some((t) => t.export && t.export.always));
    const additive = Object.keys(taken.plugins).filter((ns) => !entry.exports.includes(ns) && !always(ns));
    importState(this.db(projectId), taken, { registrations, additive });
    if (entry.dir) this.importForeignLogs(projectId, entry.dir);
    this.savePublished(projectId, base);
    const digest = base.manifest.snapshot?.digest ?? digestState(base);
    const patch: Partial<CatalogProject> = { lastPublishedDigest: digest, lastSyncAt: Date.now(), name: String(state.manifest.project.name ?? entry.name), keyPrefix: String(state.manifest.project.key_prefix ?? entry.keyPrefix) };
    if (state.manifest.exports) patch.exports = this.allowedExports(state.manifest.exports, entry.visibility);
    patch.unimported = this.unimportedOf(state);
    // A withheld table this snapshot carries is known here from now on.
    if (entry.withheld.length) patch.withheld = entry.withheld.filter((key) => {
      const [ns, table] = key.split("/");
      return !state.plugins?.[ns]?.[table];
    });
    // The folder's own log now holds every row of ours up to here.
    const last = this.db(projectId).prepare("SELECT MAX(seq) AS m FROM oplog").get() as { m: number | null };
    patch.lastLoggedSeq = last.m ?? 0;
    this.hub.catalog.patchProject(projectId, patch);
    this.home.emit("storage/imported", projectId);
    this.home.emit("projects/changed", projectId);
    this.notify(projectId);
    this.home.get("ipc")?.send("projects.changed");
  }

  /**
   * Take what the folder has when it moved and we did not. When both moved the
   * merge (Phase C) settles it; until then the state is reported as diverged
   * and nothing is overwritten.
   */
  async refresh(projectId: string): Promise<StorageStatus> {
    if (!this.entry(projectId)?.dir) return this.remember(projectId, LOCAL);
    // Asking the remote where it stands takes no turn: a write waiting behind this one need not wait for that too.
    await this.inTurn(projectId, () => this.refreshInTurn(projectId));
    return this.statusFor(projectId);
  }

  private async refreshInTurn(projectId: string): Promise<void> {
    const entry = this.entry(projectId);
    if (!entry?.dir || !fs.existsSync(entry.dir)) return;
    if (entry.git === "dedicated") {
      const remote = await this.remoteOf(entry);
      if (remote) {
        const g = this.git(entry.dir);
        if ((await this.askRemote(entry.dir, remote.branch, "act")) === "exists") {
          const counts = await g.aheadBehind(remote.branch);
          if (counts && counts.behind > 0 && counts.ahead === 0) await g.fastForward(remote.branch);
          else if (counts && counts.behind > 0) {
            await this.mergeRemote(projectId, entry, g, remote.branch);
            return;
          }
        }
      }
    }
    this.absorbFolder(projectId);
  }

  // ── merging ──────────────────────────────────────────────────────────────────

  /** Both we and the remote committed: settle it with the merge-base as the base, and record a merge commit. */
  private async mergeRemote(projectId: string, entry: CatalogProject, g: GitFolder, branch: string): Promise<void> {
    const dir = entry.dir!;
    const baseCommit = await g.mergeBase(branch);
    const verify = this.verifies(projectId);
    const base = baseCommit ? parseArtifact(await g.filesAt(baseCommit, ARTIFACT_DIR), `${baseCommit}`, { verify }) : this.loadPublished(projectId);
    const theirs = parseArtifact(await g.filesAt(`origin/${branch}`, ARTIFACT_DIR), `origin/${branch}`, { verify });
    if (!theirs) {
      // The remote has commits but no project — a README from "initialize this
      // repository", say. Join the histories, keep their files, carry ours over.
      await g.beginMerge(branch);
      await this.publishInTurn(projectId, "merge");
      return;
    }
    if (projectIdOf(theirs) !== projectId) throw new ForeignProjectError(projectId, projectIdOf(theirs));
    const theirLogs: DeviceLog[] = [];
    for (const rel of await g.listAt(`origin/${branch}`, path.join(ARTIFACT_DIR, LOG_DIR))) {
      if (!rel.endsWith(".jsonl")) continue;
      const body = await g.show(`origin/${branch}`, rel);
      if (body !== null) theirLogs.push({ device: path.basename(rel, ".jsonl"), ops: parseLog(body) });
    }
    this.mergeWith(projectId, entry, base, theirs, theirLogs);
    // Their log files are content we would otherwise overwrite: write them into our folder before the merge commit.
    for (const log of theirLogs) {
      if (log.device === this.hub.deviceId) continue;
      const rel = `${ARTIFACT_DIR}/${LOG_DIR}/${log.device}.jsonl`;
      const body = await g.show(`origin/${branch}`, rel);
      if (body === null) continue;
      const file = path.join(dir, ARTIFACT_DIR, LOG_DIR, `${log.device}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, "utf8");
    }
    await g.beginMerge(branch);
    await this.publishInTurn(projectId, "merge");
  }

  /**
   * Three-way merge of the cache (ours) with the folder or remote (theirs) over
   * the last common state, settled field by field with the logs as referee;
   * the result replaces the cache, every contested field leaves a note.
   */
  private mergeWith(projectId: string, entry: CatalogProject, base: ProjectState | null, theirs: ProjectState, theirLogs: DeviceLog[]): void {
    const own = this.hub.deviceId;
    // What travels on either side is merged, ours included even if unticked here; what travels on neither stays out
    // of it — merging it would read as every row of it deleted.
    const travels = this.allowedExports([...new Set([...entry.exports, ...(theirs.manifest.exports ?? [])])].sort(), entry.visibility);
    const ours = this.exportFor(projectId, { ...entry, exports: travels });
    const checkpoint = base?.manifest.snapshot?.checkpoint ?? {};
    const since = (device: string) => checkpoint[device] ?? 0;
    const ourOps: LogOp[] = this.oplog
      .since(projectId, 0)
      .filter((e) => e.device === own && e.deviceSeq !== null && e.deviceSeq > since(own) && e.op !== "merge")
      .map((e) => ({ device: e.device, deviceSeq: e.deviceSeq!, at: e.at, by: e.by, entity: e.entity, entityId: e.entityId, op: e.op, patch: e.patch }));
    const theirOps: LogOp[] = theirLogs
      .filter((l) => l.device !== own)
      .flatMap((l) => l.ops.flatMap((op) => {
        const id = parseOpId(op.id);
        return id && id.seq > since(id.device) ? [{ device: id.device, deviceSeq: id.seq, at: op.at, by: op.by, entity: op.entity, entityId: op.entityId, op: op.op, patch: op.patch }] : [];
      }));

    const rules: Record<string, TableRule> = { ...CORE_RULES };
    const db = this.db(projectId);
    const registrations = (this.ctx.db as Db).registrations("project");
    const moves = (ns: string, table: string) => {
      const reg = registrations.find((r) => r.namespace === ns);
      const spec = reg?.tables[table]?.export;
      return !reg || (!!spec && (spec.always === true || travels.includes(ns)));
    };
    const moving = (state: ProjectState): ProjectState => ({
      ...state,
      plugins: Object.fromEntries(
        Object.entries(state.plugins ?? {})
          .map(([ns, byTable]) => [ns, Object.fromEntries(Object.entries(byTable).filter(([table]) => moves(ns, table)))] as const)
          .filter(([, byTable]) => Object.keys(byTable).length)
      )
    });
    for (const reg of registrations) {
      for (const [table, spec] of Object.entries(reg.tables)) {
        if (!spec.export || !moves(reg.namespace, table)) continue;
        let key = ["id"];
        try {
          key = primaryKeyOf(db, table);
        } catch {
          // the table is not in this file; the rows merge by id
        }
        rules[`${reg.namespace}/${table}`] = { key, mode: spec.export.appendOnly ? "append" : "rows" };
      }
    }
    const result = mergeStates({ base: base ? this.toMergeState(moving(base)) : null, ours: this.toMergeState(ours), theirs: this.toMergeState(moving(theirs)), logs: { ours: ourOps, theirs: theirOps }, rules });
    const merged = this.fromMergeState(result.merged, ours, theirs);
    // Recording the merge as the base would make the folder's older snapshot
    // read, on the next refresh, as theirs having deleted every row we added.
    this.importInto(projectId, entry, merged, theirs);
    this.noteConflicts(projectId, result.conflicts, result.renumbered);
    this.noteAttention(projectId, result.attention);
  }

  /** What the last merge left for a person to settle, minus what has been settled since. */
  attention(projectId: string): Attention[] {
    const noted = this.attentionByProject.get(projectId);
    if (!noted?.length || !this.ctx.db.has(projectId)) return [];
    const db = this.db(projectId);
    const ids = [...new Set(noted.map((n) => n.entityId))];
    const marks = ids.map(() => "?").join(",");
    const items = db.prepare(`SELECT * FROM items WHERE id IN (${marks})`).all(...ids) as Record<string, unknown>[];
    const deliveries = db.prepare(`SELECT * FROM deliveries WHERE item_id IN (${marks})`).all(...ids) as Record<string, unknown>[];
    const now = evidenceAttention(items, deliveries);
    return noted.filter((n) => now.some((c) => c.entityId === n.entityId && c.code === n.code));
  }

  attentionViews(projectId: string): AttentionView[] {
    const list = this.attention(projectId);
    if (!list.length) return [];
    const db = this.db(projectId);
    const prefix = (db.prepare("SELECT key_prefix FROM projects LIMIT 1").get() as { key_prefix: string } | undefined)?.key_prefix ?? "";
    return list.flatMap((n) => {
      const row = db.prepare("SELECT key_num, title FROM items WHERE id = ?").get(n.entityId) as { key_num: number; title: string } | undefined;
      return row ? [{ itemId: n.entityId, key: `${prefix}-${row.key_num}`, title: row.title, code: n.code }] : [];
    });
  }

  private noteAttention(projectId: string, notes: Attention[]): void {
    const before = JSON.stringify(this.attention(projectId));
    if (before === JSON.stringify(notes)) return;
    if (notes.length) this.attentionByProject.set(projectId, notes);
    else this.attentionByProject.delete(projectId);
    for (const n of notes) this.home.logger.warn(`storage: ${projectId}: merged with delivery evidence to settle for ${n.entityId} (${n.code})`);
    this.home.emit("storage/attention", projectId, notes);
    this.home.get("ipc")?.send("storage.attentionChanged", projectId);
  }

  private toMergeState(state: ProjectState): MergeState {
    const tables: MergeState["tables"] = { ...state.tables };
    for (const [ns, byTable] of Object.entries(state.plugins ?? {})) {
      for (const [table, rows] of Object.entries(byTable)) tables[`${ns}/${table}`] = rows;
    }
    return { project: state.manifest.project, tables };
  }

  private fromMergeState(merged: MergeState, ours: ProjectState, theirs: ProjectState): ProjectState {
    const tables: ProjectState["tables"] = {};
    const plugins: ProjectState["plugins"] = {};
    for (const [name, rows] of Object.entries(merged.tables)) {
      const slash = name.indexOf("/");
      if (slash < 0) tables[name] = rows;
      else (plugins[name.slice(0, slash)] ??= {})[name.slice(slash + 1)] = rows;
    }
    const exports = [...new Set([...(ours.manifest.exports ?? []), ...(theirs.manifest.exports ?? [])])].sort();
    const state: ProjectState = { manifest: { ...ours.manifest, project: merged.project, exports }, tables, plugins };
    state.manifest.snapshot = { digest: digestState(state), at: Date.now(), checkpoint: { ...(theirs.manifest.snapshot?.checkpoint ?? {}), ...(ours.manifest.snapshot?.checkpoint ?? {}) } };
    return state;
  }

  /** What the merge decided against someone: one history row per contested field, by "ai:sync", stepped over by undo. */
  private noteConflicts(projectId: string, conflicts: ConflictNote[], renumbered: Renumbered[]): void {
    const now = Date.now();
    for (const c of conflicts) {
      if (!c.entity) continue;
      const loser = c.took === "ours" ? c.theirs : c.ours;
      const winner = c.took === "ours" ? c.ours : c.theirs;
      this.oplog.append(projectId, { entity: c.entity as "item" | "board" | "view", entityId: c.entityId, op: "merge", baseVersion: null, before: { [c.field]: loser, reason: c.reason }, after: { [c.field]: winner }, by: "ai:sync", at: now, patch: { [c.field]: winner } });
    }
    for (const r of renumbered) {
      this.oplog.append(projectId, { entity: "item", entityId: r.itemId, op: "merge", baseVersion: null, before: { keyNum: r.from, reason: "renumbered" }, after: { keyNum: r.to }, by: "ai:sync", at: now, patch: { keyNum: r.to } });
    }
  }

  /** What the "Sync now" button does: take theirs, then publish ours. */
  async sync(projectId: string): Promise<StorageStatus> {
    // Asked by hand: the remote is tried now, whatever the wait after a failure says.
    const dir = this.entry(projectId)?.dir;
    if (dir) for (const [key, ask] of this.remoteAsks) if (key.startsWith(`${dir}\0`) && ask.probe === "offline") this.remoteAsks.delete(key);
    await this.checkVisibility(projectId, true);
    await this.refresh(projectId);
    return this.publish(projectId, "sync");
  }

  /**
   * Content decides. `ahead` / `behind` / `diverged` compare the cache and the
   * folder with the base this machine last published or read, so a change that
   * arrived by git, by rsync or by hand all read the same.
   */
  async statusFor(projectId: string): Promise<StorageStatus> {
    const entry = this.entry(projectId);
    if (!entry) return this.remember(projectId, LOCAL);
    if (!entry.dir) return this.remember(projectId, { ...LOCAL, detail: this.hub.dir ? undefined : "Choose the Hub folder to give this project a folder" });
    if (!fs.existsSync(entry.dir)) return this.remember(projectId, { state: "unavailable", location: entry.dir, detail: "Folder not found", lastSyncAt: entry.lastSyncAt });
    if (this.lost(entry)) return this.remember(projectId, { state: "unavailable", location: entry.dir, detail: "The folder no longer holds this project; choose it again to write the project there", lastSyncAt: entry.lastSyncAt });

    let location = entry.dir;
    let transport: { state: SyncState; detail?: string } = { state: "synced" };
    if (entry.git === "dedicated") {
      try {
        const remote = await this.remoteOf(entry);
        if (remote) {
          location = `${cleanRemote(remote.url).replace(/^https?:\/\//, "").replace(/\.git$/, "")} · ${remote.branch}`;
          const g = this.git(entry.dir);
          const probe = await this.askRemote(entry.dir, remote.branch, "status");
          if (probe === "offline") transport = { state: "offline", detail: `Cannot reach ${location}` };
          else if (probe === "absent") transport = { state: "ahead", detail: "Nothing published yet" };
          else {
            const counts = await g.aheadBehind(remote.branch);
            if (counts && counts.ahead && counts.behind) transport = { state: "diverged", detail: `${counts.ahead} local, ${counts.behind} remote commits` };
            else if (counts?.behind) transport = { state: "behind", detail: `${counts.behind} commits behind` };
            else if (counts?.ahead) transport = { state: "ahead", detail: `${counts.ahead} commits to push` };
          }
        }
      } catch (error) {
        return this.remember(projectId, { state: error instanceof GitMissingError ? "unavailable" : "error", location, detail: errorMessage(error), lastSyncAt: entry.lastSyncAt });
      }
    }

    const { digest: onDisk, problem } = this.folderDigest(entry.dir, this.verifies(projectId));
    if (problem) return this.remember(projectId, { ...problem, location, lastSyncAt: entry.lastSyncAt });
    const failed = this.gitFailed.get(projectId);
    if (failed) return this.remember(projectId, { state: "error", location, detail: failed, lastSyncAt: entry.lastSyncAt });
    let localDirty = false;
    try {
      localDirty = this.statusDigest(projectId, entry) !== entry.lastPublishedDigest;
    } catch (error) {
      return this.remember(projectId, { state: "error", location, detail: errorMessage(error), lastSyncAt: entry.lastSyncAt });
    }
    const folderMoved = onDisk !== null && onDisk !== entry.lastPublishedDigest;
    let state: SyncState = localDirty && folderMoved ? "diverged" : localDirty ? "ahead" : folderMoved ? "behind" : transport.state;
    if (transport.state === "diverged" || (transport.state === "behind" && state === "ahead") || (transport.state === "ahead" && state === "behind")) state = "diverged";
    return this.remember(projectId, { state, location, detail: transport.detail, lastSyncAt: entry.lastSyncAt });
  }

  // ── placement ────────────────────────────────────────────────────────────────

  /** Point the project at another folder. The old one is left as it is. */
  async setFolder(projectId: string, rawDir: string): Promise<StorageInfo> {
    const entry = this.mustEntry(projectId);
    const dir = path.resolve(rawDir);
    if (entry.dir && path.resolve(entry.dir) === dir && !this.lost(entry)) return this.info(projectId);
    if (hasArtifact(dir)) {
      const { state, problem } = this.readFolder(dir);
      if (problem) throw new Error(problem.detail);
      if (state && projectIdOf(state) !== projectId) throw new ForeignProjectError(projectId, projectIdOf(state));
    }
    fs.mkdirSync(dir, { recursive: true });
    this.unwatch(projectId);
    const marked = hasArtifact(dir) ? this.readFolder(dir).state?.manifest.repo === "dedicated" : entry.git === "dedicated";
    const git = await this.detectOrigin(dir, marked);
    // A folder without the project is claimed afresh: nothing published there yet.
    this.hub.catalog.patchProject(projectId, { dir, git, exports: git === "shared" ? [] : entry.exports, ...(hasArtifact(dir) ? {} : { lastPublishedDigest: null }) });
    this.scheduleHubWrite();
    if (hasArtifact(dir)) await this.refresh(projectId);
    await this.publish(projectId, "move");
    this.watch(projectId);
    return this.info(projectId);
  }

  async setAutoCommit(projectId: string, on: boolean): Promise<StorageInfo> {
    this.mustEntry(projectId);
    this.hub.catalog.patchProject(projectId, { autoCommit: on });
    return this.info(projectId);
  }

  /** Which plugin data travels. Shared through the manifest, so the next publish carries it to every machine. */
  async setExports(projectId: string, namespaces: string[]): Promise<StorageInfo> {
    const entry = this.mustEntry(projectId);
    const known = new Set(this.exportable().map((e) => e.namespace));
    const chosen = [...new Set(namespaces)].filter((n) => known.has(n)).sort();
    this.hub.catalog.patchProject(projectId, { exports: this.allowedExports(chosen, entry.visibility) });
    await this.publish(projectId, "exports");
    return this.info(projectId);
  }

  // ── remotes (dedicated repositories) ─────────────────────────────────────────

  /** Give the project's own repository a remote and publish there. A shared checkout is refused: its git is the user's. */
  async bind(projectId: string, providerId: string, rawConfig: unknown): Promise<StorageStatus> {
    const entry = this.mustEntry(projectId);
    if (!entry.dir) throw new HubUnconfiguredError();
    const provider = this.get(providerId);
    const config = provider.configSchema.parse(rawConfig) as Record<string, unknown>;
    const target = await provider.toRemote(config);
    const origin = await this.detectOrigin(entry.dir, entry.git === "dedicated");
    if (origin === "shared") throw new SharedCheckoutError(entry.dir);
    const g = this.git(entry.dir);
    if (origin === "none") await g.init(target.branch);
    await provider.ensureRemote?.(config);
    await g.setRemote(target.url);
    this.hub.catalog.patchProject(projectId, { git: "dedicated", remote: { provider: providerId, config }, visibility: null, visibilityAt: null });
    this.scheduleHubWrite();
    await this.checkVisibility(projectId, true);
    // The remote may already hold this project (a second machine binding to the same repository).
    if ((await g.probe(target.branch)) === "exists" && (await g.fetch(target.branch))) {
      const counts = await g.aheadBehind(target.branch);
      if (counts && counts.behind > 0 && counts.ahead === 0) {
        await g.fastForward(target.branch);
        if (hasArtifact(entry.dir)) {
          const { state } = this.readFolder(entry.dir, this.verifies(projectId));
          if (state && projectIdOf(state) !== projectId) {
            this.hub.catalog.patchProject(projectId, { remote: null, visibility: null, visibilityAt: null });
            throw new ForeignProjectError(projectId, projectIdOf(state));
          }
        }
        await this.refresh(projectId);
      }
    }
    const status = await this.publish(projectId, "bind");
    this.watch(projectId);
    return status;
  }

  /** Forget the remote. The repository and its history stay; nothing remote is deleted. */
  async unbind(projectId: string): Promise<StorageInfo> {
    const entry = this.mustEntry(projectId);
    if (entry.dir && entry.git === "dedicated") await bestEffort(this.git(entry.dir).removeRemote(), this.home.logger, `removing the remote of ${projectId}`);
    this.hub.catalog.patchProject(projectId, { remote: null, visibility: null, visibilityAt: null });
    this.lastState.delete(projectId);
    this.scheduleHubWrite();
    this.notify(projectId);
    return this.info(projectId);
  }

  // ── bringing projects in ─────────────────────────────────────────────────────

  /** Open a folder holding a project this machine does not know; `read` is the folder's state when the caller already has it. */
  async attach(rawDir: string, read?: ProjectState): Promise<string> {
    const dir = path.resolve(rawDir);
    const state = read ?? readArtifact(dir);
    if (!state) throw new Error(`${dir} holds no Tomrade project`);
    const projectId = projectIdOf(state);
    if (this.entry(projectId)) throw new Error(`Project ${projectId} is already on this machine`);
    const pool = this.ctx.db as Db;
    const db = pool.open(projectId);
    try {
      importState(db, state, { registrations: pool.registrations("project") });
    } catch (error) {
      pool.remove(projectId);
      throw error;
    }
    const git = await this.detectOrigin(dir, state.manifest.repo === "dedicated");
    const digest = state.manifest.snapshot?.digest ?? digestState(state);
    this.hub.catalog.upsertProject({
      id: projectId,
      name: String(state.manifest.project.name ?? ""),
      keyPrefix: String(state.manifest.project.key_prefix ?? "TOM"),
      createdAt: Number(state.manifest.project.created_at ?? Date.now()),
      dir,
      git,
      exports: state.manifest.exports ?? [],
      lastPublishedDigest: digest,
      lastSyncAt: Date.now(),
      unimported: this.unimportedOf(state)
    });
    this.importForeignLogs(projectId, dir);
    this.savePublished(projectId, state);
    const last = db.prepare("SELECT MAX(seq) AS m FROM oplog").get() as { m: number | null };
    this.hub.catalog.patchProject(projectId, { lastLoggedSeq: last.m ?? 0 });
    this.watch(projectId);
    this.home.emit("storage/imported", projectId);
    this.home.get("ipc")?.send("projects.changed");
    this.notify(projectId);
    return projectId;
  }

  /** Clone a published project into the Hub and open it. */
  async attachRemote(providerId: string, rawConfig: unknown): Promise<string> {
    const provider = this.get(providerId);
    const config = provider.configSchema.parse(rawConfig) as Record<string, unknown>;
    const target = await provider.toRemote(config);
    const hubDir = this.hub.dir;
    if (!hubDir) throw new HubUnconfiguredError();
    const staging = path.join(hubDir, "projects", `.attaching-${Date.now().toString(36)}`);
    try {
      const read = await fetchProject(this.runGit, target, staging);
      const { state } = read;
      const projectId = projectIdOf(state);
      if (this.entry(projectId)) throw new Error(`Project ${projectId} is already on this machine`);
      const name = cleanRemote(target.url).replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "project";
      const dir = this.folderFor(name);
      fs.renameSync(staging, dir);
      await this.adopt(projectId, dir, { provider: providerId, config }, { found: false, ...read });
      this.restorer.adopted(projectId);
      return projectId;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * Drop the cache and read the folder again. The folder is the truth once it
   * holds this machine's writes — the snapshot trails them by up to
   * `snapshotMaxMs` — so writes it lacks are published first, and a folder that
   * cannot take them refuses the rebuild rather than lose them. A cache that
   * lost rows without an op for it is what the rebuild is for: nothing is
   * published then, and only the window's undo goes.
   */
  async rebuild(projectId: string): Promise<StorageStatus> {
    const entry = this.mustEntry(projectId);
    if (!entry.dir || !hasArtifact(entry.dir)) throw new Error("The project's folder holds no snapshot to rebuild from");
    const dir = entry.dir;
    return this.inTurn(projectId, async () => {
      const folder = this.readFolder(dir, this.verifies(projectId));
      // Our rows past the snapshot's checkpoint for this device are what it does not reflect yet.
      if (this.ownTop(projectId) > (folder.state?.manifest.snapshot?.checkpoint?.[this.hub.deviceId] ?? 0)) {
        let why: string | null = null;
        try {
          if (!(await this.writeOut(projectId, "rebuild"))) why = folder.problem?.detail ?? "the folder could not be written";
        } catch (error) {
          // Git may have refused the commit after the snapshot was written; the digest below tells.
          why = errorMessage(error);
        }
        const current = this.mustEntry(projectId);
        if (this.localDigest(projectId, current) !== current.lastPublishedDigest) throw new UnpublishedEditsError(projectId, why ?? "the folder could not be written");
      }
      const state = readArtifact(dir, { verify: this.verifies(projectId) });
      if (!state) throw new Error("The project's folder holds no snapshot to rebuild from");
      if (projectIdOf(state) !== projectId) throw new ForeignProjectError(projectId, projectIdOf(state));
      this.unwatch(projectId);
      const pool = this.ctx.db as Db;
      pool.remove(projectId);
      const db = pool.open(projectId);
      importState(db, state, { registrations: pool.registrations("project") });
      // Every machine's log, this one's included: history comes back without snapshots, as evidence.
      for (const log of readLogs(dir)) this.oplog.importForeign(projectId, log.ops.flatMap((op) => this.foreignOp(op)), { includeOwn: true });
      this.savePublished(projectId, state);
      const last = db.prepare("SELECT MAX(seq) AS m FROM oplog").get() as { m: number | null };
      this.hub.catalog.patchProject(projectId, { lastPublishedDigest: state.manifest.snapshot?.digest ?? digestState(state), lastSyncAt: Date.now(), lastLoggedSeq: last.m ?? 0, unimported: this.unimportedOf(state) });
      this.watch(projectId);
      this.home.emit("storage/imported", projectId);
      this.home.emit("projects/changed", projectId);
      this.notify(projectId);
      return this.statusFor(projectId);
    });
  }

  // ── restoring ────────────────────────────────────────────────────────────────

  /** Projects the Hub names that are not on this machine yet, and where each stands. */
  restores(): RestoreSummary {
    this.restorer.scan();
    return this.restorer.summary();
  }

  /** The automatic path: line up with the Hub's catalog and work through whatever is due. */
  restoreMissing(): Promise<string[]> {
    if (this.closing) return Promise.resolve([]);
    this.restorer.scan();
    return this.config.autoRestore ? this.restorer.run() : Promise.resolve([]);
  }

  /** "Retry": this project, now, whatever it was waiting for. Progress arrives as `storage.restoresChanged`. */
  restore(projectId: string): RestoreSummary {
    this.restorer.scan();
    this.restorer.retry((e) => e.projectId === projectId);
    void this.restorer.run();
    return this.restorer.summary();
  }

  /** The person points at the folder holding a project that has no remote to come back from. */
  async locate(projectId: string, rawDir: string): Promise<string> {
    this.restorer.scan();
    const record = this.restorer.record(projectId);
    if (!record) throw new Error(`Project ${projectId} is already on this machine, or no longer in the Hub`);
    if (record.remote) throw new Error(`${record.name} comes back from its remote; retry instead of choosing a folder`);
    const dir = path.resolve(rawDir);
    const state = readArtifact(dir);
    if (!state) throw new Error(`${dir} holds no Tomrade project`);
    if (projectIdOf(state) !== projectId) throw new ForeignProjectError(projectId, projectIdOf(state), { expected: record.name, found: String(state.manifest.project.name ?? projectIdOf(state)) });
    await this.adopt(projectId, dir, null, { found: true });
    this.restorer.adopted(projectId);
    return projectId;
  }

  /**
   * Take a project this machine does not have out of the Hub's catalog, for
   * every machine — an old project nobody can find the folder of. Nothing is
   * deleted: a folder that still exists somewhere stays as it is, and a machine
   * that still has the project lists it again once it changes there.
   */
  removeFromHub(projectId: string): RestoreSummary {
    this.restorer.scan();
    const entry = this.restorer.entry(projectId);
    if (!entry) throw new Error(`Project ${projectId} is on this machine or no longer in the Hub; remove it from its own settings`);
    if (entry.state === "restoring") throw new Error(`${entry.name} is being restored right now`);
    this.tombstones.set(projectId, Date.now());
    this.hubBackend?.removeProject(projectId);
    this.scheduleHubWrite();
    this.restorer.scan();
    return this.restorer.summary();
  }

  private requeue(match: (entry: RestoreEntry) => boolean): void {
    this.restorer.retry(match);
    if (this.config.autoRestore && !this.closing) void this.restorer.run();
  }

  /**
   * Open a folder holding a project the Hub names, bound to the remote it came
   * back from. Nothing is written to the remote: a clone short of a file the
   * old `.gitignore` kept out gets it back beside it (an empty table) or has
   * that table withheld here (rows unknown).
   */
  private async adopt(projectId: string, dir: string, remote: RemoteRef | null, how: Adoption): Promise<void> {
    const pool = this.ctx.db as Db;
    // A cache left by an attempt that died halfway; the folder is the truth.
    if (pool.has(projectId) && !this.entry(projectId)) pool.remove(projectId);
    for (const [rel, body] of how.fill ?? []) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body, "utf8");
    }
    await this.attach(dir, how.state);
    const patch: Partial<CatalogProject> = {};
    if (remote) Object.assign(patch, { git: "dedicated", remote });
    if (how.withheld?.length) patch.withheld = how.withheld;
    if (Object.keys(patch).length) this.hub.catalog.patchProject(projectId, patch);
    if (remote) this.scheduleHubWrite();
    // A copy that was already on disk may be behind its remote, or ahead of it.
    if (how.found && remote) await this.sync(projectId).catch((e) => this.warn(projectId, e));
  }

  private restored(projectId: string): void {
    this.home.emit("storage/restored", projectId);
    // The first-run placeholder makes way for the account's own projects.
    for (const entry of this.hub.catalog.projects()) {
      if (entry.id !== projectId && this.isPristineSeed(entry)) this.dropSeed(entry);
    }
    this.scheduleHubWrite();
  }

  /**
   * The project a first run made and nobody has touched: this machine's
   * placeholder, not one of the account's projects. Any row of history, an
   * issue or plugin data ends that for good — except the sample's own issues,
   * which it was seeded with; its seed leaves no history behind.
   */
  private isPristineSeed(entry: CatalogProject): boolean {
    if (!entry.seed) return false;
    const pool = this.ctx.db as Db;
    if (!pool.has(entry.id)) return false;
    const db = pool.for(entry.id);
    const holds = (table: string): boolean => {
      try {
        return db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined;
      } catch {
        return false;
      }
    };
    const touched = holds("oplog") || (!entry.sample && holds("items")) || pool.registrations("project").some((r) => Object.keys(r.tables).some(holds));
    if (touched) this.hub.catalog.patchProject(entry.id, { seed: false });
    return !touched;
  }

  private dropSeed(entry: CatalogProject): void {
    const projects = this.ctx.get("projects");
    if (!projects) return;
    projects.remove(entry.id);
    if (!entry.dir) return;
    fs.rmSync(path.join(entry.dir, ARTIFACT_DIR), { recursive: true, force: true });
    try {
      fs.rmdirSync(entry.dir);
    } catch {
      // something else lives there; leave it
    }
  }

  // ── watching and sweeping ────────────────────────────────────────────────────

  private watch(projectId: string): void {
    if (!this.config.watch) return;
    this.unwatch(projectId);
    const dir = this.entry(projectId)?.dir;
    if (!dir) return;
    const target = path.join(dir, ARTIFACT_DIR);
    if (!fs.existsSync(target)) return;
    try {
      const watcher = fs.watch(target, { recursive: true }, () => {
        if (this.closing || this.publishing.has(projectId) || Date.now() < (this.quietUntil.get(projectId) ?? 0)) return;
        clearTimeout(this.watchTimers.get(projectId));
        const t = setTimeout(() => {
          this.watchTimers.delete(projectId);
          void this.refresh(projectId).catch((e) => this.warn(projectId, e));
        }, 500);
        t.unref?.();
        this.watchTimers.set(projectId, t);
      });
      watcher.on("error", () => this.unwatch(projectId));
      this.watchers.set(projectId, watcher);
    } catch {
      // a platform without recursive watch: the periodic reconcile still catches up
    }
  }

  private unwatch(projectId: string): void {
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
    clearTimeout(this.watchTimers.get(projectId));
    this.watchTimers.delete(projectId);
  }

  private forget(projectId: string): void {
    this.unwatch(projectId);
    clearTimeout(this.idleTimers.get(projectId));
    clearTimeout(this.maxTimers.get(projectId));
    this.idleTimers.delete(projectId);
    this.maxTimers.delete(projectId);
    this.lastState.delete(projectId);
    this.publishedMem.delete(projectId);
    this.gitFailed.delete(projectId);
    this.digestSeen.delete(projectId);
  }

  /** Bring one project's folder and cache in step, whichever moved. */
  async reconcile(projectId: string): Promise<void> {
    const entry = this.entry(projectId);
    if (!entry) return;
    if (!entry.dir) {
      await this.materialize(projectId);
      return;
    }
    if (!fs.existsSync(entry.dir)) return;
    if (!hasArtifact(entry.dir)) {
      await this.publish(projectId, "create");
    } else {
      await this.refresh(projectId);
      const status = await this.statusFor(projectId);
      if (status.state === "ahead" || this.gitFailed.has(projectId)) await this.publish(projectId, "catch-up");
      // A machine that never counted starts from a moment nothing is waiting.
      else if (status.state === "synced" && this.entry(projectId)?.syncedDeviceSeq === null) this.markSynced(projectId, this.ownTop(projectId));
    }
    this.watch(projectId);
  }

  async reconcileAll(reason: string): Promise<void> {
    for (const entry of this.hub.catalog.projects()) {
      if (this.closing) return;
      if (!(this.ctx.db as Db).has(entry.id)) continue;
      try {
        if (reason === "boot") await this.clearStaleLock(entry.id);
        await this.reconcile(entry.id);
      } catch (error) {
        this.home.logger.warn(`storage: ${entry.id} not reconciled (${reason}) — ${errorMessage(error)}`);
      }
    }
    if (!this.closing) await this.writeHub().catch((e) => this.home.logger.warn(`storage: hub manifest not written — ${errorMessage(e)}`));
  }

  /**
   * At launch, before any git of ours runs there: an `index.lock` a killed git
   * left would fail every commit. Only in a repository that is Tomrade's alone;
   * a code checkout's git is its owner's to sort out.
   */
  private clearStaleLock(projectId: string): Promise<void> {
    const entry = this.entry(projectId);
    if (!entry?.dir || entry.git !== "dedicated") return Promise.resolve();
    const dir = entry.dir;
    return this.inTurn(projectId, async () => {
      if (await clearStaleIndexLock(dir)) this.home.logger.warn(`storage: ${projectId}: removed a stale git index.lock`);
    });
  }

  // ── the Hub ──────────────────────────────────────────────────────────────────

  private scheduleHubWrite(): void {
    if (this.closing || !this.hub.dir) return;
    if (this.hubWriteTimer) clearTimeout(this.hubWriteTimer);
    this.hubWriteTimer = setTimeout(() => {
      this.hubWriteTimer = null;
      void this.writeHub().catch((e) => this.home.logger.warn(`storage: hub manifest not written — ${errorMessage(e)}`));
    }, 1_000);
    this.hubWriteTimer.unref?.();
  }

  /** The Hub folder's manifest, or why it cannot be read now; the Hub's status says so until it reads again. */
  private readHub(dir: string): { manifest: HubManifest | null; problem?: string } {
    let problem: string | null = null;
    let manifest: HubManifest | null = null;
    try {
      manifest = readHubManifest(dir);
    } catch (error) {
      problem = errorMessage(error);
    }
    if (problem !== this.hubUnreadable) {
      this.hubUnreadable = problem;
      this.home.get("ipc")?.send("hub.changed");
    }
    return problem ? { manifest: null, problem } : { manifest };
  }

  /**
   * What this machine knows, folded into the Hub's portable catalog, plus the
   * ignore list a Hub repository needs. A manifest that cannot be read is left
   * as it is: written over with this machine's projects alone, every other
   * machine's would be gone from the catalog.
   */
  async writeHub(): Promise<HubManifest | null> {
    const dir = this.hub.dir;
    if (!dir && !this.hubBackend) return null;
    const now = Date.now();
    let current = emptyHub();
    if (this.hubBackend) current = this.hubBackend.read();
    else if (dir) {
      const { manifest, problem } = this.readHub(dir);
      if (problem) return null;
      current = manifest ?? emptyHub();
    }
    const mine: HubManifest = { v: 1, projects: [], repos: [], removed: [...this.tombstones].map(([id, at]) => ({ id, at })) };
    const ignores = new Set<string>(["repos/", "worktrees/", "*.tmp", ".DS_Store"]);
    const ignore = (projectDir: string | null) => {
      if (this.hubBackend || !dir || !projectDir) return;
      const rel = path.relative(dir, projectDir);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) ignores.add(rel.split(path.sep).join("/") + "/");
    };
    for (const entry of this.hub.catalog.projects()) {
      // The sample is this machine's: a Hub repository must not carry it either.
      if (entry.sample) ignore(entry.dir);
      if (entry.sample || this.isPristineSeed(entry)) continue;
      let origin: { url: string | null; branch: string | null } | null = null;
      if (entry.dir && entry.git !== "none") {
        try {
          const g = this.git(entry.dir);
          origin = { url: await g.remoteUrl(), branch: await g.currentBranch() };
        } catch {
          origin = null;
        }
        // A project with a repository of its own inside the Hub folder is not the Hub repository's to track.
        if (entry.git === "dedicated") ignore(entry.dir);
      }
      mine.projects.push(hubProjectOf(entry, origin, current.projects.find((p) => p.id === entry.id)?.updatedAt ?? now));
    }
    for (const [remote, repo] of Object.entries(this.hub.catalog.repos())) {
      if (repo.checkout) mine.repos.push({ remote, name: path.basename(repo.checkout) });
    }
    // Projects the manifest knows but this machine does not are kept: they are what "attach all" offers.
    const merged = mergeHubManifests(current, mine);
    for (const p of merged.projects) {
      const fresh = mine.projects.find((m) => m.id === p.id);
      if (fresh) {
        if (JSON.stringify({ ...fresh, updatedAt: 0 }) !== JSON.stringify({ ...p, updatedAt: 0 })) Object.assign(p, fresh, { updatedAt: now });
      }
    }
    if (this.hubBackend) this.hubBackend.observe(mine);
    else if (dir) writeHubManifest(dir, merged);
    if (this.hubBackend || !dir) return merged;
    const ignoreFile = path.join(dir, ".gitignore");
    const body = ["# Written by Tomrade: projects with a repository of their own, the sample project, agent worktrees, cloned code.", ...[...ignores].sort(), ""].join("\n");
    try {
      if (fs.readFileSync(ignoreFile, "utf8") !== body) fs.writeFileSync(ignoreFile, body, "utf8");
    } catch {
      fs.writeFileSync(ignoreFile, body, "utf8");
    }
    return merged;
  }

  hubManifest(): HubManifest | null {
    if (this.hubBackend) return this.hubBackend.read();
    return this.hub.dir ? this.readHub(this.hub.dir).manifest : null;
  }

  async hubInfo(): Promise<{ dir: string | null; remote: RemoteRef | null; status: StorageStatus; manifest: HubManifest | null; attachable: string[] }> {
    const dir = this.hub.dir;
    const manifest = this.hubManifest();
    const attachable = (manifest?.projects ?? []).filter((p) => p.remote && !this.entry(p.id)).map((p) => p.id);
    return { dir, remote: this.hubBackend ? null : this.hub.remote, status: await this.hubStatus(), manifest, attachable };
  }

  private async hubRemote(): Promise<{ url: string; branch: string } | null> {
    const ref = this.hub.remote;
    if (!ref || !this.has(ref.provider)) return null;
    const provider = this.get(ref.provider);
    const target = await provider.toRemote(provider.configSchema.parse(ref.config));
    if (this.hub.dir) await this.cleanOrigin(this.hub.dir, target.url);
    return target;
  }

  async hubStatus(): Promise<StorageStatus> {
    if (this.hubBackend) return this.hubBackend.status();
    const dir = this.hub.dir;
    if (!dir) return LOCAL;
    if (!fs.existsSync(dir)) return { state: "unavailable", location: dir, detail: "Folder not found", lastSyncAt: null };
    if (this.hubUnreadable) return { state: "error", location: dir, detail: this.hubUnreadable, lastSyncAt: null };
    const remote = await this.hubRemote();
    if (!remote) return { state: "local", location: dir, lastSyncAt: null };
    const location = `${cleanRemote(remote.url).replace(/^https?:\/\//, "").replace(/\.git$/, "")} · ${remote.branch}`;
    try {
      const g = this.git(dir);
      const probe = await g.probe(remote.branch);
      if (probe === "offline") return { state: "offline", location, detail: `Cannot reach ${location}`, lastSyncAt: null };
      if (probe === "absent") return { state: "ahead", location, detail: "Nothing published yet", lastSyncAt: null };
      await g.fetch(remote.branch);
      const counts = await g.aheadBehind(remote.branch);
      const dirty = (await this.runGit(["status", "--porcelain"], { cwd: dir, ok: true })).stdout.trim().length > 0;
      if (counts && counts.ahead && counts.behind) return { state: "diverged", location, detail: `${counts.ahead} local, ${counts.behind} remote commits`, lastSyncAt: null };
      if (counts?.behind) return { state: dirty ? "diverged" : "behind", location, detail: `${counts.behind} commits behind`, lastSyncAt: null };
      if (counts?.ahead || dirty) return { state: "ahead", location, lastSyncAt: null };
      return { state: "synced", location, lastSyncAt: null };
    } catch (error) {
      return { state: error instanceof GitMissingError ? "unavailable" : "error", location, detail: errorMessage(error), lastSyncAt: null };
    }
  }

  /** Make the Hub folder a repository of Tomrade's own and give it a remote. */
  async bindHub(providerId: string, rawConfig: unknown): Promise<StorageStatus> {
    if (this.hubBackend) throw new Error("This Hub syncs through your account; its legacy Git binding is inactive.");
    const dir = this.hub.dir;
    if (!dir) throw new HubUnconfiguredError();
    const provider = this.get(providerId);
    const config = provider.configSchema.parse(rawConfig) as Record<string, unknown>;
    const target = await provider.toRemote(config);
    const g = this.git(dir);
    const top = await g.toplevel();
    if (top && top !== fs.realpathSync(dir)) throw new SharedCheckoutError(dir);
    if (!top) await g.init(target.branch);
    await provider.ensureRemote?.(config);
    await g.setRemote(target.url);
    this.hub.patchState({ remote: { provider: providerId, config } });
    return this.syncHub();
  }

  async unbindHub(): Promise<void> {
    if (this.hubBackend) throw new Error("This Hub syncs through your account.");
    const dir = this.hub.dir;
    if (dir) await bestEffort(this.git(dir).removeRemote(), this.home.logger, "removing the Hub's remote");
    this.hub.patchState({ remote: null });
    this.home.get("ipc")?.send("hub.changed");
  }

  /** Bring the remote's Hub in (merging the catalog and settings by their own rules), then push ours. */
  async syncHub(): Promise<StorageStatus> {
    if (this.hubBackend) { await this.writeHub(); return this.hubBackend.sync(); }
    const dir = this.hub.dir;
    if (!dir) return LOCAL;
    await this.writeHub();
    // A manifest that cannot be read is not committed or pushed either; the status says why.
    if (this.hubUnreadable) return this.hubStatus();
    const remote = await this.hubRemote();
    if (!remote) return this.hubStatus();
    const g = this.git(dir);
    await g.commit("tomrade: hub");
    const probe = await g.probe(remote.branch);
    if (probe === "exists" && (await g.fetch(remote.branch))) {
      const counts = await g.aheadBehind(remote.branch);
      if (counts && counts.behind > 0) {
        if (counts.ahead === 0) await g.fastForward(remote.branch);
        else await this.mergeHub(g, remote.branch);
        this.afterHubPull(dir);
        await this.writeHub();
        await g.commit("tomrade: hub");
      }
    }
    if (probe !== "offline") await g.push(remote.branch);
    this.home.get("ipc")?.send("hub.changed");
    void this.restoreMissing();
    return this.hubStatus();
  }

  /** Both moved: git merges the files; the catalog and the settings are re-derived rather than left with markers. */
  private async mergeHub(g: GitFolder, branch: string): Promise<void> {
    const dir = g.dir;
    const theirManifestText = await g.show(`origin/${branch}`, HUB_MANIFEST);
    const theirSettingsText = await g.show(`origin/${branch}`, "settings.json");
    const oursText = await g.show("HEAD", HUB_MANIFEST);
    await this.runGit(["merge", "-q", "--no-commit", "--allow-unrelated-histories", `origin/${branch}`], { cwd: dir, ok: true });
    const conflicted = (await this.runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: dir, ok: true })).stdout.split("\n").filter(Boolean);
    const ours = oursText ? (JSON.parse(oursText) as HubManifest) : null;
    for (const file of conflicted) {
      const full = path.join(dir, file);
      if (file === HUB_MANIFEST) {
        const theirs = theirManifestText ? (JSON.parse(theirManifestText) as HubManifest) : emptyHub();
        writeHubManifest(dir, mergeHubManifests(ours ?? emptyHub(), theirs));
      } else if (file === "settings.json") {
        await this.runGit(["checkout", "--ours", "--", file], { cwd: dir, ok: true });
      } else {
        // Ours stands; theirs is kept beside it for the person to look at.
        const theirs = await g.show(`origin/${branch}`, file);
        await this.runGit(["checkout", "--ours", "--", file], { cwd: dir, ok: true });
        if (theirs !== null) fs.writeFileSync(`${full}.conflict-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}`, theirs, "utf8");
      }
    }
    if (theirSettingsText) this.mergeUserSettings(theirSettingsText);
    await this.runGit(["add", "-A"], { cwd: dir });
  }

  /** After the remote's files landed: the settings that arrived are folded in by their stamps, the catalog re-read. */
  private afterHubPull(dir: string): void {
    const file = path.join(dir, "settings.json");
    if (fs.existsSync(file)) this.mergeUserSettings(fs.readFileSync(file, "utf8"));
    this.home.emit("hub/configured", dir);
  }

  private mergeUserSettings(text: string): void {
    const settings = this.home.get("settings");
    if (!settings) return;
    try {
      settings.mergeUser(JSON.parse(text));
    } catch {
      // not ours to parse
    }
  }

  /** Bring back, now, every project the Hub's catalog names and this machine lacks; resolves with their ids. */
  attachAll(): Promise<string[]> {
    this.restorer.scan();
    this.restorer.retry(() => true);
    return this.restorer.run();
  }

  /**
   * Write out every project at once; what the quit path calls. Nothing asks a
   * remote for its status or news, so a quit with nothing to push stays local.
   * A publish already under way finishes first: the two never meet in git.
   */
  async flushAll(reason = "quit"): Promise<void> {
    const ids = this.hub.catalog
      .projects()
      .filter((entry) => entry.dir && (this.ctx.db as Db).has(entry.id))
      .map((entry) => entry.id);
    await Promise.all(
      ids.map((id) => this.inTurn(id, () => this.writeOut(id, reason, { leaving: true })).catch((error) => this.home.logger.warn(`storage: ${id} not published — ${errorMessage(error)}`)))
    );
  }
}
