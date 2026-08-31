import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { Db } from "@tomrade/db";
import type {} from "@tomrade/contributions";
import type {} from "@tomrade/ipc";
import type {} from "@tomrade/write";
import type {} from "./channels.js";
import { Bindings, type StorageBinding } from "./bindings.js";
import { folderProvider } from "./providers/folder.js";
import { ARTIFACT_DIR, digestState, exportState, importState, projectIdOf, readArtifact, writeArtifact, type ProjectState } from "./state.js";
import { DivergedError, ForeignProjectError, UnknownProviderError, type ConnectionState, type StorageHandle, type StorageProvider, type StorageProviderView, type StorageStatus } from "./types.js";

declare module "cordis" {
  interface Context {
    storage: Storage;
  }
  interface Events {
    "storage/registered"(providerId: string): void;
    "storage/unregistered"(providerId: string): void;
    "storage/synced"(projectId: string, status: StorageStatus): void;
    /** The destination's copy replaced the local rows; caches for this project are stale. */
    "storage/imported"(projectId: string): void;
  }
}

export const StorageConfig = z.object({
  /** Machine-local bindings file. Never synced, never committed. */
  path: z.string(),
  /** Quiet period after a write before publishing. Long on purpose: a push is not on the write path. */
  debounceMs: z.number().int().min(0).default(30_000),
  /** Backstop sweep, because three mutations still bypass `write/committed`. */
  reconcileMs: z.number().int().min(0).default(300_000)
});
export type StorageConfig = z.infer<typeof StorageConfig>;

const LOCAL: StorageStatus = { state: "local", location: null, lastSyncAt: null };

export class Storage extends Service {
  static provide = "storage";
  static inject = ["db"];
  static Config = StorageConfig;

  private registry = new Map<string, StorageProvider>();
  private handles = new Map<string, StorageHandle>();
  private unwatch = new Map<string, () => void>();
  private bindings!: Bindings;
  /** Projects mid-publish: their own artifact write must not look like a teammate's. */
  private publishing = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  constructor(
    ctx: Context,
    public readonly config: StorageConfig
  ) {
    super(ctx, "storage");
  }

