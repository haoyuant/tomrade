import type { z } from "zod";
import type { ImApi } from "./im.js";
import type { TerminalsApi } from "./terminals.js";
import type { WebSearchApi } from "./web-search.js";
import type { ModelsApi } from "./models.js";
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

/** A language the app may be speaking: a BCP 47 tag such as "en", "zh", "zh-Hant" or one a language pack adds ("pt-BR"). SDK 0.2.8 widened it from "en" | "zh". */
export type Locale = string;
/** Text in the app's language: a plain string, or one per language tag picked each time it is shown (English is the fallback). */
export type Localized = string | ({ en: string } & Partial<Record<Locale, string>>);

/** A settings section's text in one language; fields are keyed by schema property. */
export interface SectionWords {
  title?: string;
  description?: string;
  fields?: Record<string, { title?: string; description?: string; options?: Record<string, string> }>;
}

/** The services a plugin names in `inject` (required) or `optional`. */
export type ServiceName = "items" | "fields" | "boards" | "views" | "projects" | "db" | "settings" | "tools" | "contributions" | "agent" | "surfaces" | "alerts" | "oplog" | "im" | "webSearch" | "terminals" | "models";

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
  /**
   * SDK 0.2.12: a policy over every write before it lands — items, and the workstream and view
   * writes that take the same path — whoever writes. Throw to refuse it. It is asked inside the
   * write's transaction, so it must answer at once: a check that returns a Promise is not waited
   * for, and the write goes on.
   */
  gate(check: (write: PendingWrite) => void): Promise<Disposer>;
}

/** SDK 0.2.12: a write about to land, as a write gate sees it. A copy: changing it changes nothing. */
export interface PendingWrite<T = unknown> {
  projectId: string;
  entity: OplogEntity;
  op: OplogOp;
  id: string;
  by: Author;
  /** The extension making the write, when one is. */
  via: string | null;
  runId: string | null;
  /** The version the writer read, when it asserts one. */
  baseVersion: number | null;
  before: T | null;
  after: T | null;
  /** For an update: only the fields the writer asked to change. */
  patch: Record<string, unknown> | null;
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
  /**
   * Exported tables travel in the project's folder; `false` keeps them on this machine.
   * `private` rows (conversations, say) never travel to a remote known to be public.
   */
  export: { order: string; appendOnly?: boolean; always?: boolean; private?: boolean } | false;
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
  /** Drawn from its JSON Schema; a field with `.meta({ advanced: true })` is folded under Advanced. */
  schema: z.ZodType<T>;
  defaults: T;
  scope?: "machine" | "user";
  /** What agents may do with it through get_settings / update_settings. Defaults to read; a section holding a password is none. */
  agent?: "write" | "read" | "none";
  /** The card in other languages; `title`, `description` and the schema's own labels are the English. */
  words?: Partial<Record<Locale, SectionWords>>;
}

export interface SettingsApi {
  register<T>(section: SettingsSectionSpec<T>): Promise<void>;
  get<T = unknown>(id?: string): Promise<T>;
  set<T = unknown>(value: T, id?: string): Promise<void>;
  /** Opens the app's Settings on this plugin's section, bringing the window forward — for a click outside the window. */
  show(id?: string): Promise<void>;
  /** The app's language now. It is a setting: `settings.changed` fires when the person switches it. */
  locale(): Promise<Locale>;
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
  /** A kit few conversations need: the tool is left out of each request until the model loads the kit. Named like the tool. */
  kit?: string;
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
  /** What a kit is for, in a few words the model reads before it loads the kit ("a focus timer"). */
  kit(id: string, purpose: string): Promise<Disposer>;
  list(): Promise<{ name: string; title: string; description: string; inputSchema: Record<string, unknown> }[]>;
  call(name: string, args: unknown, opts?: { projectId?: string }): Promise<unknown>;
  /**
   * A policy over every tool call: throw to refuse it. SDK 0.2.12: or answer `{ args }` to go on with
   * other arguments (checked against the tool's input again), or `{ result }` to answer in the tool's place.
   */
  gate(check: (call: ToolCallInfo) => ToolGateAnswer | void | Promise<ToolGateAnswer | void>): Promise<Disposer>;
}

