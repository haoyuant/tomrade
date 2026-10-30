// cordis first: the packages below augment it, and an augmentation reached
// before cordis itself declares a new module rather than extending one.
import type {} from "cordis";
import { Context, Service } from "cordis";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { NotFoundError, type FileDescription, type FileReference, type Item } from "@tomradex/domain";
import type {} from "@tomradex/db";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/items";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/storage";
import type {} from "@tomradex/agent";
import type { SettingsSection } from "@tomradex/settings";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/tools";
import type { UndoProvider } from "@tomradex/oplog";
import { writeContext } from "@tomradex/write";
import type { UndoRecord } from "@tomradex/domain";
import type {} from "./channels.js";
import { createGitBackend } from "./git-backend.js";
import { BINARY_LIMIT, GitFileStore, normalizeRel } from "./git-store.js";
import { DEFAULT_AGENT_POLICY, collidesWithProject, listingAt, remoteDirectory } from "./git-sync.js";
import { buildAgentIndex, type AgentIndex } from "./agent-index.js";
import { GitMissingError, execGit, gitRunner } from "@tomradex/git";
import { FolderFileStore } from "./folder-store.js";
import { FilesArchive, boundDirectory, storeId } from "./scopes.js";
import { MIGRATIONS, OpsStore, RemoteStore, TABLES, type FileOpKind, type FileOpRow, type RemoteRow } from "./store.js";
import { mimeOf } from "./mime.js";
import { FILES_STATE_WORD, FILES_WORDS } from "./words.js";
import { registerTools } from "./tools.js";
import {
  FileChangedError,
  FilesUnavailableError,
  InvalidPathError,
  ProjectRepositoryError,
  UnknownBackendError,
  type AttachmentInput,
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
  type FilesSyncPolicy,
  type FilesAgentPolicy,
  type FileSearchInput,
  type FileSearchResult,
  type ListMode,
  type ProjectRepository,
  type SaveResult,
  type SyncMode,
  type WriteOptions
} from "./types.js";
import { errorMessage, type FilesReader, localeOf } from "@tomradex/contracts";

declare module "cordis" {
  interface Context {
    files: Files;
  }
  interface Events {
    /** From the desktop shell: whether any of the app's windows can be seen. */
    "desktop/seen"(seen: boolean): void;
    "files/registered"(backendId: string): void;
    "files/unregistered"(backendId: string): void;
    /** A project's files or their sync state moved. */
    "files/changed"(projectId: string): void;
    "files/synced"(projectId: string, status: FilesStatus): void;
    /** A file or folder moved through the service; awaited, so whatever follows the path moves with it. */
    "files/moved"(projectId: string, from: string, to: string): Promise<void>;
  }
}

export const FilesConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    gitBinary: z.string().default("git"),
    /** Every open project's files are saved and synced this often; 0 leaves it to the watcher and explicit syncs. */
    autoSyncMs: z.number().int().min(0).default(60_000),
    /** The sweep's pace for a watched folder with no remote, and for a remote while no window shows. */
    rareSyncMs: z.number().int().min(0).default(600_000),
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

interface FilesSettings {
  agentIndexTokens: number;
}

/**
 * How much of an agent's context the file index may take. It buys discovery:
 * without it an agent has to go looking, and mostly does not.
 */
const FILES_SECTION: SettingsSection<FilesSettings> = {
  id: "files",
  title: "Files",
  description: "How much room the list of this project's files takes in an agent's prompt. Zero leaves agents to browse for themselves.",
  schema: z.object({
    agentIndexTokens: z.number().int().min(0).max(20_000).default(1_500).meta({ title: "Room for the file list", advanced: true }).describe("In tokens, the unit models count text in — roughly ¾ of an English word each. From 0 to 20,000.")
  }),
  defaults: { agentIndexTokens: 1_500 },
  order: 13,
  agent: "write",
  words: {
    zh: {
      title: "文件",
      description: "项目的文件清单在智能体提示词里占多大篇幅。设为 0 则让智能体自己去浏览。",
      fields: { agentIndexTokens: { title: "文件清单的篇幅", description: "以 token 计——模型计算文字长度的单位，一个汉字大约 1 到 2 个 token。范围 0 到 20000。" } }
    }
  }
};

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

/** A workstream's name as one folder name: separators and a leading dot would make it something else. */
export const folderName = (name: string): string => name.replace(/[\\/\0]+/g, "-").trim().replace(/^\.+/, "").trim() || "Workstream";

/** A pasted file's own name, never a path: separators and control characters go, an empty name gets one. */
const attachmentName = (name: string): string => name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+/, "").trim() || "attachment";

/** `name 2.ext`, `name 3.ext`, … — the first that is in neither the folder nor the batch. */
function freeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) if (!taken(`${stem} ${n}${ext}`)) return `${stem} ${n}${ext}`;
}

const gitInstalled = (binary: string): Promise<boolean> => execGit(binary, ["--version"]).then(() => true, () => false);

const unavailable = (detail: string): FilesStatus => ({ state: "unavailable", location: null, detail, lastSyncAt: null, conflicts: 0, ahead: 0, behind: 0, head: null });

/**
 * `ctx.files`: the files a project keeps beside its backlog. The service owns
 * the backend registry, which remote a project shares its files through (a row
 * that travels with the project), one open store per project, the sweep that
 * saves and syncs them, and the versioned references tickets pin as artifacts.
 * How files are versioned and moved is the backend's; `local` is always there.
 */
