import type { z } from "zod";
import type {
  Author,
  Board,
  CreateItemInput,
  FieldDef,
  FieldOption,
  FieldType,
  FieldValue,
  FilterClause,
  Item,
  ListItemsFilter,
  OplogEntity,
  OplogEntry,
  OplogOp,
  Patch,
  Project,
  SortKey,
  View
} from "@tomradex/domain";

/**
 * The plugin contract. Everything a plugin reaches returns a Promise, and every
 * function it hands the host may return one: the same code runs in the app's
 * process today and behind a process boundary later. Values that cross are
 * plain data — never a live object of the host's.
 */

export type Disposer = () => void;

/** The services a plugin names in `inject` (required) or `optional`. */
export type ServiceName = "items" | "fields" | "boards" | "views" | "projects" | "db" | "settings" | "tools" | "contributions" | "agent" | "surfaces" | "oplog";

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ItemQuery {
  projectId: string;
  filter?: FilterClause[];
  sortBy?: SortKey[];
  search?: string;
  limit?: number;
  widen?: boolean;
}

/** Writes never take an author: the host says who wrote — a person, the agent run it serves, or the plugin itself. */
export interface ItemsApi {
  list(filter?: ListItemsFilter): Promise<Item[]>;
  query(q: ItemQuery): Promise<Item[]>;
  get(projectId: string, id: string): Promise<Item | null>;
  getByKey(projectId: string, key: string): Promise<Item | null>;
  create(input: Omit<CreateItemInput, "by">): Promise<Item>;
  update(projectId: string, id: string, patch: Patch, opts?: { baseVersion?: number }): Promise<Item>;
  delete(projectId: string, id: string): Promise<void>;
  addRelation(projectId: string, id: string, blockedId: string): Promise<void>;
  removeRelation(projectId: string, id: string, blockedId: string): Promise<void>;
  labels(projectId: string): Promise<string[]>;
}

export interface FieldsApi {
  list(projectId: string): Promise<FieldDef[]>;
  get(projectId: string, id: string): Promise<FieldDef | null>;
  create(input: { projectId: string; name: string; type: FieldType; options?: { name: string; description?: string | null }[] }): Promise<FieldDef>;
  update(projectId: string, id: string, patch: { name?: string; rank?: number }): Promise<FieldDef>;
  remove(projectId: string, id: string): Promise<void>;
  addOption(projectId: string, fieldId: string, input: { name: string; description?: string | null }): Promise<FieldOption>;
}

export interface BoardsApi {
  list(projectId: string): Promise<Board[]>;
  get(projectId: string, id: string): Promise<Board | null>;
  defaultFor(projectId: string): Promise<Board>;
}

export interface ViewsApi {
  list(projectId: string): Promise<View[]>;
  get(projectId: string, id: string): Promise<View | null>;
}

export interface ProjectsApi {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
}

/** `"hub"` addresses the Hub's own database, for tables migrated with `scope: "hub"`. */
export type DbTarget = string;
export type SqlParams = unknown[] | Record<string, unknown>;

export interface TableSpec {
  /** Project-scope tables: the column holding the project id, or a chain through another table. */
  project?: string | { via: string; table: string };
  /** Exported tables travel in the project's folder; `false` keeps them on this machine. */
  export: { order: string; appendOnly?: boolean; always?: boolean } | false;
}

/**
 * Plain SQL against the caches. The namespace is the plugin's own: tables are
 * `plugin_<namespace>_*`. Reads of the app's tables are allowed; writing them
 * goes around history and undo, and the install dialog says so.
 */
export interface DbApi {
  migrate(steps: { version: number; up: string }[], opts: { scope?: "project" | "hub"; tables: Record<string, TableSpec> }): Promise<void>;
  all<T = Record<string, unknown>>(target: DbTarget, sql: string, params?: SqlParams): Promise<T[]>;
  get<T = Record<string, unknown>>(target: DbTarget, sql: string, params?: SqlParams): Promise<T | undefined>;
  run(target: DbTarget, sql: string, params?: SqlParams): Promise<{ changes: number; lastInsertRowid: number }>;
  /** One transaction: every statement lands, or none does. */
  batch(target: DbTarget, statements: { sql: string; params?: SqlParams }[]): Promise<{ changes: number }[]>;
  isOpen(projectId: string): Promise<boolean>;
}

export interface SettingsSectionSpec<T> {
  /** Defaults to the namespace; otherwise it must start with it. */
  id?: string;
  title: string;
  description?: string;
  schema: z.ZodType<T>;
  defaults: T;
  scope?: "machine" | "user";
}

export interface SettingsApi {
  register<T>(section: SettingsSectionSpec<T>): Promise<void>;
  get<T = unknown>(id?: string): Promise<T>;
  set<T = unknown>(value: T, id?: string): Promise<void>;
}

export interface ToolInvocation {
  projectId?: string;
  /** Present when an agent run made the call. */
  runId?: string;
  author: Author;
}

export interface ToolSpec<S extends z.ZodObject = z.ZodObject> {
  /** Must start with the plugin's namespace. */
  name: string;
  title: string;
  description: string;
  input: S;
  execute(args: z.output<S>, invocation: ToolInvocation): unknown | Promise<unknown>;
}

export interface ToolCallInfo {
  name: string;
  args: unknown;
  author: Author;
  projectId?: string;
  runId?: string;
}

