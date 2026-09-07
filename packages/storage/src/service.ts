import fs from "node:fs";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { Db, ProjectDb } from "@tomrade/db";
import type { CatalogProject, Hub, RemoteRef } from "@tomrade/hub";
import type {} from "@tomrade/settings";
import type { Oplog } from "@tomrade/oplog";
import type {} from "@tomrade/contributions";
import type {} from "@tomrade/ipc";
import type {} from "@tomrade/projects";
import type {} from "@tomrade/write";
import type {} from "./channels.js";
import { GitFolder, GitMissingError, cleanRemote, cloneInto, gitRunner, type Git } from "./git.js";
import { HUB_MANIFEST, emptyHub, hubProjectOf, mergeHubManifests, readHubManifest, writeHubManifest, type HubManifest } from "./hub.js";
import { LOG_DIR, appendLog, compactLog, parseLog, parseOpId, readLogs, toLine, type DeviceLog, type LogLine } from "./log.js";
import { CORE_RULES, mergeStates, type ConflictNote, type LogOp, type MergeState, type Renumbered, type TableRule } from "./merge.js";
import {
  ARTIFACT_DIR,
  ConflictMarkersError,
  DEFAULT_LOG_WINDOW_DAYS,
  TornArtifactError,
  digestState,
  exportState,
  hasArtifact,
  importState,
  parseArtifact,
  primaryKeyOf,
  projectIdOf,
  readArtifact,
  serializeState,
  writeArtifact,
  type ProjectState
} from "./state.js";
import {
  ForeignProjectError,
  HubUnconfiguredError,
  SharedCheckoutError,
  UnknownProviderError,
  type ConnectionState,
  type GitOrigin,
  type StorageInfo,
  type StorageProvider,
  type StorageProviderView,
  type StorageStatus,
  type SyncState
} from "./types.js";

declare module "cordis" {
  interface Context {
    storage: Storage;
  }
  interface Events {
    "storage/registered"(providerId: string): void;
    "storage/unregistered"(providerId: string): void;
    "storage/synced"(projectId: string, status: StorageStatus): void;
    /** The folder's copy replaced the local rows; caches for this project are stale. */
    "storage/imported"(projectId: string): void;
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
    reconcileMs: z.number().int().min(0).default(300_000)
  })
);
export type StorageConfig = z.infer<typeof StorageConfig>;

const LOCAL: StorageStatus = { state: "local", location: null, lastSyncAt: null };
const DAY = 86_400_000;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
export class Storage extends Service {
  static provide = "storage";
  static inject = ["db", "hub", "oplog"];
  static Config = StorageConfig;

  /** Resolves when the boot reconcile has run; tests await it. */
  ready: Promise<void> = Promise.resolve();

  private registry = new Map<string, StorageProvider>();
  private watchers = new Map<string, fs.FSWatcher>();
  private watchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private maxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** After our own write the watcher hears an echo; ignore events until then. */
  private quietUntil = new Map<string, number>();
  private publishing = new Set<string>();
  private lastState = new Map<string, SyncState>();
  /** Base snapshots for projects whose cache is in memory (tests). */
  private publishedMem = new Map<string, ProjectState>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private hubWriteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Projects removed on purpose on this machine; the Hub's catalog must not bring them back. */
  private tombstones = new Map<string, number>();
  private closing = false;
  private readonly home: Context;
  private readonly runGit: Git;

  constructor(
    ctx: Context,
    public readonly config: StorageConfig
  ) {
    super(ctx, "storage");
    this.home = ctx;
    this.runGit = gitRunner(config.gitBinary);
  }

