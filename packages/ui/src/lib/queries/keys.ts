import type { AssistantAccessory } from "@tomradex/contributions";
import type { InboxListFilter } from "@tomradex/inbox";

/**
 * Every query key the renderer uses, in one place. A key is a cache identity
 * and an invalidation prefix at once, so a family's shorter keys (`…All`,
 * `root`, `all`) are the prefixes its writers and broadcasts invalidate.
 * Imports types only: any module can read it without pulling in a hook.
 */
export const keys = {
  projects: ["projects"] as const,
  boards: (projectId: string) => ["boards", projectId] as const,
  views: (projectId: string) => ["views", projectId] as const,
  items: (projectId: string) => ["items", projectId] as const,
  /** Under `items`, so whatever asks the list again asks the counts too. */
  itemCounts: (projectId: string) => ["items", projectId, "counts"] as const,
  /** What the renderer holds of a project: everything open, and the newest done and cancelled tickets the window lets through. */
  itemsWindow: (projectId: string, limit: number | null, days: number | null) => ["items", projectId, "window", limit, days] as const,
  /** Every item, for the few dialogs that must see all of them; dropped once they close. */
  itemsAll: (projectId: string) => ["items", projectId, "all"] as const,
  /** One item by id or key, for when the window left it out. */
  item: (projectId: string, idOrKey: string) => ["items", projectId, "one", idOrKey] as const,
  /** Under `items` like the rest: any write may move what these count or page through. */
  itemQuery: (projectId: string, kind: "count" | "page" | "found" | "ticketCounts", spec: unknown) => ["items", projectId, kind, spec] as const,
  epicProgress: (projectId: string) => ["items", projectId, "epicProgress"] as const,
  labels: (projectId: string) => ["labels", projectId] as const,
  fields: (projectId: string) => ["fields", projectId] as const,
  ranksAll: ["ranks"] as const,
  ranks: (viewId: string) => ["ranks", viewId] as const,
  historyAll: (projectId: string) => ["history", projectId] as const,
  history: (projectId: string, itemId: string) => ["history", projectId, itemId] as const,
  /** Per project: with one file per project there is no cross-project "recent". */
  oplog: (projectId: string) => ["oplog", projectId] as const,
  /** The history window's list: every provider's records, undone ones included. */
  timeline: (projectId: string) => ["timeline", projectId] as const,
  deliveriesAll: (projectId: string, itemId: string) => ["deliveries", projectId, itemId] as const,
  deliveries: (projectId: string, itemId: string, version: number) => ["deliveries", projectId, itemId, version] as const,
  settings: ["settings"] as const,
  settingsSections: ["settings", "sections"] as const,
  secretStorage: ["settings", "secretStorage"] as const,
  languages: ["settings", "languages"] as const,
  languagePack: (tag: string | null) => ["settings", "languages", tag] as const,
  mcp: (projectId?: string) => ["mcp", projectId ?? ""] as const,
  cacheDir: ["cacheDir"] as const,
  about: ["about"] as const,
  account: ["account"] as const,
  announcements: ["announcements"] as const,
  attention: ["attention"] as const,
  pushStatus: ["attention", "pushStatus"] as const,
  background: ["background"] as const,
  webSearch: ["webSearch"] as const,
  appIcon: ["appIcon"] as const,
  themeImage: (themeId: string, slot: string) => ["themeImage", themeId, slot] as const,
  updates: ["updates"] as const,
  hub: ["hub"] as const,
  hubRemote: ["storage", "hub"] as const,
  reposAll: ["repos"] as const,
  repos: (projectId: string) => ["repos", projectId] as const,
  repoCheckouts: ["repos", "checkouts"] as const,
  plugins: ["plugins"] as const,
  storage: ["storage"] as const,
  storageProviders: ["storage", "providers"] as const,
  restores: ["storage", "restores"] as const,
  storageStatus: (projectId: string) => ["storage", "status", projectId] as const,
  storageInfo: (projectId: string) => ["storage", "info", projectId] as const,
  syncAttention: (projectId: string) => ["storage", "attention", projectId] as const,
  storageConnection: (providerId: string) => ["storage", "connection", providerId] as const,
  contributions: ["contributions"] as const,
  commands: ["contributions", "commands"] as const,
  badges: (projectId: string) => ["contributions", "badges", projectId] as const,
  statusItems: (projectId?: string) => ["contributions", "status", projectId ?? ""] as const,
  sectionsAll: (projectId: string) => ["contributions", "sections", projectId] as const,
  sections: (projectId: string, itemId: string) => ["contributions", "sections", projectId, itemId] as const,
  sidebarModules: (projectId: string) => ["contributions", "sidebar", projectId] as const,
  graphs: ["contributions", "graphs"] as const,
  layouts: ["contributions", "layouts"] as const,
  graphEdgesAll: (projectId: string) => ["contributions", "graph", projectId] as const,
  graphEdges: (projectId: string, graphId: string) => ["contributions", "graph", projectId, graphId] as const,
  assistantAccessories: ["contributions", "assistant-accessories"] as const,
  accessoryState: (accessory: AssistantAccessory, threadId: string | null) => ["assistant-accessory", accessory.id, accessory.stateChannel, threadId ?? ""] as const,

  agent: {
    threads: (projectId: string) => ["agent", "threads", projectId] as const,
    threadAll: (projectId: string) => ["agent", "thread", projectId] as const,
    thread: (projectId: string, threadId: string) => ["agent", "thread", projectId, threadId] as const,
    /** What waiting conversations ask, for the session bar's cards: keyed by which wait, so a new ask reads it again. */
    pendings: (projectId: string, waits: string) => ["agentPendings", projectId, waits] as const,
    engines: ["agent", "engines"] as const,
    playbooksAll: ["agent", "playbooks"] as const,
    playbooks: (projectId?: string) => ["agent", "playbooks", projectId ?? ""] as const,
    workdirAll: ["agent", "workdir"] as const,
    workdir: (projectId: string, threadId: string) => ["agent", "workdir", projectId, threadId] as const,
    rules: (projectId: string) => ["agent", "rules", projectId] as const,
    brief: (projectId: string) => ["agent", "brief", projectId] as const,
    mcpLink: (engineId: string) => ["agent", "mcpLink", engineId] as const,
    usage: (days: number) => ["agent", "usage", days] as const,
    media: (projectId: string, threadId: string, mediaId: string) => ["agent-media", projectId, threadId, mediaId] as const,
    /** The engine's options and the model settings decide what it reads, so both are part of the key. */
    mediaCapabilities: (engineId: string, options: unknown, models: unknown) => ["agent-media-capabilities", engineId, options, models] as const
  },

  acpRegistry: {
    list: ["acpRegistry", "list"] as const
  },

  /** The look back's reads of records: an ended conversation does not change, so nothing invalidates these. */
  review: {
    said: (projectId: string, query: string) => ["review", projectId, "said", query] as const,
    open: (projectId: string, ref: string) => ["review", projectId, "open", ref] as const,
    raw: (projectId: string, sessionId: string) => ["review", projectId, "raw", sessionId] as const
  },

  agentSetup: {
    managed: (engineId: string) => ["agentSetup", "managed", engineId] as const
  },
  machineSetup: {
    git: ["machineSetup", "git"] as const
  },

  llm: {
    worker: ["llm", "worker"] as const,
    workerTest: ["llm", "workerTest"] as const,
    workerFor: (role: unknown) => ["llm", "worker", role] as const,
    workerUsage: (days: number) => ["llm", "workerUsage", days] as const,
    lenders: ["llm", "lenders"] as const,
    providersAll: ["llm", "providers"] as const,
    providers: (locale: string) => ["llm", "providers", locale] as const,
    modelProvidersAll: ["llm", "modelProviders"] as const,
    modelProviders: (locale: string) => ["llm", "modelProviders", locale] as const,
    detected: ["llm", "detected"] as const,
    refusedModels: ["llm", "refusedModels"] as const,
    searchRoute: (profiles: string) => ["llm", "searchRoute", profiles] as const,
    models: (provider: string, baseURL: string | undefined, apiKey: string) => ["llm.models", provider, baseURL ?? "", apiKey] as const
  },

  codeLink: {
    root: ["codeLink"] as const,
    all: (projectId: string) => ["codeLink", projectId] as const,
    links: (projectId: string, itemId?: string) => ["codeLink", projectId, "links", itemId ?? ""] as const,
    sessions: (projectId: string, itemId?: string) => ["codeLink", projectId, "sessions", itemId ?? ""] as const,
    sessionsAll: (projectId: string) => ["codeLink", projectId, "sessions"] as const,
    recentSessions: (projectId: string) => ["codeLink", projectId, "recentSessions"] as const,
    /** Kept apart from `all`: asked again only when the Terminal window says its cells changed, not on every hook. */
    cells: (projectId: string) => ["codeLinkCells", projectId] as const,
    timeline: (projectId: string, itemId: string) => ["codeLink", projectId, "timeline", itemId] as const,
    timelineAll: (projectId: string) => ["codeLink", projectId, "timeline"] as const,
    handoff: (projectId: string, threadId: string) => ["codeLink", projectId, "handoff", threadId] as const,
    handoffAll: (projectId: string) => ["codeLink", projectId, "handoff"] as const,
    deliveries: (projectId: string, itemId: string) => ["codeLink", projectId, "deliveries", itemId] as const,
    repos: (projectId: string) => ["codeLink", projectId, "repos"] as const,
    connection: (projectId: string, repoId: string) => ["codeLink", projectId, "connection", repoId] as const,
    mergeChecks: (projectId: string, repoId: string) => ["codeLink", projectId, "mergeChecks", repoId] as const,
    githubCredentialAccount: (projectId: string, repoId: string) => ["codeLink", projectId, "githubCredentialAccount", repoId] as const,
    remoteIdentity: (remote: string) => ["codeLink", "remoteIdentity", remote] as const,
    proposals: (projectId: string, itemId?: string) => ["codeLink", projectId, "proposals", itemId ?? ""] as const,
    unlinked: (projectId: string) => ["codeLink", projectId, "unlinked"] as const,
    worktree: (projectId: string, itemId: string) => ["codeLink", projectId, "worktree", itemId] as const,
    terminalWindow: (projectId: string) => ["codeLink", projectId, "terminalWindow"] as const,
    /** The look back's first page (`query` empty), or its search by title and ticket, `limit` rows: read again as sessions and conversations change. */
    review: (projectId: string, query: string, limit = 0) => ["codeLink", projectId, "review", query, limit] as const,
    reviewAll: (projectId: string) => ["codeLink", projectId, "review"] as const,
    startDefaults: ["codeLink", "startDefaults"] as const,
    herdrStatus: ["codeLink", "herdrStatus"] as const,
    gh: ["codeLink", "gh"] as const,
    herdrInstall: ["codeLink", "herdrInstall"] as const
  },

  files: {
    root: ["files"] as const,
    all: (projectId: string) => ["files", projectId] as const,
    tree: (projectId: string) => ["files", projectId, "tree"] as const,
    status: (projectId: string) => ["files", projectId, "status"] as const,
    info: (projectId: string) => ["files", projectId, "info"] as const,
    syncPolicy: (projectId: string) => ["files", projectId, "syncPolicy"] as const,
    content: (projectId: string, path: string) => ["files", projectId, "read", path] as const,
    version: (projectId: string, fileId: string, versionId: string) => ["files", projectId, "version", fileId, versionId] as const,
    location: (projectId: string, fileId: string) => ["files", projectId, "locate", fileId] as const,
    byId: (projectId: string, fileId: string) => ["files", projectId, "byId", fileId] as const,
    history: (projectId: string, path: string) => ["files", projectId, "history", path] as const,
    conflicts: (projectId: string) => ["files", projectId, "conflicts"] as const,
    folder: (projectId: string, itemId: string) => ["files", projectId, "folderFor", itemId] as const,
    attachmentsOf: (projectId: string, itemId: string) => ["files", projectId, "attachmentsOf", itemId] as const,
    agentPolicy: (projectId: string) => ["files", projectId, "agentPolicy"] as const,
    agentIndex: (projectId: string) => ["files", projectId, "agentIndex"] as const,
    // mutation keys: the policy panes show a write in flight from anywhere
    setSyncRules: (projectId: string) => ["files", projectId, "setSyncRules"] as const,
    setAgentRules: (projectId: string) => ["files", projectId, "setAgentRules"] as const,
    backends: ["files", "backends"] as const,
    connection: (backendId: string) => ["files", "connection", backendId] as const
  },

  notes: {
    all: (projectId: string) => ["notes", projectId] as const,
    search: (projectId: string, query: string) => ["notes", projectId, "search", query] as const,
    links: (projectId: string, path: string) => ["notes", projectId, "links", path] as const,
    tags: (projectId: string) => ["notes", projectId, "tags"] as const
  },

  inbox: {
    all: (projectId: string) => ["inbox", projectId] as const,
    entries: (projectId: string, status: InboxListFilter) => ["inbox", projectId, "entries", status] as const,
    sources: (projectId: string) => ["inbox", projectId, "sources"] as const,
    triager: (projectId: string) => ["inbox", projectId, "triager"] as const
  },

  schedules: {
    all: (projectId: string) => ["schedules", projectId] as const,
    templates: (projectId: string) => ["schedules", projectId, "templates"] as const,
    list: (projectId: string) => ["schedules", projectId, "list"] as const,
    runs: (projectId: string, templateId: string) => ["schedules", projectId, "runs", templateId] as const,
    suggestions: (locale: string) => ["schedules", "suggestions", locale] as const
  },

  takeover: {
    offer: (projectId: string) => ["takeover", projectId, "offer"] as const
  },

  nightShift: {
    all: (projectId: string) => ["nightShift", projectId] as const,
    current: (projectId: string) => ["nightShift", projectId, "current"] as const,
    last: (projectId: string) => ["nightShift", projectId, "last"] as const,
    plan: (projectId: string) => ["nightShift", projectId, "plan"] as const,
    proposal: (projectId: string) => ["nightShift", projectId, "proposal"] as const,
    rules: (projectId: string) => ["nightShift", projectId, "rules"] as const,
    ruleMatches: (projectId: string) => ["nightShift", projectId, "ruleMatches"] as const
  },

  community: {
    root: ["community"] as const,
    browse: (text: string, sort: string, officialOnly: boolean) => ["community", "browse", text, sort, officialOnly] as const,
    plugin: (id: string) => ["community", "plugin", id] as const,
    updates: ["community", "updates"] as const,
    revoked: ["community", "revoked"] as const,
    account: ["community", "account"] as const,
    published: ["community", "published"] as const,
    inspect: (id: string, version: string) => ["community", "inspect", id, version] as const,
    // under "community", so an install anywhere refetches it
    providingModels: ["community", "providing", "modelProviders"] as const
  },

  studio: {
    root: ["studio"] as const,
    review: (name: string) => ["studio", "review", name] as const,
    snapshots: (name: string) => ["studio", "snapshots", name] as const
  },

  im: {
    root: ["im"] as const,
    connections: ["im", "connections"] as const,
    adapters: ["im", "adapters"] as const,
    ignored: ["im", "ignored"] as const,
    deliveries: ["im", "deliveries"] as const,
    pairings: ["im", "pairings"] as const,
    threadBindings: (projectId: string, threadId: string | null) => ["im", "threadBindings", projectId, threadId] as const
  },

  pet: {
    root: ["pet"] as const,
    profiles: ["pet", "profiles"] as const,
    preview: (profileId: string) => ["pet", "preview", profileId] as const
  },

  mcpClient: {
    servers: ["mcpClient", "servers"] as const
  },

  doctor: {
    reports: ["doctor-reports"] as const,
    report: (projectId: string, threadId: string | null | undefined, include: unknown, note: string) => ["doctor-report", projectId, threadId, include, note] as const,
    feedbackPreview: (kind: string, text: string) => ["feedback-preview", kind, text] as const
  }
};