export interface ToolsApi {
  register<S extends z.ZodObject>(tool: ToolSpec<S>): Promise<Disposer>;
  list(): Promise<{ name: string; title: string; description: string; inputSchema: Record<string, unknown> }[]>;
  call(name: string, args: unknown, opts?: { projectId?: string }): Promise<unknown>;
  /** A policy over every tool call: throw to refuse it. */
  gate(check: (call: ToolCallInfo) => void | Promise<void>): Promise<Disposer>;
}

export type BadgeTone = "faint" | "neutral" | "strong";
export interface Badge {
  id: string;
  label: string;
  tone?: BadgeTone;
  title?: string;
}
export interface CommandScope {
  projectId?: string;
  boardId?: string;
  viewId?: string;
  itemId?: string | null;
}
export type SectionState = "live" | "waiting" | "idle" | "ended" | "lost" | "ok" | "warn";
export interface SectionRow {
  label: string;
  value: string;
  icon?: string;
  mono?: boolean;
  state?: SectionState;
  href?: string;
  command?: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  tone?: BadgeTone | "danger";
  title?: string;
}

type Maybe<T> = T | Promise<T>;

/** Ids must equal the namespace or start with it followed by `.`, `-` or `_`. */
export interface ContributionsApi {
  command(def: { id: string; title: string; group?: string; shortcut?: string; run(scope: CommandScope): Maybe<{ toast?: string } | void> }): Promise<Disposer>;
  badge(def: { id: string; compute(items: Item[], scope: { projectId: string }): Maybe<Record<string, Badge[]>> }): Promise<Disposer>;
  statusItem(def: { id: string; text(scope: { projectId?: string }): Maybe<string | null> }): Promise<Disposer>;
  section(def: { id: string; title: string; render(item: Item): Maybe<{ rows?: SectionRow[]; text?: string } | null> }): Promise<Disposer>;
  graph(def: { id: string; title: string; icon?: string; edits?: "blocks"; compute(items: Item[], scope: { projectId: string }): Maybe<GraphEdge[]> }): Promise<Disposer>;
}

export interface PlaybookSpec {
  /** Must start with the namespace. */
  id: string;
  title: string;
  /** One line the agent reads to decide when to open it. */
  when: string;
  body: string;
  tools?: string[];
}

export interface AgentApi {
  playbook(spec: PlaybookSpec): Promise<Disposer>;
}

export interface SurfaceSpec {
  id: string;
  title: string;
  /** A document inside the plugin's package, relative to its root. Remote pages are refused. */
  document: string;
  width: number;
  height: number;
  transparent?: boolean;
  alwaysOnTop?: boolean;
  clickThrough?: boolean;
  initialState?: unknown;
  /** Messages the document sends; a person is driving, so writes made here are theirs. */
  onMessage?(message: unknown): Maybe<void>;
}

export interface SurfaceHandle {
  readonly id: string;
  setState(state: unknown): Promise<void>;
  setPosition(x: number, y: number): Promise<void>;
  bounds(): Promise<{ x: number; y: number; width: number; height: number }>;
  workArea(): Promise<{ x: number; y: number; width: number; height: number }>;
  close(): Promise<void>;
}

export interface SurfacesApi {
  open(spec: SurfaceSpec): Promise<SurfaceHandle>;
}

export interface OplogApi {
  recent(projectId: string, limit?: number): Promise<OplogEntry[]>;
  history(projectId: string, entity: OplogEntity, id: string, limit?: number): Promise<OplogEntry[]>;
}

/** What landed, as the host tells every listener after the commit. */
export interface WriteEvent {
  projectId: string;
  entity: OplogEntity;
  op: OplogOp;
  id: string;
  by: Author;
  via: string | null;
  runId: string | null;
}

export interface Events {
  write: (event: WriteEvent) => Maybe<void>;
  "tool.result": (call: ToolCallInfo, outcome: { ok: boolean; error?: string }) => Maybe<void>;
  "project.opened": (projectId: string) => Maybe<void>;
  "project.closed": (projectId: string) => Maybe<void>;
  "settings.changed": () => Maybe<void>;
}

export interface PluginContext {
  /** `publisher/name` for an extension; the row id for a built-in. */
  readonly id: string;
  readonly namespace: string;
  readonly logger: Logger;
  /** A directory only this plugin writes to, kept across updates; null for a built-in. */
  readonly dataDir: string | null;
  readonly items: ItemsApi;
  readonly fields: FieldsApi;
  readonly boards: BoardsApi;
  readonly views: ViewsApi;
  readonly projects: ProjectsApi;
  readonly db: DbApi;
  readonly settings: SettingsApi;
  readonly tools: ToolsApi;
  readonly contributions: ContributionsApi;
  readonly agent: AgentApi;
  readonly surfaces: SurfacesApi;
  readonly oplog: OplogApi;
  on<K extends keyof Events>(event: K, listener: Events[K]): Disposer;
  /** Runs `fn` while an optional service is present; what it returns is disposed when the service goes. */
  when(name: ServiceName, fn: (ctx: PluginContext) => Maybe<Disposer | void>): Disposer;
  /** Whether a service is present right now. */
  has(name: ServiceName): boolean;
  /** Cleanup that runs when the plugin unloads. */
  effect(fn: () => Maybe<Disposer>): void;
  /** A timer cleared with the plugin. */
  interval(fn: () => Maybe<void>, ms: number): Disposer;
}