/** SDK 0.2.12: what a tool gate may answer besides letting the call through unchanged. `result` wins over `args`. */
export type ToolGateAnswer = { args: unknown } | { result: unknown };

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
export interface SidebarRow {
  id: string;
  label: string;
  icon?: string;
  detail?: string;
  count?: number | string;
  command?: string;
  href?: string;
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
  command(def: { id: string; title: Localized; group?: Localized; shortcut?: string; run(scope: CommandScope): Maybe<{ toast?: string } | void> }): Promise<Disposer>;
  badge(def: { id: string; compute(items: Item[], scope: { projectId: string }): Maybe<Record<string, Badge[]>> }): Promise<Disposer>;
  /**
   * A status bar item. `command` (in the plugin's namespace) runs on click, or `menu` lists actions the click
   * opens instead; `until` returns an epoch ms the renderer counts down to after the text, without polling.
   * Everything is re-read when `refresh()` is called.
   */
  statusItem(def: { id: string; text(scope: { projectId?: string }): Maybe<string | null>; title?: Localized; icon?: string; align?: "start" | "end"; command?: string; until?(scope: { projectId?: string }): Maybe<number | null>; menu?(scope: { projectId?: string }): Maybe<{ title: string; command: string; icon?: string }[] | null> }): Promise<Disposer>;
  /** Every window re-reads this plugin's contributions — for state that changed outside a command run. */
  refresh(): Promise<void>;
  section(def: { id: string; title: Localized; render(item: Item): Maybe<{ rows?: SectionRow[]; text?: string } | null> }): Promise<Disposer>;
  graph(def: { id: string; title: string; icon?: string; edits?: "blocks"; compute(items: Item[], scope: { projectId: string }): Maybe<GraphEdge[]> }): Promise<Disposer>;
  /** A module in the project sidebar. Without `rows` it is a single door; rows returning null hide it in that project. */
  sidebarModule(def: { id: string; title: Localized; icon?: string; command?: string; rows?(scope: { projectId: string }): Maybe<SidebarRow[] | null> }): Promise<Disposer>;
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

/** SDK 0.2.14: one block of a model message, as an in-app conversation sends it. */
export type ModelContent =
  | { type: "text"; text: string }
  | { type: "media"; media: { mime: string; base64: string; name: string } }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; content: string; isError?: boolean }
  | { type: "native"; provider: string; data: unknown };

export interface ModelMessage {
  role: "user" | "assistant";
  content: ModelContent[];
}

/** A tool as the model is offered it; `inputSchema` is JSON Schema. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Which turn, step and model profile a request belongs to. */
export interface TurnInfo {
  runId: string;
  threadId: string;
  projectId: string;
  purpose: string;
  profile: string;
  step: number;
}

/** SDK 0.2.14: one model request an in-app conversation is about to send. A copy: what the hook answers is what changes. */
export interface ModelRequest {
  system: string;
  tools: ModelTool[];
  messages: ModelMessage[];
  turn: TurnInfo;
}

export type ModelRequestChange = Partial<Pick<ModelRequest, "system" | "tools" | "messages">>;

export interface ModelRequestFailure {
  /** What the provider or the network said. */
  message: string;
  request: ModelRequest;
  /** How many times this step was already sent again on a hook's answer. */
  attempt: number;
}

/** Send the request again: changed, on another model profile (an id from the person's profiles), or both. */
export interface ModelRetry {
  request?: ModelRequestChange;
  profile?: string;
}

export interface TurnEnding {
  /** What the model said last. */
  text: string;
  turn: TurnInfo;
  /** How many times this turn was already kept going. */
  continued: number;
}

/**
 * The agent's in-app conversations. The three hooks (SDK 0.2.14) reach the
 * conversation Tomrade runs itself (`engine-loop`); CLI agents — Claude Code,
 * Codex, dsh and the rest — run their own loop and send nothing through them.
 */
export interface AgentApi {
  playbook(spec: PlaybookSpec): Promise<Disposer>;
  /** Before each model request: answer the parts to send instead, or nothing to leave it as it is. */
  request(hook: (request: ModelRequest) => Maybe<ModelRequestChange | void>): Promise<Disposer>;
  /** A model request failed: answer what to try instead, or nothing to let the failure stand. The first plugin to answer decides. */
  requestError(hook: (failure: ModelRequestFailure) => Maybe<ModelRetry | void>): Promise<Disposer>;
  /** A turn is about to end: answer `{ continue }` with a message to the model to keep it going. Bounded, so it cannot run forever. */
  turnEnding(hook: (ending: TurnEnding) => Maybe<{ continue: string } | void>): Promise<Disposer>;
  /**
   * SDK 0.2.15: a hook in the CLI agents Tomrade works with — Claude Code, Codex, dsh and the rest. It
   * hears their sessions and, in one Tomrade started, may answer: see `CLI_HOOK_COVERAGE` for which.
   */
  cliHook(spec: CliHookSpec): Promise<Disposer>;
}

export type { CliHookEvent } from "./cli-hooks.js";

