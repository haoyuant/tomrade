// cordis first: the packages below augment it, and an augmentation reached
// before cordis itself declares a new module rather than extending one.
import type {} from "cordis";
import { Context, Service } from "cordis";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FileReference, Item } from "@tomrade/domain";
import type {} from "@tomrade/db";
import type {} from "@tomrade/hub";
import type {} from "@tomrade/items";
import type {} from "@tomrade/storage";
import type {} from "@tomrade/agent";
import type {} from "@tomrade/contributions";
import type {} from "@tomrade/tools";
import type {} from "./channels.js";
import { createGitBackend } from "./git-backend.js";
import { normalizeRel } from "./git-store.js";
import { MIGRATIONS, RemoteStore, TABLES, type RemoteRow } from "./store.js";
import { registerTools } from "./tools.js";
import {
  FilesUnavailableError,
  UnknownBackendError,
  type ConflictChoice,
  type ConnectionState,
  type FileConflict,
  type FileContent,
  type FileEntry,
  type FileStore,
  type FileVersion,
  type FilesBackend,
  type FilesBackendView,
  type FilesInfo,
  type FilesStatus,
  type FilesSyncState,
  type WriteOptions
} from "./types.js";

declare module "cordis" {
  interface Context {
    files: Files;
  }
  interface Events {
    "files/registered"(backendId: string): void;
    "files/unregistered"(backendId: string): void;
    /** A project's files or their sync state moved. */
    "files/changed"(projectId: string): void;
    "files/synced"(projectId: string, status: FilesStatus): void;
  }
}

export const FilesConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    gitBinary: z.string().default("git"),
    /** Every open project's files are saved and synced this often; 0 leaves it to the watcher and explicit syncs. */
    autoSyncMs: z.number().int().min(0).default(60_000),
    /** Outside edits are saved this long after the last one. */
    settleMs: z.number().int().min(0).default(1_500),
    /** A save is pushed this long after it. */
    pushMs: z.number().int().min(0).default(3_000),
    watch: z.boolean().default(true),
    /** The folder beside the project's own that holds its files. */
    folder: z.string().min(1).default("files")
  })
);
export type FilesConfig = z.infer<typeof FilesConfig>;

/** The backend every project starts on: versions here, shared nowhere. */
export const LOCAL_BACKEND = "local";

/** A folder, minus hidden names; a folder left empty gets a marker so git carries it. */
function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  let kept = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else continue;
    kept++;
  }
  if (!kept) fs.writeFileSync(path.join(dest, ".keep"), "", "utf8");
}

const unavailable = (detail: string): FilesStatus => ({ state: "unavailable", location: null, detail, lastSyncAt: null, conflicts: 0, ahead: 0, behind: 0, head: null });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `ctx.files`: the files a project keeps beside its backlog. The service owns
 * the backend registry, which remote a project shares its files through (a row
 * that travels with the project), one open store per project, the sweep that
 * saves and syncs them, and the versioned references tickets pin as artifacts.
 * How files are versioned and moved is the backend's; `local` is always there.
 */
export class Files extends Service {
  static provide = "files";
  static inject = ["db", "hub", "storage", "items"];
  static Config = FilesConfig;

  private readonly home: Context;
  private readonly registry = new Map<string, FilesBackend>();
  private readonly open = new Map<string, { backend: string; store: FileStore }>();
  private readonly opening = new Map<string, Promise<FileStore>>();
  private readonly lastState = new Map<string, FilesSyncState>();
  private remotes!: RemoteStore;

  constructor(
    ctx: Context,
    public readonly config: FilesConfig
  ) {
    super(ctx, "files");
    this.home = ctx;
  }

