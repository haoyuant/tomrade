import type { Author, Board, Dictionaries, Item, LanguageTag, ListItemsFilter, Patch, Project } from "@tomradex/domain";
import type { TerminalProvider } from "./terminals.js";

/*
 * The slices of each other's services that packages read through `ctx.get`,
 * named once. A reader that cannot import the provider (a package cycle) or
 * should not depend on all of it reads the slice here; the provider declares
 * `implements`, so a changed signature fails where it is provided.
 */

export interface ItemsReader {
  get(projectId: string, id: string): Item | null;
  getByKey(projectId: string, key: string): Item | null;
  list(filter: ListItemsFilter): Item[];
}

export interface ItemsWriter {
  update(projectId: string, id: string, patch: Patch, by: Author, opts?: { baseVersion?: number }): Item;
}

export interface SettingsReader {
  /** The language the backend speaks to the person in. */
  locale(): LanguageTag;
  /** What a language pack translates: the backend's books, and the interface's once a window has said. */
  english(): { ui: Dictionaries | null; backend: Dictionaries };
}

/** The account service, `@tomradex/hub-cloud`. */
export interface CloudHubReader {
  info(): {
    user: { id: string; email: string } | null;
    hubId: string | null;
    status: { state: string; detail?: string };
    pending: number;
  };
  /** The Supabase client; each caller types the queries it makes. */
  readonly client: any;
}

export interface DbReader {
  /** Where the caches live; ":memory:" when they live in RAM. */
  readonly config: { readonly dir: string };
}

export interface StorageReader {
  /** The project folder's `.tomrade` directory, or null when the project has no folder here. */
  artifactDirFor(projectId: string): string | null;
}

export interface McpReader {
  /** The server's address while it runs. */
  readonly url: string | null;
  urlFor(projectId: string): string | null;
  /** Text every connecting agent reads; returns the way to take it back. */
  instruct(render: (scope: { projectId?: string }) => string | null, options?: { order?: number }): () => void;
}

export interface HubReader {
  readonly dir: string | null;
  readonly catalog: { projects(): { id: string; name: string }[] };
}

export interface ProjectsReader {
  get(id: string): Project | null;
}

export interface BoardsReader {
  get(projectId: string, id: string): Board | null;
}

export interface ReposReader {
  workdirFor(
    projectId: string,
    boardId: string,
    threadId: string,
    opts?: { branch?: string | null; create?: boolean }
  ): Promise<{ cwd: string | null; worktree: string | null; branch: string; repo: { remote: string } } | null>;
}

export interface FilesReader {
  dirFor(projectId: string): string | null;
  readVersion(projectId: string, ref: { fileId: string; versionId: string }): Promise<{ body: string; encoding: "utf8" | "base64"; truncated: boolean } | null>;
}

/** Where a ticket's code landed, as code-link records it. */
export interface LandedLink {
  repoId: string;
  mergedSha: string | null;
  prNumber: number | null;
  prState: string | null;
}

export interface CodeLinkReader {
  links(projectId: string, itemId?: string): LandedLink[];
}

export interface CommunityReader {
  /** The login the person publishes plugins under, once they have signed in to publish. */
  publisherLogin(): string | null;
}

export interface AgentReader {
  recommendPlaybook(
    projectId: string,
    input: { title: string; body?: string | null; workType?: "coding" | "general" },
    opts?: { withinMs?: number; signal?: AbortSignal }
  ): Promise<{ playbookId: string | null; workType: "coding" | "general" }>;
}

/** What one check found. `Action` is what the troubleshooter can offer about it. */
export interface CheckResult<Action = never> {
  state: "ok" | "warn" | "fail" | "skip";
  /** One line, in the person's language. */
  line: string;
  facts?: Record<string, string>;
  /** What can be done about a warning or a failure. */
  actions?: Action[];
  /** Longer text for the report: an error's details, say. */
  evidence?: string;
}

/** One thing the troubleshooter looks at. Plugins add their own; `@tomradex/doctor` names the words, topic and actions. */
export interface Check<Words = unknown, Topic = unknown, Action = never> {
  id: string;
  title(words: Words): string;
  /** Whether it says anything about this topic; absent, it always runs. */
  applies?(topic: Topic): boolean;
  run(topic: Topic, signal: AbortSignal): Promise<CheckResult<Action>>;
}

/** The troubleshooter, `@tomradex/doctor`, as a plugin adding a check sees it. */
export interface DoctorChecks {
  check(check: Check): () => void;
  locale(): LanguageTag;
}

/** Each service key and the contract it is read through. */
export interface Contracts {
  agent: AgentReader;
  boards: BoardsReader;
  cloudHub: CloudHubReader;
  codeLink: CodeLinkReader;
  community: CommunityReader;
  db: DbReader;
  doctor: DoctorChecks;
  files: FilesReader;
  hub: HubReader;
  items: ItemsReader & ItemsWriter;
  mcp: McpReader;
  projects: ProjectsReader;
  repos: ReposReader;
  settings: SettingsReader;
  storage: StorageReader;
  terminals: TerminalProvider;
}

/** A cordis context, as far as reading a service goes. */
export interface ServiceLookup {
  get(name: string): unknown;
}

/** The service under `name` read through its contract; undefined when that plugin is not loaded. */
export function contract<K extends keyof Contracts>(ctx: ServiceLookup, name: K): Contracts[K] | undefined {
  return ctx.get(name) as Contracts[K] | undefined;
}

/** The person's language as settings say it; undefined without settings, which every word book reads as English. */
export function localeOf(ctx: ServiceLookup): LanguageTag | undefined {
  return contract(ctx, "settings")?.locale?.();
}