  [Service.init]() {
    this.bindings = new Bindings(this.config.path);
    this.register(folderProvider);

    // WriteIntent carries no projectId yet, and setRank/addRelation/moveItems
    // bypass write() entirely — so any commit schedules a sweep and the digest
    // decides what actually needs publishing. A false alarm costs one export.
    this.ctx.on("write/committed", () => this.schedule());
    if (this.config.reconcileMs > 0) {
      this.reconcileTimer = setInterval(() => void this.flushAll("reconcile"), this.config.reconcileMs);
      this.reconcileTimer.unref?.();
    }

    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("storage.providers", () => ctx.storage.describe());
      ctx.ipc.handle("storage.status", (projectId) => ctx.storage.statusFor(projectId));
      ctx.ipc.handle("storage.binding", (projectId) => ctx.storage.binding(projectId));
      ctx.ipc.handle("storage.bind", (projectId, providerId, config) => ctx.storage.bind(projectId, providerId, config));
      ctx.ipc.handle("storage.unbind", (projectId) => ctx.storage.unbind(projectId));
      ctx.ipc.handle("storage.sync", (projectId) => ctx.storage.sync(projectId));
      ctx.ipc.handle("storage.attach", (providerId, config) => ctx.storage.attach(providerId, config));
      ctx.ipc.handle("storage.browse", (providerId) => ctx.storage.browse(providerId));
      ctx.ipc.handle("storage.draft", (providerId, name) => ctx.storage.draft(providerId, name));
      ctx.ipc.handle("storage.connection", (providerId) => ctx.storage.connection(providerId));
      ctx.ipc.handle("storage.connect", (providerId, secret) => ctx.storage.connect(providerId, secret));
      ctx.ipc.handle("storage.disconnect", (providerId) => ctx.storage.disconnect(providerId));
    });

    this.ctx.inject(["contributions"], (ctx) => {
      ctx.contributions.statusItem({
        id: "storage",
        text: ({ projectId }) => {
          if (!projectId) return null;
          const binding = ctx.storage.binding(projectId);
          if (!binding) return null;
          const last = ctx.storage.cachedState(projectId);
          return last === "synced" ? binding.provider : `${binding.provider} · ${last}`;
        }
      });
    });

    return async () => {
      this.closing = true;
      if (this.flushTimer) clearTimeout(this.flushTimer);
      if (this.reconcileTimer) clearInterval(this.reconcileTimer);
      for (const stop of this.unwatch.values()) stop();
      this.unwatch.clear();
      for (const handle of this.handles.values()) await handle.dispose().catch(() => {});
      this.handles.clear();
    };
  }

  private get db(): Db {
    return this.ctx.db;
  }

  /** Reversible: the provider, and its option in every project sheet, goes with the plugin that registered it. */
  register<C>(provider: StorageProvider<C>): () => void {
    if (this.registry.has(provider.id)) throw new Error(`storage provider "${provider.id}" is already registered`);
    // A destination's config is committed alongside the code; a secret in it
    // would be too. Credentials belong in a ctx.settings section.
    const schema = z.toJSONSchema(provider.configSchema) as { properties?: Record<string, { format?: string }> };
    for (const [name, field] of Object.entries(schema.properties ?? {})) {
      if (field.format === "password") throw new Error(`storage provider "${provider.id}" puts a secret in its config ("${name}"); register a settings section instead`);
    }
    return this.ctx.effect(() => {
      this.registry.set(provider.id, provider as StorageProvider);
      this.ctx.emit("storage/registered", provider.id);
      return () => {
        this.registry.delete(provider.id);
        this.ctx.emit("storage/unregistered", provider.id);
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

  binding(projectId: string): StorageBinding | null {
    return this.bindings.get(projectId);
  }

  browse(providerId: string): Promise<{ label: string; config: unknown }[]> {
    const provider = this.get(providerId);
    return provider.browse ? provider.browse() : Promise.resolve([]);
  }

  /** A config for a destination that does not exist yet, from a name alone. */
  async draft(providerId: string, name: string): Promise<unknown> {
    const provider = this.get(providerId);
    if (!provider.draft) throw new Error(`"${provider.title}" cannot make a destination from a name`);
    return provider.draft(name);
  }

  /** Whether a provider has the account it needs, and as whom. Never the secret. */
  async connection(providerId: string): Promise<ConnectionState> {
    const provider = this.get(providerId);
    if (!provider.connection) return { connected: true };
    return provider.connection.status();
  }

  /**
   * Collected where it is needed rather than in a settings card of its own: the
   * provider keeps it per machine, because one account serves every project.
   */
  async connect(providerId: string, secret: string): Promise<ConnectionState> {
    const provider = this.get(providerId);
    if (!provider.connection) return { connected: true };
    return provider.connection.connect(secret);
  }

  async disconnect(providerId: string): Promise<void> {
    await this.get(providerId).connection?.disconnect();
  }

  /** The last computed state, for surfaces that must answer synchronously. */
  private lastState = new Map<string, StorageStatus["state"]>();

  cachedState(projectId: string): StorageStatus["state"] {
    return this.lastState.get(projectId) ?? (this.bindings.get(projectId) ? "synced" : "local");
  }

  /**
   * The project's `.tomrade/` directory in its shared copy, or null when the
   * project lives only in the local database. What travels beside the state
   * files (playbooks, docs) is read from here by whoever needs it.
   */
  async artifactDirFor(projectId: string): Promise<string | null> {
    if (!this.bindings.get(projectId)) return null;
    try {
      const handle = await this.handleFor(projectId);
      return path.join(handle.dir, ARTIFACT_DIR);
    } catch {
      return null;
    }
  }

  private async handleFor(projectId: string): Promise<StorageHandle> {
    const existing = this.handles.get(projectId);
    if (existing) return existing;
    const binding = this.bindings.get(projectId);
    if (!binding) throw new Error(`Project ${projectId} is stored on this machine; there is nothing to sync`);
    const provider = this.get(binding.provider);
    // A binding was validated when it was made, so the destination is ours to
    // create in. `create: false` is for attach, which asserts a project is there.
    const handle = await provider.open(provider.configSchema.parse(binding.config), { create: true });
    this.handles.set(projectId, handle);
    const stop = handle.watch?.(() => {
      if (this.publishing.has(projectId)) return;
      void this.refresh(projectId).catch(() => {});
    });
    if (stop) this.unwatch.set(projectId, stop);
    return handle;
  }

  private async release(projectId: string): Promise<void> {
    this.unwatch.get(projectId)?.();
    this.unwatch.delete(projectId);
    const handle = this.handles.get(projectId);
    this.handles.delete(projectId);
    if (handle) await handle.dispose().catch(() => {});
  }

  private get mcpUrl(): string | null {
    return (this.ctx.get("mcp") as { url?: string | null } | undefined)?.url ?? null;
  }

  private local(projectId: string): { state: ProjectState; digest: string } {
    const state = exportState(this.db, projectId);
    return { state, digest: digestState(state) };
  }

  private remember(projectId: string, status: StorageStatus): StorageStatus {
    this.lastState.set(projectId, status.state);
    return status;
  }

  /**
   * Content decides. `ahead` / `behind` / `diverged` come from comparing the
   * artifact's own digest with the one last published, so a change that arrived
   * by git, by rsync or by hand all read the same.
   */
  async statusFor(projectId: string): Promise<StorageStatus> {
    const binding = this.bindings.get(projectId);
    if (!binding) return this.remember(projectId, LOCAL);
    // Projects are deleted through their own service, which knows nothing about
    // destinations — so a binding can outlive its project. Prune it here rather
    // than let an export fail on a project that is gone.
    if (!this.projectExists(projectId)) {
      await this.unbind(projectId);
      return this.remember(projectId, LOCAL);
    }
    if (!this.has(binding.provider)) {
      return this.remember(projectId, { state: "unavailable", location: null, detail: `The "${binding.provider}" provider is not loaded`, lastSyncAt: binding.lastSyncAt });
    }
    let handle: StorageHandle;
    try {
      handle = await this.handleFor(projectId);
    } catch (error) {
      return this.remember(projectId, { state: "error", location: null, detail: message(error), lastSyncAt: binding.lastSyncAt });
    }
    const transport = await handle.status().catch((error): { state: "offline"; location: string; detail: string } => ({ state: "offline", location: handle.location, detail: message(error) }));
    if (transport.state === "offline" || transport.state === "error") {
      return this.remember(projectId, { ...transport, lastSyncAt: binding.lastSyncAt });
    }
    const localDirty = this.local(projectId).digest !== binding.lastFlushedDigest;
    const onDisk = safeRead(handle.dir);
    const remoteMoved = onDisk !== null && digestState(onDisk) !== binding.lastFlushedDigest;
    const state = localDirty && remoteMoved ? "diverged" : localDirty ? "ahead" : remoteMoved ? "behind" : transport.state;
    return this.remember(projectId, { state, location: handle.location, detail: transport.detail, lastSyncAt: binding.lastSyncAt });
  }

  /** Point a project at a destination and publish it there. */
  async bind(projectId: string, providerId: string, rawConfig: unknown, opts: { create?: boolean } = {}): Promise<StorageStatus> {
    if (!this.projectExists(projectId)) throw new Error(`Project ${projectId} not found`);
    const provider = this.get(providerId);
    const config = provider.configSchema.parse(rawConfig) as Record<string, unknown>;
    await this.release(projectId);
    const handle = await provider.open(config, { create: opts.create ?? true });
    // A destination already holding a different project is never overwritten.
    const onDisk = safeRead(handle.dir);
    if (onDisk && projectIdOf(onDisk) !== projectId) {
      await handle.dispose().catch(() => {});
      throw new ForeignProjectError(projectId, projectIdOf(onDisk));
    }
    await handle.dispose().catch(() => {});
    this.bindings.set({ projectId, provider: providerId, config, lastFlushedDigest: null, lastSyncAt: null });
    try {
      return await this.flush(projectId, "bind");
    } catch (error) {
      this.bindings.remove(projectId);
      await this.release(projectId);
      throw error;
    }
  }

  /** Forget the destination on this machine. Nothing there is deleted. */
  async unbind(projectId: string): Promise<void> {
    await this.release(projectId);
    this.bindings.remove(projectId);
    this.lastState.delete(projectId);
  }

  /** Publish local state. Skips entirely when the artifact would be byte-identical. */
  async flush(projectId: string, reason = "write"): Promise<StorageStatus> {
    const binding = this.bindings.get(projectId);
    if (!binding) return LOCAL;
    if (!this.has(binding.provider)) return this.statusFor(projectId);
    const { state, digest } = this.local(projectId);
    if (digest === binding.lastFlushedDigest) return this.statusFor(projectId);

    const handle = await this.handleFor(projectId);
    const onDisk = safeRead(handle.dir);
    if (onDisk) {
      if (projectIdOf(onDisk) !== projectId) throw new ForeignProjectError(projectId, projectIdOf(onDisk));
      // We have local changes; if the destination also moved, refuse rather than
      // overwrite work that is not ours.
      if (digestState(onDisk) !== binding.lastFlushedDigest) throw new DivergedError(projectId);
    }
    this.publishing.add(projectId);
    try {
      writeArtifact(handle.dir, state, { mcpUrl: this.mcpUrl });
      const counts = Object.entries(state.tables).filter(([, rows]) => rows.length);
      await handle.push(`tomrade: ${reason} — ${counts.map(([t, rows]) => `${rows.length} ${t}`).join(", ") || "empty project"}`);
      this.bindings.patch(projectId, { lastFlushedDigest: digest, lastSyncAt: Date.now() });
    } finally {
      this.publishing.delete(projectId);
    }
    const status = await this.statusFor(projectId);
    this.ctx.emit("storage/synced", projectId, status);
    this.ctx.get("ipc")?.send("storage.changed", projectId);
    return status;
  }

  /** Take the destination's copy. Refuses when local has unpublished changes. */
  async refresh(projectId: string): Promise<StorageStatus> {
    const binding = this.bindings.get(projectId);
    if (!binding) return LOCAL;
    if (!this.has(binding.provider)) return this.statusFor(projectId);
    const handle = await this.handleFor(projectId);
    await handle.pull();
    const onDisk = safeRead(handle.dir);
    if (!onDisk) return this.statusFor(projectId);
    if (projectIdOf(onDisk) !== projectId) throw new ForeignProjectError(projectId, projectIdOf(onDisk));
    const incoming = digestState(onDisk);
    if (incoming === binding.lastFlushedDigest) return this.statusFor(projectId);
    if (this.local(projectId).digest !== binding.lastFlushedDigest) throw new DivergedError(projectId);

    importState(this.db, onDisk);
    this.bindings.patch(projectId, { lastFlushedDigest: incoming, lastSyncAt: Date.now() });
    this.ctx.emit("storage/imported", projectId);
    this.ctx.get("ipc")?.send("storage.changed", projectId);
    return this.statusFor(projectId);
  }

  /** What the "Sync now" button does: take theirs, then publish ours. */
  async sync(projectId: string): Promise<StorageStatus> {
    await this.refresh(projectId);
    return this.flush(projectId, "sync");
  }

  /**
   * Bring in a project this machine does not know. The destination's manifest
   * names it, which is why a provider's location can never depend on the id.
   */
  async attach(providerId: string, rawConfig: unknown): Promise<string> {
    const provider = this.get(providerId);
    const config = provider.configSchema.parse(rawConfig) as Record<string, unknown>;
    const handle = await provider.open(config, { create: false });
    try {
      await handle.pull();
      const state = readArtifact(handle.dir);
      if (!state) throw new Error(`${handle.location} holds no Tomrade project`);
      const projectId = projectIdOf(state);
      if (this.projectExists(projectId)) throw new Error(`Project ${projectId} is already on this machine`);
      importState(this.db, state);
      this.bindings.set({ projectId, provider: providerId, config, lastFlushedDigest: digestState(state), lastSyncAt: Date.now() });
      this.ctx.emit("storage/imported", projectId);
      this.ctx.get("ipc")?.send("storage.changed", projectId);
      return projectId;
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  /** Publish every bound project that has something to publish. */
  async flushAll(reason = "quit"): Promise<void> {
    for (const binding of this.bindings.all()) {
      if (!this.projectExists(binding.projectId)) {
        await this.unbind(binding.projectId);
        continue;
      }
      try {
        await this.flush(binding.projectId, reason);
      } catch (error) {
        this.ctx.logger.warn(`storage: ${binding.projectId} not published — ${message(error)}`);
      }
    }
  }

  /** Ask for a publish soon. Coalesced; the digest decides whether anything happens. */
  schedule(): void {
    if (this.closing || !this.bindings.all().length || this.config.debounceMs < 0) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushAll("write");
    }, this.config.debounceMs);
    this.flushTimer.unref?.();
  }

  private projectExists(projectId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A destination that is unreadable is treated as empty; the caller decides what that means. */
function safeRead(dir: string): ProjectState | null {
  try {
    return readArtifact(dir);
  } catch {
    return null;
  }
}

export default Storage;