const EARLIER_STORE = "That operation belongs to an earlier Files store, kept under .tomrade/files-archive";

function ensureIgnoreLine(file: string, line: string, comment?: string): void {
  let body = "";
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    // none yet
  }
  if (body.split("\n").some((l) => l.trim() === line)) return;
  fs.writeFileSync(file, `${body}${body && !body.endsWith("\n") ? "\n" : ""}${comment ? `${comment}\n` : ""}${line}\n`, "utf8");
}

/** Only a document has a title worth quoting; a spreadsheet's first bytes are not one. */
const TITLED = /\.(md|markdown|txt|mdx|rst|org)$/i;
const TITLE_BYTES = 4096;
const TITLE_MAX = 60;

/** Front matter first, then the first ATX heading. Whatever comes back is one clipped line. */
function readTitle(abs: string): string | null {
  let head: string;
  try {
    const fd = fs.openSync(abs, "r");
    try {
      const buffer = Buffer.alloc(TITLE_BYTES);
      head = buffer.subarray(0, fs.readSync(fd, buffer, 0, TITLE_BYTES, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = head.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "---") break;
      const match = /^(title|description)\s*:\s*(.+)$/i.exec(line);
      if (match) return clipTitle(match[2]!.trim().replace(/^["']|["']$/g, ""));
    }
  }
  for (const line of lines) {
    const match = /^#{1,3}\s+(.+?)\s*#*$/.exec(line);
    if (match) return clipTitle(match[1]!.trim());
  }
  return null;
}

const clipTitle = (text: string): string | null => {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX)}…` : clean;
};

export class Files extends Service implements FilesReader {
  static provide = "files";
  static inject = ["db", "hub", "storage", "items", "boards", "oplog"];

  /** The status bar's and the palette's words, in the person's language now. */
  private words() {
    return FILES_WORDS(localeOf(this.home));
  }
  static Config = FilesConfig;

  /** How file records name themselves in the timeline: `files:<seq>`. */
  static readonly PROVIDER = "files";

  private readonly home: Context;
  private readonly registry = new Map<string, FilesBackend>();
  private readonly open = new Map<string, { backend: string; store: FileStore; configKey: string }>();
  private readonly opening = new Map<string, Promise<FileStore>>();
  private readonly lastState = new Map<string, FilesSyncState>();
  /** How often each project's files were said to change, so a sync knows whether its store said anything. */
  private readonly told = new Map<string, number>();
  /** When the sweep last synced each project. */
  private readonly swept = new Map<string, number>();
  /** Whether a window of the app can be seen, as the desktop shell last said. */
  private seen = true;
  /** Titles cost a read each; a file that has not changed has not retitled itself. */
  private readonly titles = new Map<string, { stamp: string; title: string | null }>();
  private remotes!: RemoteStore;
  private ops!: OpsStore;

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
    this.ops = new OpsStore(this.ctx.db);
    this.ctx.oplog.provide(this.provider);
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
    this.ctx.effect(
      () => this.ctx.items.files({ getVersion: (projectId, ref) => this.resolveVersion(projectId, ref), describe: (projectId, ids) => this.describeFiles(projectId, ids) }),
      "items.files(files)"
    );
    this.ctx.on("db/closed", (projectId) => this.close(projectId));
    // The remote row travels with the project: a folder read back in may name another one.
    this.ctx.on("storage/imported", (projectId) => void this.reopen(projectId).catch((error) => this.warn(projectId, error)));

    this.home.inject(["tools"], (ctx) => registerTools(ctx, this));
    this.home.inject(["settings"], (ctx) => ctx.settings.register(FILES_SECTION));
    this.home.inject(["agent"], (ctx) => {
      for (const name of ["files.read", "files.write", "document.preview"]) ctx.effect(() => ctx.agent.capability(name), `agent.capability(${name})`);
      // Every turn is told what this project holds. It never says what may be
      // read: the index is discovery, and a path left out of it still reads.
      ctx.on("agent/prepare-turn", async (input) => {
        try {
          const index = await this.indexFor(input.projectId, input.purpose !== "backlog", input.ticket?.id);
          if (index) input.filesIndex = { markdown: index.markdown, digest: index.digest };
        } catch (error) {
          this.warn(input.projectId, error);
        }
      });
      // A terminal agent is handed the same index inside its brief.
      ctx.on("agent/prepare-brief", async (brief) => {
        try {
          const index = await this.indexFor(brief.projectId, true, brief.itemId);
          if (index) brief.filesIndex = index.markdown;
        } catch (error) {
          this.warn(brief.projectId, error);
        }
      });
    });
    this.home.inject(["contributions"], (ctx) => {
      ctx.contributions.statusItem({
        id: "files",
        text: ({ projectId }) => {
          const state = projectId ? this.lastState.get(projectId) : undefined;
          const w = this.words();
          return state === "conflicted" ? w("conflicts") : state === "offline" ? w("offline") : state === "error" ? w("error") : null;
        }
      });
      ctx.contributions.command({
        id: "files.sync",
        title: () => this.words()("sync"),
        group: () => this.words()("group"),
        run: async ({ projectId }) => {
          if (!projectId) return { toast: this.words()("openProject") };
          const status = await this.sync(projectId);
          const w = this.words();
          const key = FILES_STATE_WORD[status.state];
          const state = key ? w(key) : status.state;
          return { toast: status.detail ? w("syncedDetail", { state, detail: status.detail }) : w("synced", { state }) };
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
      ctx.ipc.handle("files.save", (projectId, p, body, opts) => this.save(projectId, p, body, opts ?? {}));
      ctx.ipc.handle("files.import", (projectId, dir, sources) => this.importFiles(projectId, dir, sources));
      ctx.ipc.handle("files.mkdir", (projectId, p) => this.mkdir(projectId, p));
      ctx.ipc.handle("files.move", (projectId, from, to) => this.move(projectId, from, to));
      ctx.ipc.handle("files.copy", (projectId, from, to) => this.copy(projectId, from, to));
      ctx.ipc.handle("files.remove", (projectId, p) => this.remove(projectId, p));
      ctx.ipc.handle("files.sync", (projectId) => this.sync(projectId));
      ctx.ipc.handle("files.syncPolicy", (projectId) => this.syncPolicy(projectId));
      ctx.ipc.handle("files.setSyncRules", (projectId, paths, mode) => this.setSyncRules(projectId, paths, mode));
      ctx.ipc.handle("files.agentPolicy", (projectId) => this.agentPolicy(projectId));
      ctx.ipc.handle("files.setAgentRules", (projectId, paths, mode) => this.setAgentRules(projectId, paths, mode));
      ctx.ipc.handle("files.agentIndex", (projectId, opts) => this.agentIndex(projectId, opts ?? {}));
      ctx.ipc.handle("files.conflicts", (projectId) => this.conflicts(projectId));
      ctx.ipc.handle("files.resolve", (projectId, p, choice) => this.resolve(projectId, p, choice));
      ctx.ipc.handle("files.resolveAll", (projectId, choice) => this.resolveAll(projectId, choice));
      ctx.ipc.handle("files.bind", (projectId, backendId, config) => this.bind(projectId, backendId, config));
      ctx.ipc.handle("files.unbind", (projectId) => this.unbind(projectId));
      ctx.ipc.handle("files.browse", (backendId) => this.browse(backendId));
      ctx.ipc.handle("files.draft", (backendId, name) => this.draft(backendId, name));
      ctx.ipc.handle("files.connection", (backendId) => this.connection(backendId));
      ctx.ipc.handle("files.connect", (backendId, secret) => this.connect(backendId, secret));
      ctx.ipc.handle("files.signIn", (backendId) => this.signIn(backendId));
      ctx.ipc.handle("files.disconnect", (backendId) => this.disconnect(backendId));
      ctx.ipc.handle("files.attach", (projectId, itemId, input) => this.attach(projectId, itemId, input));
      ctx.ipc.handle("files.attachMany", (projectId, itemId, input) => this.attachMany(projectId, itemId, input));
      ctx.ipc.handle("files.folderFor", (projectId, itemId) => this.folderFor(projectId, itemId));
      ctx.ipc.handle("files.importFor", (projectId, itemId, input) => this.importFor(projectId, itemId, input));
      ctx.ipc.handle("files.addAttachments", (projectId, itemId, files) => this.addAttachments(projectId, itemId, files));
      ctx.ipc.handle("files.readById", (projectId, fileId) => this.readById(projectId, fileId));
    });

    const timer = this.config.autoSyncMs > 0 ? setInterval(() => void this.syncAll(), this.config.autoSyncMs) : null;
    timer?.unref?.();
    this.home.on("desktop/seen", (seen) => {
      this.seen = seen;
    });
    return () => {
      if (timer) clearInterval(timer);
      for (const projectId of [...this.open.keys()]) this.close(projectId);
    };
  }

  private warn(projectId: string, error: unknown): void {
    this.home.logger.warn(`files: ${projectId}: ${errorMessage(error)}`);
  }

  /** `paths`, when the change is known to touch only them, lets a window keep what it read of every other file. */
  private notify(projectId: string, paths?: string[]): void {
    this.told.set(projectId, (this.told.get(projectId) ?? 0) + 1);
    const named = paths?.map((p) => normalizeRel(p)).filter((p): p is string => !!p);
    this.home.get("ipc")?.send("files.changed", projectId, ...(named?.length ? [named] : []));
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

  /** Begin a sign-in finished in the browser; `connection()` reports when it lands. */
  async signIn(backendId: string): Promise<ConnectionState> {
    const connection = this.get(backendId).connection;
    if (!connection?.signIn) throw new Error(`files backend "${backendId}" has no sign-in`);
    return connection.signIn();
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

  /** The repository Tomrade drives for the project itself: Files may share a folder in it, never its root or the store's own folder. */
  private async projectRepository(projectId: string): Promise<ProjectRepository | null> {
    if (this.ctx.storage.entry(projectId)?.git !== "dedicated") return null;
    const { origin } = await this.ctx.storage.info(projectId);
    return origin?.url && origin.branch ? { url: origin.url, branch: origin.branch, folder: this.config.folder } : null;
  }

  /** In a repository Tomrade drives, the files keep a repository of their own; the outer one must not swallow it. */
  private ensureIgnored(projectId: string): void {
    const entry = this.ctx.storage.entry(projectId);
    if (!entry?.dir || entry.git !== "dedicated") return;
    ensureIgnoreLine(path.join(entry.dir, ".gitignore"), `/${this.config.folder}/`, "# The project's files keep a repository of their own.");
  }

  store(projectId: string): Promise<FileStore> {
    const current = this.open.get(projectId);
    // The project's folder moved under us, or its remote changed: the store follows.
    if (current && (current.store.dir !== this.dirFor(projectId) || current.configKey !== this.remoteKey(projectId))) this.close(projectId);
    else if (current) return Promise.resolve(current.store);
    const pending = this.opening.get(projectId);
    if (pending) return pending;
    const task = this.openStore(projectId).finally(() => this.opening.delete(projectId));
    this.opening.set(projectId, task);
    return task;
  }

  private remoteKey(projectId: string): string {
    const remote = this.remoteOf(projectId);
    return JSON.stringify(remote ? [remote.backend, remote.config] : null);
  }

  private async openStore(projectId: string): Promise<FileStore> {
    const dir = this.dirFor(projectId);
    if (!dir) throw new FilesUnavailableError(projectId, "the project has no folder yet");
    const configKey = this.remoteKey(projectId);
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
    // A repository root and a folder in it are different enough that each keeps a store of its own.
    const directory = backend ? remoteDirectory((config as { directory?: string }).directory) : null;
    const undo = directory !== null && FilesArchive.rotates(boundDirectory(dir), directory) ? this.park(projectId, dir, directory) : null;
    let store: FileStore;
    try {
      store = await chosen.open({
        projectId,
        dir,
        remote: backend ? config : null,
        warn: (m) => this.warn(projectId, m),
        onChange: (paths) => this.notify(projectId, paths),
        // Its own broadcast: `files.changed` would refetch every file the window holds at each step.
        onProgress: (progress) => this.home.get("ipc")?.send("files.progress", projectId, progress),
        projectRepository: () => this.projectRepository(projectId),
        env: { gitBinary: this.config.gitBinary, watch: this.config.watch, settleMs: this.config.settleMs, pushMs: this.config.pushMs }
      });
    } catch (error) {
      undo?.();
      if (!(error instanceof GitMissingError)) throw error;
      // No git here: the folder still works as it is, and versions and sharing wait for git.
      if (backend) this.warn(projectId, `git is not installed; sharing through "${chosen.id}" waits for it`);
      store = new FolderFileStore(dir, { detail: this.words()(backend ? "noGitShared" : "noGit"), onChange: (paths) => this.notify(projectId, paths) });
    }
    const raced = this.open.get(projectId);
    if (raced) {
      store.close();
      return raced.store;
    }
    this.open.set(projectId, { backend: chosen.id, store, configKey });
    if (configKey !== this.remoteKey(projectId)) {
      this.close(projectId);
      return this.openStore(projectId);
    }
    return store;
  }

  private archiveOf(projectId: string): FilesArchive {
    return new FilesArchive(path.join(this.ctx.storage.entry(projectId)!.dir!, ".tomrade", "files-archive"));
  }

  /** Put the live store aside for a scope it should not feed, and say where it went. */
  private park(projectId: string, dir: string, directory: string): () => void {
    const archive = this.archiveOf(projectId);
    // Stores parked here must not be committed as embedded repositories; storage's template lists them too.
    ensureIgnoreLine(path.join(path.dirname(archive.root), ".gitignore"), "files-archive/");
    const undo = archive.rotate(dir, directory);
    this.warn(projectId, `Files now show ${directory ? `${directory}/` : "the repository root"}; the previous files and their history are kept under ${archive.root}`);
    return undo;
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
      return unavailable(errorMessage(error));
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
    const current = await (await this.store(projectId)).readVersion(ref);
    if (current) return current;
    for (const archive of this.archiveStores(projectId)) {
      const content = await archive.readVersion(ref);
      if (content) return content;
    }
    return null;
  }

  /** Stores parked by an earlier scope, read but never opened: open() would scaffold and sync them. */
  private archiveStores(projectId: string): GitFileStore[] {
    if (!this.dirFor(projectId)) return [];
    return this.archiveOf(projectId).dirs().map((dir) => new GitFileStore({
      dir, git: gitRunner(this.config.gitBinary), gitBinary: this.config.gitBinary,
      remote: null, location: null, watch: false, warn: (m) => this.warn(projectId, m), onChange: () => {}
    }));
  }

  async locate(projectId: string, fileId: string): Promise<string | null> {
    return (await this.store(projectId)).locate(fileId);
  }

  /** The latest content wherever the file has moved; null when it is not here — deleted, or not synced to this machine yet. */
  async readById(projectId: string, fileId: string): Promise<FileContent | null> {
    const store = await this.store(projectId);
    const p = await store.locate(fileId);
    return p ? store.read(p) : null;
  }

  /** The resolver's view of linked files: where each is now, what it is. A missing id is left out, never an error. */
  async describeFiles(projectId: string, fileIds: string[]): Promise<FileDescription[]> {
    if (!this.dirFor(projectId) || !fileIds.length) return [];
    try {
      const store = await this.store(projectId);
      const found = await Promise.all([...new Set(fileIds)].map(async (fileId) => {
        const p = await store.locate(fileId);
        return p ? this.description(store, fileId, p) : null;
      }));
      return found.filter((d): d is FileDescription => d !== null);
    } catch (error) {
      this.warn(projectId, error);
      return [];
    }
  }

  private description(store: FileStore, fileId: string, rel: string): FileDescription | null {
    const abs = path.join(store.dir, ...rel.split("/"));
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat?.isFile()) return null;
    return { fileId, path: rel, name: path.posix.basename(rel), mime: mimeOf(rel), size: stat.size, localPath: abs };
  }

  async history(projectId: string, p: string, limit?: number): Promise<FileVersion[]> {
    return (await this.store(projectId)).history(p, limit);
  }

  /** The resolver tickets pin versions through: exact pair or null, never a guess. */
  async resolveVersion(projectId: string, ref: FileReference): Promise<FileReference | null> {
    if (!this.dirFor(projectId)) return null;
    try {
      const current = await (await this.store(projectId)).resolveVersion(ref);
      if (current) return current;
      for (const archive of this.archiveStores(projectId)) {
        const resolved = await archive.resolveVersion(ref);
        if (resolved) return resolved;
      }
      return null;
    } catch (error) {
      this.warn(projectId, error);
      return null;
    }
  }

  // ── writes ──────────────────────────────────────────────────────────────────

  /**
   * Run one operation and remember it as the versions before and after, so ⌘Z
   * can put its paths back. A store without `head`/`restore` is not undoable,
   * and an op that changed nothing leaves no record. Any record is a write:
   * the redo stack, here and in the backlog, is void.
   */
  private async recordOp<T>(
    projectId: string,
    store: FileStore,
    op: { kind: FileOpKind; path: string; target?: string | null; paths: string[] },
    run: () => Promise<T>
  ): Promise<{ result: T; ref: string | null }> {
    if (!store.head || !store.restore) return { result: await run(), ref: null };
    const base = await store.head();
    const result = await run();
    const head = await store.head();
    if (!base || !head || base === head) return { result, ref: null };
    const scope = writeContext.getStore();
    const row = this.ops.record({
      scopeId: storeId(store.dir),
      projectId,
      at: Date.now(),
      by: scope?.author ?? "human",
      runId: scope?.runId ?? null,
      kind: op.kind,
      path: normalizeRel(op.path),
      target: op.target ? normalizeRel(op.target) : null,
      paths: [...new Set(op.paths.map(normalizeRel).filter(Boolean))],
      base,
      head
    });
    this.ctx.oplog.forgetUndone(projectId);
    return { result, ref: `${Files.PROVIDER}:${row.seq}` };
  }

  private recordOf(op: FileOpRow): UndoRecord {
    const dir = this.dirFor(op.projectId);
    return {
      ref: `${Files.PROVIDER}:${op.seq}`,
      provider: Files.PROVIDER,
      id: String(op.seq),
      entity: "file",
      entityId: op.path,
      op: op.kind,
      label: op.kind === "import" || op.paths.length > 1 ? (op.paths.length <= 3 ? op.paths.join(", ") : `${op.paths.length} items`) : op.path,
      target: op.target,
      by: op.by,
      at: op.at,
      runId: op.runId,
      device: this.ctx.hub.deviceId,
      undoable: dir !== null && op.scopeId === storeId(dir),
      undoneAt: op.undoneAt
    };
  }

  private describeOp(op: FileOpRow): string {
    switch (op.kind) {
      case "write":
        return op.paths.length > 1 ? `Saved ${op.paths.length} files` : `Saved ${op.path}`;
      case "mkdir":
        return `Created folder ${op.path}`;
      case "move":
        return `Moved ${op.path} to ${op.target}`;
      case "copy":
        return `Copied ${op.path} to ${op.target}`;
      case "remove":
        return `Deleted ${op.path}`;
      case "import":
        return op.paths.length === 1 ? `Imported ${op.paths[0]}` : `Imported ${op.paths.length} items`;
    }
  }

  /** The files' place in ⌘Z and the history window: each op is put back or done again by restoring its paths. */
  private readonly provider: UndoProvider = {
    id: Files.PROVIDER,
    timeline: (projectId, limit) => (this.dirFor(projectId) ? this.ops.list(projectId, limit).map((op) => this.recordOf(op)) : []),
    undo: async (projectId, id) => {
      const op = this.ops.get(projectId, Number(id));
      if (!op) throw new Error("That file operation is no longer in the history");
      if (op.undoneAt !== null) throw new Error("That file operation is already undone");
      const store = await this.store(projectId);
      if (op.scopeId !== storeId(store.dir)) throw new Error(EARLIER_STORE);
      if (!store.restore) throw new Error("This files backend cannot restore versions");
      await store.restore(op.paths, op.head, op.base, `Undid: ${this.describeOp(op)}`);
      this.ops.markUndone(projectId, op.seq, Date.now());
      this.notify(projectId);
      return this.undoneSummary(op);
    },
    redo: async (projectId, id) => {
      const op = this.ops.get(projectId, Number(id));
      if (!op) throw new Error("That file operation is no longer in the history");
      if (op.undoneAt === null) throw new Error("That file operation is not undone");
      const store = await this.store(projectId);
      if (op.scopeId !== storeId(store.dir)) throw new Error(EARLIER_STORE);
      if (!store.restore) throw new Error("This files backend cannot restore versions");
      await store.restore(op.paths, op.base, op.head, `Redid: ${this.describeOp(op)}`);
      this.ops.markUndone(projectId, op.seq, null);
      this.notify(projectId);
      return `${this.describeOp(op)} again`;
    },
    forget: (projectId) => {
      if (this.dirFor(projectId)) this.ops.forget(projectId);
    }
  };

  private undoneSummary(op: FileOpRow): string {
    switch (op.kind) {
      case "write":
        return op.paths.length > 1 ? `Reverted ${op.paths.length} files` : `Reverted ${op.path}`;
      case "mkdir":
        return `Removed folder ${op.path}`;
      case "move":
        return `Moved ${op.target} back to ${op.path}`;
      case "copy":
        return `Removed the copy at ${op.target}`;
      case "remove":
        return `Restored ${op.path}`;
      case "import":
        return op.paths.length === 1 ? `Removed ${op.paths[0]}` : `Removed ${op.paths.length} imported items`;
    }
  }

  async write(projectId: string, p: string, body: Buffer | string, opts: WriteOptions = {}): Promise<FileContent> {
    const store = await this.store(projectId);
    const { result } = await this.recordOp(projectId, store, { kind: "write", path: p, paths: [p] }, () => store.write(p, Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"), opts));
    this.notify(projectId, [p]);
    return result;
  }

  /**
   * A save that refuses to land over somebody else's: with `expect` (the hash
   * the editor read) a file that moved on comes back as it is now instead.
   */
  async save(projectId: string, p: string, body: string, opts: { expect?: string | null; message?: string }): Promise<SaveResult> {
    try {
      return { ok: true, content: await this.write(projectId, p, body, opts) };
    } catch (error) {
      if (!(error instanceof FileChangedError)) throw error;
      return { ok: false, current: await this.read(projectId, p) };
    }
  }

  /** Several files as one version and one step of history; nothing lands when any `expect` fails. */
  async writeMany(projectId: string, entries: { path: string; body: string | Buffer; expect?: string | null }[], opts: { message?: string } = {}): Promise<string | null> {
    const store = await this.store(projectId);
    if (!store.writeMany) throw new Error("This Files backend cannot save several files at once");
    const files = entries.map((e) => ({ path: e.path, body: Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body, "utf8"), expect: e.expect }));
    const { ref } = await this.recordOp(projectId, store, { kind: "write", path: entries[0]?.path ?? "", paths: entries.map((e) => e.path) }, () => store.writeMany!(files, opts));
    this.notify(projectId, entries.map((e) => e.path));
    return ref;
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
    const folders: { src: string; rel: string }[] = [];
    const files: { src: string; rel: string }[] = [];
    for (const src of sources) {
      const name = path.basename(src);
      if (name.startsWith(".")) continue;
      const rel = target ? `${target}/${name}` : name;
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        if (fs.existsSync(path.join(store.dir, ...rel.split("/")))) throw new Error(`${rel} already exists`);
        folders.push({ src, rel });
        names.add(name);
      } else if (stat.isFile()) {
        files.push({ src, rel });
        names.add(name);
      }
    }
    await this.recordOp(projectId, store, { kind: "import", path: target, paths: [...folders, ...files].map((f) => f.rel) }, async () => {
      for (const folder of folders) copyTree(folder.src, path.join(store.dir, ...folder.rel.split("/")));
      // Folders are saved before any file write stages them under the file's message.
      if (folders.length) await store.settle(folders.length === 1 ? `Imported folder ${folders[0]!.rel}` : `Imported ${folders.length} folders`);
      for (const file of files) await store.write(file.rel, fs.readFileSync(file.src), { message: `Imported ${file.rel}` });
    });
    this.notify(projectId, [...folders, ...files].map((f) => f.rel));
    return (await store.list(target)).filter((e) => names.has(e.name));
  }

  /** Each write returns the history record it made — `files:<seq>`, for `oplog.revert` — or null when nothing changed. */
  async mkdir(projectId: string, p: string): Promise<string | null> {
    const store = await this.store(projectId);
    const { ref } = await this.recordOp(projectId, store, { kind: "mkdir", path: p, paths: [p] }, () => store.mkdir(p));
    this.notify(projectId, [p]);
    return ref;
  }

  async move(projectId: string, from: string, to: string): Promise<string | null> {
    const store = await this.store(projectId);
    const { ref } = await this.recordOp(projectId, store, { kind: "move", path: from, target: to, paths: [from, to] }, () => store.move(from, to));
    this.notify(projectId, [from, to]);
    if (ref) await this.home.parallel("files/moved", projectId, normalizeRel(from), normalizeRel(to));
    return ref;
  }

  async copy(projectId: string, from: string, to: string): Promise<string | null> {
    const store = await this.store(projectId);
    const { ref } = await this.recordOp(projectId, store, { kind: "copy", path: from, target: to, paths: [to] }, () => store.copy(from, to));
    this.notify(projectId, [to]);
    return ref;
  }

  async remove(projectId: string, p: string): Promise<string | null> {
    const store = await this.store(projectId);
    const { ref } = await this.recordOp(projectId, store, { kind: "remove", path: p, paths: [p] }, () => store.remove(p));
    this.notify(projectId, [p]);
    return ref;
  }

  // ── sync and conflicts ──────────────────────────────────────────────────────

  async syncPolicy(projectId: string): Promise<FilesSyncPolicy> {
    const store = await this.store(projectId);
    if (!store.syncPolicy) throw new Error("This Files backend does not support selective sharing");
    return store.syncPolicy();
  }

  async setSyncRules(projectId: string, paths: string[], mode: SyncMode | "inherit"): Promise<FilesSyncPolicy> {
    const validMode = z.enum(["shared", "local", "inherit"]).parse(mode);
    const normalized = [...new Set(z.array(z.string()).min(1).parse(paths).map(normalizeRel))];
    const store = await this.store(projectId);
    if (!store.setSyncRules) throw new Error("This Files backend does not support selective sharing");
    const policy = await store.setSyncRules(normalized, validMode);
    this.notify(projectId);
    return policy;
  }

  async agentPolicy(projectId: string): Promise<FilesAgentPolicy> {
    const store = await this.store(projectId);
    return store.agentPolicy ? store.agentPolicy() : { ...DEFAULT_AGENT_POLICY };
  }

  async setAgentRules(projectId: string, paths: string[], mode: ListMode | "inherit"): Promise<FilesAgentPolicy> {
    const validMode = z.enum(["listed", "unlisted", "inherit"]).parse(mode);
    const normalized = [...new Set(z.array(z.string()).min(1).parse(paths).map(normalizeRel))];
    const store = await this.store(projectId);
    if (!store.setAgentRules) throw new Error("This Files backend does not keep an agent index");
    const policy = await store.setAgentRules(normalized, validMode);
    this.notify(projectId);
    return policy;
  }

  /** Text across the project's files. A backend that cannot search says so rather than pretending to find nothing. */
  async search(projectId: string, input: FileSearchInput): Promise<FileSearchResult> {
    const store = await this.store(projectId);
    if (!store.search) throw new Error("This Files backend does not support search");
    const policy = await this.agentPolicy(projectId);
    const result = await store.search(input);
    // A path the caller named is answered as asked; an open search volunteers only what the index would.
    if (input.path) return result;
    return { ...result, hits: result.hits.filter((hit) => listingAt(policy, hit.path).mode === "listed") };
  }

  /**
   * What an agent is told this project holds. Discovery only: everything here
   * is also reachable without it, and what is left out is reachable too.
   */
  async agentIndex(projectId: string, opts: { budget?: number; focus?: string[]; native?: boolean } = {}): Promise<AgentIndex | null> {
    const dir = this.dirFor(projectId);
    if (!dir) return null;
    // No folder and no remote means no files: opening the store would only create it, git and all, before a turn.
    if (!fs.existsSync(dir) && !this.remoteOf(projectId)) return null;
    const [entries, policy] = await Promise.all([this.tree(projectId), this.agentPolicy(projectId)]);
    if (!entries.length) return null;
    const store = await this.store(projectId);
    return buildAgentIndex({
      entries,
      policy,
      titleOf: (entry) => this.titleOf(store.dir, entry),
      budget: opts.budget,
      focus: opts.focus,
      native: opts.native,
      root: store.dir
    });
  }

  /**
   * The heading a document gives itself: front matter first, then the first
   * heading, and for a folder its README's. Only the head of a file is read,
   * and only once per version of it — an index is rebuilt on every turn.
   */
  private titleOf(dir: string, entry: FileEntry): string | null {
    const rel = entry.kind === "dir" ? `${entry.path}/README.md` : entry.path;
    if (entry.kind === "file" && !TITLED.test(entry.name)) return null;
    const abs = path.join(dir, ...rel.split("/"));
    let stamp: string;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return null;
      stamp = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
      return null;
    }
    const cached = this.titles.get(rel);
    if (cached?.stamp === stamp) return cached.title;
    const title = readTitle(abs);
    if (this.titles.size > 5_000) this.titles.clear();
    this.titles.set(rel, { stamp, title });
    return title;
  }

  /**
   * The index as a prompt wants it: the person's budget, and the ticket's own
   * folder kept open whatever that budget is.
   */
  async indexFor(projectId: string, native: boolean, itemId?: string): Promise<AgentIndex | null> {
    const budget = (this.home.get("settings")?.get().files as FilesSettings | undefined)?.agentIndexTokens ?? FILES_SECTION.defaults.agentIndexTokens;
    if (budget <= 0) return null;
    let focus: string[] = [];
    if (itemId) {
      try {
        focus = [this.folderFor(projectId, itemId)];
      } catch {
        // a ticket without a workstream simply has no folder to keep open
      }
    }
    return this.agentIndex(projectId, { budget, focus, native });
  }

  async sync(projectId: string, opts: { quiet?: boolean } = {}): Promise<FilesStatus> {
    // Git installed since the folder was opened without it: the same folder becomes a git store.
    if (this.open.get(projectId)?.store instanceof FolderFileStore && (await gitInstalled(this.config.gitBinary))) await this.reopen(projectId, true);
    const before = this.lastState.get(projectId);
    const toldBefore = this.told.get(projectId) ?? 0;
    const status = await (await this.store(projectId)).sync(opts);
    this.lastState.set(projectId, status.state);
    this.home.emit("files/synced", projectId, status);
    // Said once more once the sync settles, unless it was the minute's sweep over a quiet project.
    if (status.state !== before || (this.told.get(projectId) ?? 0) !== toldBefore) this.notify(projectId);
    return status;
  }

  /** The sweep: every project open on this machine with files, or a remote, is saved and synced. */
  async syncAll(): Promise<void> {
    const now = Date.now();
    for (const projectId of this.ctx.db.openIds()) {
      const dir = this.dirFor(projectId);
      if (!dir) continue;
      if (!this.open.has(projectId) && !this.remoteOf(projectId) && !fs.existsSync(dir)) continue;
      // A folder watched for edits, with no remote to hear from, is saved as it changes; the sweep is only a safety net.
      // With a remote, its news is fetched every sweep while a window shows, and rarely while none does.
      const rare = this.remoteOf(projectId) ? !this.seen : !!this.open.get(projectId)?.store.watching?.();
      if (rare && now - (this.swept.get(projectId) ?? 0) < this.config.rareSyncMs) continue;
      this.swept.set(projectId, now);
      try {
        await this.sync(projectId, { quiet: true });
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
    const target = await backend.repository?.(config);
    if (target && collidesWithProject(target, await this.projectRepository(projectId))) throw new ProjectRepositoryError(this.config.folder);
    const previous = this.remoteOf(projectId);
    this.remotes.set(projectId, backendId, config);
    const attempted = this.remoteKey(projectId);
    try {
      await this.reopen(projectId, true);
    } catch (error) {
      // Do not overwrite a newer binding imported while the backend was opening.
      if (this.remoteKey(projectId) === attempted) {
        this.close(projectId);
        this.remotes.restore(projectId, previous);
        try {
          await this.store(projectId);
        } catch (recovery) {
          this.warn(projectId, `The previous Files store could not reopen: ${errorMessage(recovery)}`);
        }
      }
      throw error;
    }
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

  /**
   * Where a ticket's files land unless a path says otherwise: a top-level
   * folder named after its workstream. A name, not a binding — renaming the
   * workstream starts a new folder and moves nothing.
   */
  folderFor(projectId: string, itemId: string): string {
    const item = this.ticketOf(projectId, itemId);
    const board = this.ctx.boards.get(projectId, item.boardId);
    if (!board) throw new NotFoundError(item.boardId);
    return folderName(board.name);
  }

  /** Agents name tickets by key as often as by id, like every other item tool accepts. */
  private ticketOf(projectId: string, idOrKey: string): Item {
    const byId = this.ctx.items.get(projectId, idOrKey);
    if (byId) return byId;
    const key = idOrKey.trim();
    const byKey = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key) ? this.ctx.items.getByKey(projectId, key) : null;
    // getByKey matches the number alone, so OTHER-12 must not land on TOM-12
    if (!byKey || byKey.key.toUpperCase() !== key.toUpperCase()) throw new NotFoundError(idOrKey);
    return byKey;
  }

  /** A ticket links a file by id and version; a folder without git has neither, and pretending would break the link once git arrives. */
  private needVersions(store: FileStore): FileStore {
    if (store instanceof FolderFileStore) throw new Error(this.words()("needsGit"));
    return store;
  }

  /** `path` inside the ticket's workstream folder. */
  pathFor(projectId: string, itemId: string, p: string): string {
    const rel = normalizeRel(p);
    if (!rel) throw new InvalidPathError(p);
    return `${this.folderFor(projectId, itemId)}/${rel}`;
  }

  /** Bring files from this machine into the ticket's workstream folder and pin them in one go. */
  async importFor(projectId: string, itemId: string, input: { sources: string[]; role: "input" | "output" }): Promise<Item> {
    const folder = this.folderFor(projectId, itemId);
    this.needVersions(await this.store(projectId));
    const added = (await this.importFiles(projectId, folder, input.sources)).filter((e) => e.kind === "file");
    if (!added.length) throw new Error("Choose at least one file");
    return this.attachMany(projectId, itemId, { paths: added.map((e) => e.path), role: input.role });
  }

  /**
   * Files a ticket body is about to link to, saved under
   * `<workstream>/attachments/<KEY>/` as one version and one step of history.
   * A name already taken there, or earlier in the batch, gets a number.
   */
  async addAttachments(projectId: string, itemId: string, files: AttachmentInput[]): Promise<FileDescription[]> {
    if (!files.length) return [];
    const item = this.ctx.items.get(projectId, itemId);
    if (!item) throw new NotFoundError(itemId);
    const folder = `${this.folderFor(projectId, itemId)}/attachments/${folderName(item.key)}`;
    const store = this.needVersions(await this.store(projectId));
    const chosen = new Set<string>();
    const entries = files.map((file) => {
      const body = Buffer.from(file.base64, "base64");
      const name = attachmentName(file.name);
      if (body.length > BINARY_LIMIT) throw new Error(`${name} is larger than ${BINARY_LIMIT / (1024 * 1024)} MB; add it in Files instead`);
      const free = freeName(name, (candidate) => chosen.has(candidate.toLowerCase()) || fs.existsSync(path.join(store.dir, ...folder.split("/"), candidate)));
      chosen.add(free.toLowerCase());
      return { path: `${folder}/${free}`, body, expect: null };
    });
    const names = entries.map((e) => path.posix.basename(e.path));
    await this.writeMany(projectId, entries, { message: names.length === 1 ? `Attached ${names[0]} to ${item.key}` : `Attached ${names.length} files to ${item.key}` });
    const ids = new Map((await store.list(folder)).map((e) => [e.path, e.fileId]));
    return entries.map((e) => {
      const fileId = ids.get(e.path);
      const described = fileId ? this.description(store, fileId, e.path) : null;
      if (!described) throw new Error(`${e.path} was saved without an id`);
      return described;
    });
  }

  /** Pin the file's latest version to a ticket. The working copy is saved first, so what is pinned is what is there. */
  async attach(projectId: string, itemId: string, input: { path: string; role: "input" | "output"; name?: string }): Promise<Item> {
    return this.attachMany(projectId, itemId, { paths: [input.path], role: input.role, names: input.name ? { [normalizeRel(input.path)]: input.name } : undefined });
  }

  /** Settle once and add every chosen file to the ticket in one item write. */
  async attachMany(projectId: string, itemId: string, input: { paths: string[]; role: "input" | "output"; names?: Record<string, string> }): Promise<Item> {
    const store = this.needVersions(await this.store(projectId));
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