/** SDK 0.2.15: what a CLI agent's hook says happened, whichever agent sent it. */
export interface CliHookCall {
  event: import("./cli-hooks.js").CliHookEvent;
  /** `claude-code`, `codex`, `dsh`, `pi`, `workbuddy`, `cursor`, `opencode`, `hermes`… */
  agent: string;
  /** Whether an answer reaches the agent: a session Tomrade started, by an agent that acts on this event. */
  answerable: boolean;
  projectId: string;
  /** Tomrade's code session the hook belongs to. */
  sessionId: string;
  /** The ticket the session works, when it has one. */
  ticket: string | null;
  cwd: string | null;
  tool?: { name: string; input: unknown; output?: string; error?: string };
  /** What the model said last, at `stop`. */
  text?: string;
  /** The hook's own payload, as the agent sent it. */
  raw: Record<string, unknown>;
}

/** Refuse the tool (`pre-tool`), add context for the model (`session-start`, `prompt`, `post-tool`), or keep the turn going (`stop`). */
export interface CliHookAnswer {
  deny?: string;
  context?: string;
  continue?: string;
}

export interface CliHookSpec {
  /** The events it hears; all of them when left out. */
  events?: import("./cli-hooks.js").CliHookEvent[];
  /** A regular expression the tool's name must match, for `pre-tool` and `post-tool`. */
  tools?: string;
  /** The agents it hears; all of them when left out. */
  agents?: string[];
  handle(call: CliHookCall): Maybe<CliHookAnswer | void>;
}

export interface SurfaceSpec {
  id: string;
  title: string;
  /**
   * SDK 0.2.11: `"window"` is a working window — title bar, resizable, closable, in the Dock or
   * taskbar, its bounds remembered — and needs `permissions.window`. The default `"widget"` is
   * the fixed, frameless surface it always was. A window's title carries the plugin's own.
   */
  kind?: "widget" | "window";
  /** SDK 0.2.11, windows only: how small the person may make it. */
  minWidth?: number;
  minHeight?: number;
  /** A document inside the plugin's package, relative to its root. Remote pages are refused. */
  document: string;
  width: number;
  height: number;
  transparent?: boolean;
  alwaysOnTop?: boolean;
  /** Allow keyboard input; defaults to false for passive widgets. */
  focusable?: boolean;
  clickThrough?: boolean;
  /** First placed on top of an app element by name — `"sidebar-foot"`: just above the sidebar's Project settings. */
  anchor?: string;
  initialState?: unknown;
  /** Messages the document sends; a person is driving, so writes made here are theirs. */
  onMessage?(message: unknown): Maybe<void>;
  /** Once, when the window is gone — the person closed it, `close()` did, or the plugin unloaded. The handle's other calls then reject. */
  onClose?(): Maybe<void>;
}

export interface SurfaceHandle {
  readonly id: string;
  setState(state: unknown): Promise<void>;
  /** SDK 0.2.11: one message to the document's `tomradeSurface.onMessage`, for frequent small updates; `setState` replaces the whole state. */
  post(message: unknown): Promise<void>;
  setPosition(x: number, y: number): Promise<void>;
  bounds(): Promise<{ x: number; y: number; width: number; height: number }>;
  workArea(): Promise<{ x: number; y: number; width: number; height: number }>;
  close(): Promise<void>;
}

export interface SurfacesApi {
  open(spec: SurfaceSpec): Promise<SurfaceHandle>;
}

/** A sound the machine offers: `system:<name>`. A file the person chose is played by its absolute path. */
export interface AlertSound {
  id: string;
  title: string;
}

/** Alerts the system raises for the plugin. The plugin chooses when; it never reads the sound file itself. */
export interface AlertsApi {
  /** The system sounds on this machine, the system's own alert sound first. */
  sounds(): Promise<AlertSound[]>;
  /** Plays a system sound or an audio file once; volume runs 0–1. */
  play(sound: string, opts?: { volume?: number }): Promise<void>;
  /** A silent system notification; clicking it brings Tomrade forward. */
  notify(notice: { title: string; body?: string }): Promise<void>;
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
  readonly im: ImApi;
  readonly surfaces: SurfacesApi;
  readonly alerts: AlertsApi;
  readonly oplog: OplogApi;
  /** SDK 0.2.9: answers the agent's web search, as the app's own providers do. */
  readonly webSearch: WebSearchApi;
  /** SDK 0.2.10: live terminals of the herdr panes code sessions run in. */
  readonly terminals: TerminalsApi;
  /** SDK 0.2.16: model providers, as the app's own are. */
  readonly models: ModelsApi;
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