  [Service.init]() {
    this.home.on("write/committed", (intent) => this.onCommitted(intent.projectId));
    this.home.on("projects/created", (project) => void this.materialize(project.id).catch((e) => this.warn(project.id, e)));
    this.home.on("projects/removed", (projectId) => {
      this.forget(projectId);
      this.tombstones.set(projectId, Date.now());
      this.scheduleHubWrite();
    });
    this.home.on("hub/configured", () => void this.reconcileAll("configured"));

    if (this.config.reconcileMs > 0) {
      this.reconcileTimer = setInterval(() => void this.reconcileAll("reconcile"), this.config.reconcileMs);
      this.reconcileTimer.unref?.();
    }

    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("storage.providers", () => ctx.storage.describe());
      ctx.ipc.handle("storage.info", (projectId) => ctx.storage.info(projectId));
      ctx.ipc.handle("storage.status", (projectId) => ctx.storage.statusFor(projectId));
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
      ctx.ipc.handle("storage.disconnect", (providerId) => ctx.storage.disconnect(providerId));
      ctx.ipc.handle("storage.hubInfo", () => ctx.storage.hubInfo());
      ctx.ipc.handle("storage.hubBind", (providerId, config) => ctx.storage.bindHub(providerId, config));
      ctx.ipc.handle("storage.hubUnbind", () => ctx.storage.unbindHub());
      ctx.ipc.handle("storage.hubSync", () => ctx.storage.syncHub());
      ctx.ipc.handle("storage.hubAttachAll", () => ctx.storage.attachAll());
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
          return state === "synced" ? where : `${where} · ${state}`;
        }
      });
    });

    this.ready = this.reconcileAll("boot");

    return () => {
      this.closing = true;
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
    this.home.logger.warn(`storage: ${projectId}: ${message(error)}`);
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
    return (this.ctx.get("mcp") as { url?: string | null } | undefined)?.url ?? null;
  }

  private mcpUrl(projectId: string): string | null {
    const base = this.mcpBase;
    return base ? `${base}/${projectId}` : null;
  }

  private quiet(projectId: string, ms = 1_500): void {
    this.quietUntil.set(projectId, Date.now() + ms);
  }

  private notify(projectId: string): void {
    const ipc = this.home.get("ipc");
    ipc?.send("storage.changed", projectId);
  }

  private remember(projectId: string, status: StorageStatus): StorageStatus {
    this.lastState.set(projectId, status.state);
    return status;
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
    return provider.connection ? provider.connection.status() : { connected: true };
  }

  async connect(providerId: string, secret: string): Promise<ConnectionState> {
    const provider = this.get(providerId);
    return provider.connection ? provider.connection.connect(secret) : { connected: true };
  }

  async disconnect(providerId: string): Promise<void> {
    await this.get(providerId).connection?.disconnect();
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

  private exportable(): { namespace: string; tables: string[] }[] {
    return (this.ctx.db as Db)
      .registrations("project")
      .map((r) => ({ namespace: r.namespace, tables: Object.entries(r.tables).filter(([, s]) => s.export).map(([t]) => t) }))
      .filter((e) => e.tables.length)
      .sort((a, b) => a.namespace.localeCompare(b.namespace));
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
    return exportState(this.db(projectId), projectId, {
      registrations: (this.ctx.db as Db).registrations("project"),
      exports: entry.exports,
      repo: entry.git === "dedicated" ? "dedicated" : undefined,
      checkpoint: this.checkpointOf(projectId),
      at
    });
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
      return readArtifact(dir);
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
    const first = this.entry(projectId);
    if (!first?.dir) return this.remember(projectId, LOCAL);
    const dir = first.dir;
    if (!fs.existsSync(dir)) return this.statusFor(projectId);
    this.appendTail(projectId);
    // Someone else's change may be sitting in the folder; take it (merging if
    // need be) before writing over it.
    if (hasArtifact(dir) && reason !== "merge") {
      const { state: onDisk, problem } = this.readFolder(dir);
      if (problem?.state === "syncing") return this.statusFor(projectId);
      if (onDisk && (onDisk.manifest.snapshot?.digest ?? digestState(onDisk)) !== first.lastPublishedDigest) await this.refresh(projectId);
    }
    const entry = this.mustEntry(projectId);
    const now = Date.now();
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
      }
      const counts = Object.entries(state.tables).filter(([, rows]) => rows.length);
      const summary = `tomrade: ${reason} — ${counts.map(([t, rows]) => `${rows.length} ${t}`).join(", ") || "empty project"}`;
      if (entry.git === "dedicated") await this.pushDedicated(projectId, entry, summary);
      else if (entry.git === "shared" && entry.autoCommit) await this.git(dir).commit(summary, ARTIFACT_DIR);
    } finally {
      this.publishing.delete(projectId);
      this.quiet(projectId);
    }
    const status = await this.statusFor(projectId);
    this.home.emit("storage/synced", projectId, status);
    this.notify(projectId);
    return status;
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
  private async pushDedicated(projectId: string, entry: CatalogProject, summary: string): Promise<void> {
    const g = this.git(entry.dir!);
    await g.commit(summary);
    const remote = await this.remoteOf(entry);
    if (!remote) return;
    const probe = await g.probe(remote.branch);
    if (probe === "offline") return; // the commit waits
    if (probe === "exists") await g.fetch(remote.branch);
    const counts = probe === "exists" ? await g.aheadBehind(remote.branch) : null;
    if (counts && counts.behind > 0) {
      if (counts.ahead === 0) {
        await g.fastForward(remote.branch);
        await this.takeFolder(projectId);
      } else {
        await this.mergeRemote(projectId, this.mustEntry(projectId), g, remote.branch);
      }
    }
    await g.push(remote.branch);
  }

  private async remoteOf(entry: CatalogProject): Promise<{ url: string; branch: string } | null> {
    if (!entry.remote || !this.has(entry.remote.provider)) return null;
    const provider = this.get(entry.remote.provider);
    return provider.toRemote(provider.configSchema.parse(entry.remote.config));
  }

  // ── reading the folder back ──────────────────────────────────────────────────

  /** Read the folder; a torn or conflicted artifact is reported as a status, not thrown. */
  private readFolder(dir: string): { state: ProjectState | null; problem?: { state: SyncState; detail: string } } {
    try {
      return { state: readArtifact(dir) };
    } catch (error) {
      if (error instanceof TornArtifactError) return { state: null, problem: { state: "syncing", detail: "The folder is still being written or synced" } };
      if (error instanceof ConflictMarkersError) return { state: null, problem: { state: "error", detail: error.message } };
      return { state: null, problem: { state: "error", detail: message(error) } };
    }
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

  /** Replace the cache with the folder's state and remember it as the base. */
  private async takeFolder(projectId: string): Promise<boolean> {
    const entry = this.mustEntry(projectId);
    if (!entry.dir) return false;
    const { state } = this.readFolder(entry.dir);
    if (!state) return false;
    if (projectIdOf(state) !== projectId) throw new ForeignProjectError(projectId, projectIdOf(state));
    this.importInto(projectId, entry, state);
    return true;
  }

  private importInto(projectId: string, entry: CatalogProject, state: ProjectState): void {
    importState(this.db(projectId), state, { registrations: (this.ctx.db as Db).registrations("project") });
    if (entry.dir) this.importForeignLogs(projectId, entry.dir);
    this.savePublished(projectId, state);
    const digest = state.manifest.snapshot?.digest ?? digestState(state);
    const patch: Partial<CatalogProject> = { lastPublishedDigest: digest, lastSyncAt: Date.now(), name: String(state.manifest.project.name ?? entry.name), keyPrefix: String(state.manifest.project.key_prefix ?? entry.keyPrefix) };
    if (state.manifest.exports) patch.exports = state.manifest.exports;
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
    const entry = this.entry(projectId);
    if (!entry?.dir) return this.remember(projectId, LOCAL);
    if (!fs.existsSync(entry.dir)) return this.statusFor(projectId);
    if (entry.git === "dedicated") {
      const remote = await this.remoteOf(entry);
      if (remote) {
        const g = this.git(entry.dir);
        if ((await g.probe(remote.branch)) === "exists" && (await g.fetch(remote.branch))) {
          const counts = await g.aheadBehind(remote.branch);
          if (counts && counts.behind > 0 && counts.ahead === 0) await g.fastForward(remote.branch);
          else if (counts && counts.behind > 0) {
            await this.mergeRemote(projectId, entry, g, remote.branch);
            return this.statusFor(projectId);
          }
        }
      }
    }
    const { state } = this.readFolder(entry.dir);
    if (!state) return this.statusFor(projectId);
    if (projectIdOf(state) !== projectId) throw new ForeignProjectError(projectId, projectIdOf(state));
    const onDisk = state.manifest.snapshot?.digest ?? digestState(state);
    if (onDisk === entry.lastPublishedDigest) return this.statusFor(projectId);
    const local = digestState(this.exportFor(projectId, entry));
    if (local === entry.lastPublishedDigest) this.importInto(projectId, entry, state);
    else this.mergeWith(projectId, entry, this.loadPublished(projectId), state, readLogs(entry.dir));
    return this.statusFor(projectId);
  }

  // ── merging ──────────────────────────────────────────────────────────────────

  /** Both we and the remote committed: settle it with the merge-base as the base, and record a merge commit. */
  private async mergeRemote(projectId: string, entry: CatalogProject, g: GitFolder, branch: string): Promise<void> {
    const dir = entry.dir!;
    const baseCommit = await g.mergeBase(branch);
    const base = baseCommit ? parseArtifact(await g.filesAt(baseCommit, ARTIFACT_DIR), `${baseCommit}`) : this.loadPublished(projectId);
    const theirs = parseArtifact(await g.filesAt(`origin/${branch}`, ARTIFACT_DIR), `origin/${branch}`);
    if (!theirs) {
      // The remote has commits but no project — a README from "initialize this
      // repository", say. Join the histories, keep their files, carry ours over.
      await g.beginMerge(branch);
      await this.publish(projectId, "merge");
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
    await this.publish(projectId, "merge");
  }

  /**
   * Three-way merge of the cache (ours) with the folder or remote (theirs) over
   * the last common state, settled field by field with the logs as referee;
   * the result replaces the cache, every contested field leaves a note.
   */
  private mergeWith(projectId: string, entry: CatalogProject, base: ProjectState | null, theirs: ProjectState, theirLogs: DeviceLog[]): void {
    const own = this.hub.deviceId;
    const ours = this.exportFor(projectId, entry);
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
    for (const reg of (this.ctx.db as Db).registrations("project")) {
      for (const [table, spec] of Object.entries(reg.tables)) {
        if (!spec.export) continue;
        let key = ["id"];
        try {
          key = primaryKeyOf(db, table);
        } catch {
          // the table is not in this file; the rows merge by id
        }
        rules[`${reg.namespace}/${table}`] = { key, mode: spec.export.appendOnly ? "append" : "rows" };
      }
    }
    const result = mergeStates({ base: base ? this.toMergeState(base) : null, ours: this.toMergeState(ours), theirs: this.toMergeState(theirs), logs: { ours: ourOps, theirs: theirOps }, rules });
    const merged = this.fromMergeState(result.merged, ours, theirs);
    this.importInto(projectId, entry, merged);
    this.noteConflicts(projectId, result.conflicts, result.renumbered);
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

    let location = entry.dir;
    let transport: { state: SyncState; detail?: string } = { state: "synced" };
    if (entry.git === "dedicated") {
      try {
        const remote = await this.remoteOf(entry);
        if (remote) {
          location = `${cleanRemote(remote.url).replace(/^https?:\/\//, "").replace(/\.git$/, "")} · ${remote.branch}`;
          const g = this.git(entry.dir);
          const probe = await g.probe(remote.branch);
          if (probe === "offline") transport = { state: "offline", detail: `Cannot reach ${location}` };
          else if (probe === "absent") transport = { state: "ahead", detail: "Nothing published yet" };
          else {
            await g.fetch(remote.branch);
            const counts = await g.aheadBehind(remote.branch);
            if (counts && counts.ahead && counts.behind) transport = { state: "diverged", detail: `${counts.ahead} local, ${counts.behind} remote commits` };
            else if (counts?.behind) transport = { state: "behind", detail: `${counts.behind} commits behind` };
            else if (counts?.ahead) transport = { state: "ahead", detail: `${counts.ahead} commits to push` };
          }
        }
      } catch (error) {
        return this.remember(projectId, { state: error instanceof GitMissingError ? "unavailable" : "error", location, detail: message(error), lastSyncAt: entry.lastSyncAt });
      }
    }

    const { state: onDisk, problem } = this.readFolder(entry.dir);
    if (problem) return this.remember(projectId, { ...problem, location, lastSyncAt: entry.lastSyncAt });
    let localDirty = false;
    try {
      localDirty = digestState(this.exportFor(projectId, entry)) !== entry.lastPublishedDigest;
    } catch (error) {
      return this.remember(projectId, { state: "error", location, detail: message(error), lastSyncAt: entry.lastSyncAt });
    }
    const folderMoved = onDisk !== null && (onDisk.manifest.snapshot?.digest ?? digestState(onDisk)) !== entry.lastPublishedDigest;
    let state: SyncState = localDirty && folderMoved ? "diverged" : localDirty ? "ahead" : folderMoved ? "behind" : transport.state;
    if (transport.state === "diverged" || (transport.state === "behind" && state === "ahead") || (transport.state === "ahead" && state === "behind")) state = "diverged";
    return this.remember(projectId, { state, location, detail: transport.detail, lastSyncAt: entry.lastSyncAt });
  }

  // ── placement ────────────────────────────────────────────────────────────────

  /** Point the project at another folder. The old one is left as it is. */
  async setFolder(projectId: string, rawDir: string): Promise<StorageInfo> {
    const entry = this.mustEntry(projectId);
    const dir = path.resolve(rawDir);
    if (entry.dir && path.resolve(entry.dir) === dir) return this.info(projectId);
    if (hasArtifact(dir)) {
      const { state, problem } = this.readFolder(dir);
      if (problem) throw new Error(problem.detail);
      if (state && projectIdOf(state) !== projectId) throw new ForeignProjectError(projectId, projectIdOf(state));
    }
    fs.mkdirSync(dir, { recursive: true });
    this.unwatch(projectId);
    const marked = hasArtifact(dir) ? this.readFolder(dir).state?.manifest.repo === "dedicated" : entry.git === "dedicated";
    const git = await this.detectOrigin(dir, marked);
    this.hub.catalog.patchProject(projectId, { dir, git, exports: git === "shared" ? [] : entry.exports });
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
    this.mustEntry(projectId);
    const known = new Set(this.exportable().map((e) => e.namespace));
    this.hub.catalog.patchProject(projectId, { exports: [...new Set(namespaces)].filter((n) => known.has(n)).sort() });
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
    this.hub.catalog.patchProject(projectId, { git: "dedicated", remote: { provider: providerId, config } });
    this.scheduleHubWrite();
    // The remote may already hold this project (a second machine binding to the same repository).
    if ((await g.probe(target.branch)) === "exists" && (await g.fetch(target.branch))) {
      const counts = await g.aheadBehind(target.branch);
      if (counts && counts.behind > 0 && counts.ahead === 0) {
        await g.fastForward(target.branch);
        if (hasArtifact(entry.dir)) {
          const { state } = this.readFolder(entry.dir);
          if (state && projectIdOf(state) !== projectId) {
            this.hub.catalog.patchProject(projectId, { remote: null });
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
    if (entry.dir && entry.git === "dedicated") await this.git(entry.dir).removeRemote().catch(() => {});
    this.hub.catalog.patchProject(projectId, { remote: null });
    this.lastState.delete(projectId);
    this.scheduleHubWrite();
    this.notify(projectId);
    return this.info(projectId);
  }

  // ── bringing projects in ─────────────────────────────────────────────────────

  /** Open a folder holding a project this machine does not know. */
  async attach(rawDir: string): Promise<string> {
    const dir = path.resolve(rawDir);
    const state = readArtifact(dir);
    if (!state) throw new Error(`${dir} holds no Tomrade project`);
    const projectId = projectIdOf(state);
    if (this.entry(projectId)) throw new Error(`Project ${projectId} is already on this machine`);
    const db = (this.ctx.db as Db).open(projectId);
    importState(db, state, { registrations: (this.ctx.db as Db).registrations("project") });
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
      lastSyncAt: Date.now()
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
    const name = cleanRemote(target.url).replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "project";
    const dir = this.folderFor(name);
    await cloneInto(this.runGit, target.url, target.branch, dir);
    if (!hasArtifact(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`${cleanRemote(target.url)} holds no Tomrade project on ${target.branch}`);
    }
    const projectId = await this.attach(dir);
    this.hub.catalog.patchProject(projectId, { git: "dedicated", remote: { provider: providerId, config } });
    this.scheduleHubWrite();
    return projectId;
  }

  /** Drop the cache and read the folder again — the folder is the truth, so nothing is lost but the window's undo. */
  async rebuild(projectId: string): Promise<StorageStatus> {
    const entry = this.mustEntry(projectId);
    if (!entry.dir || !hasArtifact(entry.dir)) throw new Error("The project's folder holds no snapshot to rebuild from");
    const state = readArtifact(entry.dir);
    if (!state) throw new Error("The project's folder holds no snapshot to rebuild from");
    if (projectIdOf(state) !== projectId) throw new ForeignProjectError(projectId, projectIdOf(state));
    this.unwatch(projectId);
    const pool = this.ctx.db as Db;
    pool.remove(projectId);
    const db = pool.open(projectId);
    importState(db, state, { registrations: pool.registrations("project") });
    // Every machine's log, this one's included: history comes back without snapshots, as evidence.
    for (const log of readLogs(entry.dir)) this.oplog.importForeign(projectId, log.ops.flatMap((op) => this.foreignOp(op)), { includeOwn: true });
    this.savePublished(projectId, state);
    const last = db.prepare("SELECT MAX(seq) AS m FROM oplog").get() as { m: number | null };
    this.hub.catalog.patchProject(projectId, { lastPublishedDigest: state.manifest.snapshot?.digest ?? digestState(state), lastSyncAt: Date.now(), lastLoggedSeq: last.m ?? 0 });
    this.watch(projectId);
    this.home.emit("storage/imported", projectId);
    this.home.emit("projects/changed", projectId);
    this.notify(projectId);
    return this.statusFor(projectId);
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
      if (status.state === "ahead") await this.publish(projectId, "catch-up");
    }
    this.watch(projectId);
  }

  async reconcileAll(reason: string): Promise<void> {
    for (const entry of this.hub.catalog.projects()) {
      if (this.closing) return;
      if (!(this.ctx.db as Db).has(entry.id)) continue;
      try {
        await this.reconcile(entry.id);
      } catch (error) {
        this.home.logger.warn(`storage: ${entry.id} not reconciled (${reason}) — ${message(error)}`);
      }
    }
    if (!this.closing) await this.writeHub().catch((e) => this.home.logger.warn(`storage: hub manifest not written — ${message(e)}`));
  }

  // ── the Hub ──────────────────────────────────────────────────────────────────

  private scheduleHubWrite(): void {
    if (this.closing || !this.hub.dir) return;
    if (this.hubWriteTimer) clearTimeout(this.hubWriteTimer);
    this.hubWriteTimer = setTimeout(() => {
      this.hubWriteTimer = null;
      void this.writeHub().catch((e) => this.home.logger.warn(`storage: hub manifest not written — ${message(e)}`));
    }, 1_000);
    this.hubWriteTimer.unref?.();
  }

  /** What this machine knows, folded into the Hub's portable catalog, plus the ignore list a Hub repository needs. */
  async writeHub(): Promise<HubManifest | null> {
    const dir = this.hub.dir;
    if (!dir) return null;
    const now = Date.now();
    const current = readHubManifest(dir) ?? emptyHub();
    const mine: HubManifest = { v: 1, projects: [], repos: [], removed: [...this.tombstones].map(([id, at]) => ({ id, at })) };
    const ignores = new Set<string>(["repos/", "worktrees/", "*.tmp", ".DS_Store"]);
    for (const entry of this.hub.catalog.projects()) {
      let origin: { url: string | null; branch: string | null } | null = null;
      if (entry.dir && entry.git !== "none") {
        try {
          const g = this.git(entry.dir);
          origin = { url: await g.remoteUrl(), branch: await g.currentBranch() };
        } catch {
          origin = null;
        }
        // A project with a repository of its own inside the Hub folder is not the Hub repository's to track.
        if (entry.git === "dedicated") {
          const rel = path.relative(dir, entry.dir);
          if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) ignores.add(rel.split(path.sep).join("/") + "/");
        }
      }
      mine.projects.push(hubProjectOf(entry, origin, current.projects.find((p) => p.id === entry.id)?.updatedAt ?? now));
    }
    for (const [remote, repo] of Object.entries(this.hub.catalog.repos())) {
      if (repo.checkout) mine.repos.push({ remote, name: path.basename(repo.checkout) });
    }
    // Projects the manifest knows but this machine does not are kept: they are what "attach all" offers.
    const merged = mergeHubManifests(current, mine);
    for (const p of merged.projects) {
      const entry = this.hub.catalog.project(p.id);
      if (entry) {
        const fresh = mine.projects.find((m) => m.id === p.id)!;
        if (JSON.stringify({ ...fresh, updatedAt: 0 }) !== JSON.stringify({ ...p, updatedAt: 0 })) Object.assign(p, fresh, { updatedAt: now });
      }
    }
    writeHubManifest(dir, merged);
    const ignoreFile = path.join(dir, ".gitignore");
    const body = ["# Written by Tomrade: projects with a repository of their own, agent worktrees, cloned code.", ...[...ignores].sort(), ""].join("\n");
    try {
      if (fs.readFileSync(ignoreFile, "utf8") !== body) fs.writeFileSync(ignoreFile, body, "utf8");
    } catch {
      fs.writeFileSync(ignoreFile, body, "utf8");
    }
    return merged;
  }

  hubManifest(): HubManifest | null {
    return this.hub.dir ? readHubManifest(this.hub.dir) : null;
  }

  async hubInfo(): Promise<{ dir: string | null; remote: RemoteRef | null; status: StorageStatus; manifest: HubManifest | null; attachable: string[] }> {
    const dir = this.hub.dir;
    const manifest = this.hubManifest();
    const attachable = (manifest?.projects ?? []).filter((p) => p.remote && !this.entry(p.id)).map((p) => p.id);
    return { dir, remote: this.hub.remote, status: await this.hubStatus(), manifest, attachable };
  }

  private async hubRemote(): Promise<{ url: string; branch: string } | null> {
    const ref = this.hub.remote;
    if (!ref || !this.has(ref.provider)) return null;
    const provider = this.get(ref.provider);
    return provider.toRemote(provider.configSchema.parse(ref.config));
  }

  async hubStatus(): Promise<StorageStatus> {
    const dir = this.hub.dir;
    if (!dir) return LOCAL;
    if (!fs.existsSync(dir)) return { state: "unavailable", location: dir, detail: "Folder not found", lastSyncAt: null };
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
      return { state: error instanceof GitMissingError ? "unavailable" : "error", location, detail: message(error), lastSyncAt: null };
    }
  }

  /** Make the Hub folder a repository of Tomrade's own and give it a remote. */
  async bindHub(providerId: string, rawConfig: unknown): Promise<StorageStatus> {
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
    const dir = this.hub.dir;
    if (dir) await this.git(dir).removeRemote().catch(() => {});
    this.hub.patchState({ remote: null });
    this.home.get("ipc")?.send("hub.changed");
  }

  /** Bring the remote's Hub in (merging the catalog and settings by their own rules), then push ours. */
  async syncHub(): Promise<StorageStatus> {
    const dir = this.hub.dir;
    if (!dir) return LOCAL;
    await this.writeHub();
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
    const settings = this.home.get("settings") as { mergeUser(theirs: unknown): void } | undefined;
    if (!settings) return;
    try {
      settings.mergeUser(JSON.parse(text));
    } catch {
      // not ours to parse
    }
  }

  /** Clone every project the Hub's catalog knows and this machine does not. */
  async attachAll(): Promise<string[]> {
    const manifest = this.hubManifest();
    if (!manifest) return [];
    const attached: string[] = [];
    for (const p of manifest.projects) {
      if (!p.remote || this.entry(p.id) || !this.has(p.remote.provider)) continue;
      try {
        attached.push(await this.attachRemote(p.remote.provider, p.remote.config));
      } catch (error) {
        this.home.logger.warn(`storage: ${p.name} (${p.id}) not attached — ${message(error)}`);
      }
    }
    return attached;
  }

  /** Publish every project with something to publish; what the quit path calls. */
  async flushAll(reason = "quit"): Promise<void> {
    for (const entry of this.hub.catalog.projects()) {
      if (!entry.dir || !(this.ctx.db as Db).has(entry.id)) continue;
      try {
        await this.publish(entry.id, reason);
      } catch (error) {
        this.home.logger.warn(`storage: ${entry.id} not published — ${message(error)}`);
      }
    }
  }
}

export default Storage;