  [Service.init]() {
    this.ctx.db.migrate("files", MIGRATIONS, { tables: TABLES });
    this.remotes = new RemoteStore(this.ctx.db);
    this.register(
      createGitBackend({
        id: LOCAL_BACKEND,
        title: "This machine only",
        description: "Versions are kept beside the project's folder. Nothing is shared until a remote is chosen.",
        configSchema: z.object({}),
        defaults: {},
        remote: null
      })
    );
    this.ctx.effect(() => this.ctx.items.files({ getVersion: (projectId, ref) => this.resolveVersion(projectId, ref) }), "items.files(files)");
    this.ctx.on("db/closed", (projectId) => this.close(projectId));
    // The remote row travels with the project: a folder read back in may name another one.
    this.ctx.on("storage/imported", (projectId) => void this.reopen(projectId).catch((error) => this.warn(projectId, error)));

    this.home.inject(["tools"], (ctx) => registerTools(ctx, this));
    this.home.inject(["agent"], (ctx) => {
      for (const name of ["files.read", "files.write", "document.preview"]) ctx.effect(() => ctx.agent.capability(name), `agent.capability(${name})`);
    });
    this.home.inject(["contributions"], (ctx) => {
      ctx.contributions.statusItem({
        id: "files",
        text: ({ projectId }) => {
          const state = projectId ? this.lastState.get(projectId) : undefined;
          return state === "conflicted" ? "Files · conflicts" : state === "offline" ? "Files · offline" : state === "error" ? "Files · error" : null;
        }
      });
      ctx.contributions.command({
        id: "files.sync",
        title: "Sync files now",
        group: "Files",
        run: async ({ projectId }) => {
          if (!projectId) return { toast: "Open a project first" };
          const status = await this.sync(projectId);
          return { toast: `Files: ${status.state}${status.detail ? ` — ${status.detail}` : ""}` };
        }
      });
    });
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("files.backends", () => this.describe());
      ctx.ipc.handle("files.info", (projectId) => this.info(projectId));
      ctx.ipc.handle("files.status", (projectId) => this.status(projectId));
      ctx.ipc.handle("files.tree", (projectId) => this.tree(projectId));
      ctx.ipc.handle("files.list", (projectId, dir) => this.list(projectId, dir ?? ""));
      ctx.ipc.handle("files.read", (projectId, p) => this.read(projectId, p));
      ctx.ipc.handle("files.readVersion", (projectId, ref) => this.readVersion(projectId, ref));
      ctx.ipc.handle("files.locate", (projectId, fileId) => this.locate(projectId, fileId));
      ctx.ipc.handle("files.history", (projectId, p, limit) => this.history(projectId, p, limit));
      ctx.ipc.handle("files.write", (projectId, p, body, opts) => this.write(projectId, p, Buffer.from(body, opts?.encoding ?? "utf8"), opts?.message ? { message: opts.message } : {}));
      ctx.ipc.handle("files.import", (projectId, dir, sources) => this.importFiles(projectId, dir, sources));
      ctx.ipc.handle("files.mkdir", (projectId, p) => this.mkdir(projectId, p));
      ctx.ipc.handle("files.move", (projectId, from, to) => this.move(projectId, from, to));
      ctx.ipc.handle("files.copy", (projectId, from, to) => this.copy(projectId, from, to));
      ctx.ipc.handle("files.remove", (projectId, p) => this.remove(projectId, p));
      ctx.ipc.handle("files.sync", (projectId) => this.sync(projectId));
      ctx.ipc.handle("files.conflicts", (projectId) => this.conflicts(projectId));
      ctx.ipc.handle("files.resolve", (projectId, p, choice) => this.resolve(projectId, p, choice));
      ctx.ipc.handle("files.resolveAll", (projectId, choice) => this.resolveAll(projectId, choice));
      ctx.ipc.handle("files.bind", (projectId, backendId, config) => this.bind(projectId, backendId, config));
      ctx.ipc.handle("files.unbind", (projectId) => this.unbind(projectId));
      ctx.ipc.handle("files.browse", (backendId) => this.browse(backendId));
      ctx.ipc.handle("files.draft", (backendId, name) => this.draft(backendId, name));
      ctx.ipc.handle("files.connection", (backendId) => this.connection(backendId));
      ctx.ipc.handle("files.connect", (backendId, secret) => this.connect(backendId, secret));
      ctx.ipc.handle("files.disconnect", (backendId) => this.disconnect(backendId));
      ctx.ipc.handle("files.attach", (projectId, itemId, input) => this.attach(projectId, itemId, input));
      ctx.ipc.handle("files.attachMany", (projectId, itemId, input) => this.attachMany(projectId, itemId, input));
    });

    const timer = this.config.autoSyncMs > 0 ? setInterval(() => void this.syncAll(), this.config.autoSyncMs) : null;
    timer?.unref?.();
    return () => {
      if (timer) clearInterval(timer);
      for (const projectId of [...this.open.keys()]) this.close(projectId);
    };
  }

  private warn(projectId: string, error: unknown): void {
    this.home.logger.warn(`files: ${projectId}: ${message(error)}`);
  }

  private notify(projectId: string): void {
    this.home.get("ipc")?.send("files.changed", projectId);
    this.home.emit("files/changed", projectId);
  }

  // ── backends ────────────────────────────────────────────────────────────────

  /** Reversible: the backend, and its option in every project, goes with the plugin that registered it. */
  register<C>(backend: FilesBackend<C>): () => void {
    if (this.registry.has(backend.id)) throw new Error(`files backend "${backend.id}" is already registered`);
    // A remote's config is written into the project's folder; a secret in it would be too.
    const schema = z.toJSONSchema(backend.configSchema) as { properties?: Record<string, { format?: string }> };
    for (const [name, field] of Object.entries(schema.properties ?? {})) {
      if (field.format === "password") throw new Error(`files backend "${backend.id}" puts a secret in its config ("${name}"); register a settings section instead`);
    }
    return this.ctx.effect(() => {
      this.registry.set(backend.id, backend as FilesBackend);
      this.home.emit("files/registered", backend.id);
      return () => {
        this.registry.delete(backend.id);
        this.home.emit("files/unregistered", backend.id);
      };
    }, `files.register(${backend.id})`);
  }

  get(backendId: string): FilesBackend {
    const backend = this.registry.get(backendId);
    if (!backend) throw new UnknownBackendError(backendId);
    return backend;
  }

  has(backendId: string): boolean {
    return this.registry.has(backendId);
  }

  describe(): FilesBackendView[] {
    return [...this.registry.values()].map((b) => ({
      id: b.id,
      title: b.title,
      description: b.description,
      schema: z.toJSONSchema(b.configSchema) as Record<string, unknown>,
      defaults: b.defaults,
      settingsSection: b.settingsSection,
      browsable: !!b.browse,
      creatable: !!b.draft,
      connection: b.connection?.prompt
    }));
  }

  browse(backendId: string): Promise<{ label: string; config: unknown }[]> {
    const backend = this.get(backendId);
    return backend.browse ? backend.browse() : Promise.resolve([]);
  }

  async draft(backendId: string, name: string): Promise<unknown> {
    const backend = this.get(backendId);
    return backend.draft ? backend.draft(name) : backend.defaults;
  }

  async connection(backendId: string): Promise<ConnectionState> {
    const backend = this.get(backendId);
    return backend.connection ? backend.connection.status() : { connected: true };
  }

  async connect(backendId: string, secret: string): Promise<ConnectionState> {
    const backend = this.get(backendId);
    if (!backend.connection) return { connected: true };
    return backend.connection.connect(secret);
  }

  async disconnect(backendId: string): Promise<void> {
    await this.get(backendId).connection?.disconnect();
  }

  // ── placement and stores ────────────────────────────────────────────────────

  /** This machine's copy: beside the project's folder, or inside `.tomrade/` when that folder is somebody's checkout. */
  dirFor(projectId: string): string | null {
    const entry = this.ctx.storage.entry(projectId);
    if (!entry?.dir) return null;
    return entry.git === "shared" ? path.join(entry.dir, ".tomrade", this.config.folder) : path.join(entry.dir, this.config.folder);
  }

  remoteOf(projectId: string): RemoteRow | null {
    try {
      return this.remotes.get(projectId);
    } catch {
      return null;
    }
  }

  /** In a repository Tomrade drives, the files keep a repository of their own; the outer one must not swallow it. */
  private ensureIgnored(projectId: string): void {
    const entry = this.ctx.storage.entry(projectId);
    if (!entry?.dir || entry.git !== "dedicated") return;
    const file = path.join(entry.dir, ".gitignore");
    const line = `/${this.config.folder}/`;
    let body = "";
    try {
      body = fs.readFileSync(file, "utf8");
    } catch {
      // none yet
    }
    if (body.split("\n").some((l) => l.trim() === line)) return;
    fs.writeFileSync(file, `${body}${body && !body.endsWith("\n") ? "\n" : ""}# The project's files keep a repository of their own.\n${line}\n`, "utf8");
  }

  store(projectId: string): Promise<FileStore> {
    const current = this.open.get(projectId);
    // The project's folder moved under us: the store follows it.
    if (current && current.store.dir !== this.dirFor(projectId)) this.close(projectId);
    else if (current) return Promise.resolve(current.store);
    const pending = this.opening.get(projectId);
    if (pending) return pending;
    const task = this.openStore(projectId).finally(() => this.opening.delete(projectId));
    this.opening.set(projectId, task);
    return task;
  }

  private async openStore(projectId: string): Promise<FileStore> {
    const dir = this.dirFor(projectId);
    if (!dir) throw new FilesUnavailableError(projectId, "the project has no folder yet");
    const remote = this.remoteOf(projectId);
    let backend = remote ? this.registry.get(remote.backend) : undefined;
    let config: unknown = null;
    if (remote && !backend) this.warn(projectId, `files backend "${remote.backend}" is not installed; keeping the files on this machine`);
    if (remote && backend) {
      const parsed = backend.configSchema.safeParse({ ...(backend.defaults as object), ...remote.config });
      if (parsed.success) config = parsed.data;
      else {
        this.warn(projectId, `remote config for "${remote.backend}" is invalid; keeping the files on this machine`);
        backend = undefined;
      }
    }
    const chosen = backend ?? this.get(LOCAL_BACKEND);
    this.ensureIgnored(projectId);
    const store = await chosen.open({
      projectId,
      dir,
      remote: backend ? config : null,
      warn: (m) => this.warn(projectId, m),
      onChange: () => this.notify(projectId),
      env: { gitBinary: this.config.gitBinary, watch: this.config.watch, settleMs: this.config.settleMs, pushMs: this.config.pushMs }
    });
    const raced = this.open.get(projectId);
    if (raced) {
      store.close();
      return raced.store;
    }
    this.open.set(projectId, { backend: chosen.id, store });
    return store;
  }

  close(projectId: string): void {
    this.open.get(projectId)?.store.close();
    this.open.delete(projectId);
  }

  /** Re-read the remote row and open the store again; a no-op for a project nobody has opened. */
  private async reopen(projectId: string, force = false): Promise<void> {
    const pending = this.opening.get(projectId);
    if (pending) await pending.catch(() => undefined);
    if (!force && !this.open.has(projectId)) return;
    this.close(projectId);
    await this.store(projectId);
    this.notify(projectId);
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  async info(projectId: string): Promise<FilesInfo> {
    const dir = this.dirFor(projectId);
    const remote = this.remoteOf(projectId);
    const status = dir ? await this.status(projectId) : unavailable("Choose where the project keeps its folder first");
    return { projectId, dir, remote: remote ? { backend: remote.backend, config: remote.config } : null, status };
  }

  async status(projectId: string): Promise<FilesStatus> {
    if (!this.dirFor(projectId)) return unavailable("Choose where the project keeps its folder first");
    try {
      const status = await (await this.store(projectId)).status();
      this.lastState.set(projectId, status.state);
      return status;
    } catch (error) {
      this.lastState.set(projectId, "error");
      return unavailable(message(error));
    }
  }

  async tree(projectId: string): Promise<FileEntry[]> {
    return (await this.store(projectId)).tree();
  }

  async list(projectId: string, dir = ""): Promise<FileEntry[]> {
    return (await this.store(projectId)).list(dir);
  }

  async read(projectId: string, p: string): Promise<FileContent | null> {
    return (await this.store(projectId)).read(p);
  }

  async readVersion(projectId: string, ref: FileReference): Promise<FileContent | null> {
    return (await this.store(projectId)).readVersion(ref);
  }

  async locate(projectId: string, fileId: string): Promise<string | null> {
    return (await this.store(projectId)).locate(fileId);
  }

  async history(projectId: string, p: string, limit?: number): Promise<FileVersion[]> {
    return (await this.store(projectId)).history(p, limit);
  }

  /** The resolver tickets pin versions through: exact pair or null, never a guess. */
  async resolveVersion(projectId: string, ref: FileReference): Promise<FileReference | null> {
    if (!this.dirFor(projectId)) return null;
    try {
      return await (await this.store(projectId)).resolveVersion(ref);
    } catch (error) {
      this.warn(projectId, error);
      return null;
    }
  }

  // ── writes ──────────────────────────────────────────────────────────────────

  async write(projectId: string, p: string, body: Buffer | string, opts: WriteOptions = {}): Promise<FileContent> {
    const store = await this.store(projectId);
    const saved = await store.write(p, Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"), opts);
    this.notify(projectId);
    return saved;
  }

  /**
   * Copy files or folders from this machine into a folder of the store. A file
   * is a version of its own; a folder lands whole and is saved as one version,
   * hidden names left behind and empty folders kept with a marker.
   */
  async importFiles(projectId: string, dir: string, sources: string[]): Promise<FileEntry[]> {
    const store = await this.store(projectId);
    const target = normalizeRel(dir);
    const names = new Set<string>();
    const folders: string[] = [];
    const files: { src: string; rel: string }[] = [];
    for (const src of sources) {
      const name = path.basename(src);
      if (name.startsWith(".")) continue;
      const rel = target ? `${target}/${name}` : name;
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        if (fs.existsSync(path.join(store.dir, ...rel.split("/")))) throw new Error(`${rel} already exists`);
        folders.push(rel);
        copyTree(src, path.join(store.dir, ...rel.split("/")));
        names.add(name);
      } else if (stat.isFile()) {
        files.push({ src, rel });
        names.add(name);
      }
    }
    // Folders are saved before any file write stages them under the file's message.
    if (folders.length) await store.settle(folders.length === 1 ? `Imported folder ${folders[0]}` : `Imported ${folders.length} folders`);
    for (const file of files) await store.write(file.rel, fs.readFileSync(file.src), { message: `Imported ${file.rel}` });
    this.notify(projectId);
    return (await store.list(target)).filter((e) => names.has(e.name));
  }

  async mkdir(projectId: string, p: string): Promise<void> {
    await (await this.store(projectId)).mkdir(p);
    this.notify(projectId);
  }

  async move(projectId: string, from: string, to: string): Promise<void> {
    await (await this.store(projectId)).move(from, to);
    this.notify(projectId);
  }

  async copy(projectId: string, from: string, to: string): Promise<void> {
    await (await this.store(projectId)).copy(from, to);
    this.notify(projectId);
  }

  async remove(projectId: string, p: string): Promise<void> {
    await (await this.store(projectId)).remove(p);
    this.notify(projectId);
  }

  // ── sync and conflicts ──────────────────────────────────────────────────────

  async sync(projectId: string): Promise<FilesStatus> {
    const status = await (await this.store(projectId)).sync();
    this.lastState.set(projectId, status.state);
    this.home.emit("files/synced", projectId, status);
    this.notify(projectId);
    return status;
  }

  /** The sweep: every project open on this machine with files, or a remote, is saved and synced. */
  async syncAll(): Promise<void> {
    for (const projectId of this.ctx.db.openIds()) {
      const dir = this.dirFor(projectId);
      if (!dir) continue;
      if (!this.open.has(projectId) && !this.remoteOf(projectId) && !fs.existsSync(dir)) continue;
      try {
        await this.sync(projectId);
      } catch (error) {
        this.warn(projectId, error);
      }
    }
  }

  async conflicts(projectId: string): Promise<FileConflict[]> {
    return (await this.store(projectId)).conflicts();
  }

  async resolve(projectId: string, p: string, choice: ConflictChoice): Promise<FilesStatus> {
    await (await this.store(projectId)).resolve(p, choice);
    return this.sync(projectId);
  }

  async resolveAll(projectId: string, choice: ConflictChoice): Promise<FilesStatus> {
    const store = await this.store(projectId);
    for (const conflict of await store.conflicts()) await store.resolve(conflict.path, choice);
    return this.sync(projectId);
  }

  // ── the remote a project shares through ─────────────────────────────────────

  async bind(projectId: string, backendId: string, rawConfig: unknown): Promise<FilesStatus> {
    const backend = this.get(backendId);
    const config = backend.configSchema.parse({ ...(backend.defaults as object), ...((rawConfig as object) ?? {}) }) as Record<string, unknown>;
    if (!this.dirFor(projectId)) throw new FilesUnavailableError(projectId, "the project has no folder yet");
    this.remotes.set(projectId, backendId, config);
    await this.reopen(projectId, true);
    // The row travels in the project's folder; write it now rather than at the next backlog change.
    void this.ctx.storage.publish(projectId, "files").catch((error) => this.warn(projectId, error));
    return this.sync(projectId);
  }

  async unbind(projectId: string): Promise<FilesInfo> {
    this.remotes.clear(projectId);
    await this.reopen(projectId, true);
    void this.ctx.storage.publish(projectId, "files").catch((error) => this.warn(projectId, error));
    return this.info(projectId);
  }

  // ── tickets ─────────────────────────────────────────────────────────────────

  /** Pin the file's latest version to a ticket. The working copy is saved first, so what is pinned is what is there. */
  async attach(projectId: string, itemId: string, input: { path: string; role: "input" | "output"; name?: string }): Promise<Item> {
    return this.attachMany(projectId, itemId, { paths: [input.path], role: input.role, names: input.name ? { [normalizeRel(input.path)]: input.name } : undefined });
  }

  /** Settle once and add every chosen file to the ticket in one item write. */
  async attachMany(projectId: string, itemId: string, input: { paths: string[]; role: "input" | "output"; names?: Record<string, string> }): Promise<Item> {
    const store = await this.store(projectId);
    const paths = [...new Set(input.paths.map(normalizeRel))];
    if (!paths.length || paths.some(rel => !rel)) throw new Error("Choose at least one file");
    await store.settle(paths.length === 1 ? `Saved ${paths[0]}` : `Saved ${paths.length} files`);
    const contents = await Promise.all(paths.map(rel => store.read(rel)));
    const resources = contents.map((content, index) => {
      const rel = paths[index]!;
      if (!content) throw new Error(`No file at ${rel}`);
      if (!content.fileId || !content.versionId) throw new Error(`${rel} has no saved version yet`);
      return { name: input.names?.[rel]?.trim() || content.name, role: input.role, file: { fileId: content.fileId, versionId: content.versionId } };
    });
    const item = await this.ctx.items.addResources(projectId, itemId, resources, "human");
    this.notify(projectId);
    return item;
  }
}

export default Files;
