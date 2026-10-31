/**
 * The feature registry: the single vocabulary of what Tomrade measures.
 *
 * Ids are permanent. Once a release has used one it is never renamed and never
 * reused; a feature that goes away keeps its row and gains `retiredIn`. New
 * features add an id and its actions — never an event name — so the ingest
 * function and the dashboard read whatever the registry says.
 *
 * The prose that defines each id and each metric lives in
 * `Tomrade 功能清单与埋点规范` (TOM-560); this table is its executable copy.
 */

export type FeatureKind = "surface" | "action" | "sub";

export interface FeatureAction {
  /** The action's name within this feature: `open`, `create`, `start`… */
  name: string;
  /** Counted towards 使用次数 (the spec's ✓). */
  counted?: boolean;
  /**
   * A milestone: recorded at most once per anonymous id, however often the
   * app sees it again. Client-side only; the server keeps whatever arrives.
   */
  once?: boolean;
  /** The registry version that added this action to a feature older than it. */
  sinceRegistry?: number;
}

export interface FeatureDefinition {
  id: string;
  /** English name, as the dashboard shows it. */
  title: string;
  /** Chinese name, as the dashboard shows it. */
  titleZh: string;
  kind: FeatureKind;
  /**
   * For a `sub`: the surface the person is in while doing it. Its time is that
   * surface's; a sub never opens a session of its own.
   */
  timedIn?: string;
  actions: readonly FeatureAction[];
  /** Closed set of `dim` values this feature's actions may carry, when it has one. */
  dims?: readonly string[];
  /** The dim each action uses, when only some actions carry one. */
  dimAction?: string;
  sinceRegistry: number;
  /** The registry version that retired this id. */
  retiredIn?: number;
}

/** Engine ids an `agent.chat` message may name. The agent registry's shipped engines. */
export const ENGINE_DIMS = [
  "loop",
  "scripted",
  "claude-code",
  "codex",
  "pi",
  "cursor",
  "dsh",
  "hermes",
  "opencode",
  "workbuddy"
] as const;

/** IM channels. */
export const CHANNEL_DIMS = ["feishu", "dingtalk", "wecom", "slack", "discord", "other"] as const;
/** Where a ticket came from. */
export const SOURCE_DIMS = ["quick", "form", "template"] as const;

const counted = (name: string): FeatureAction => ({ name, counted: true });
const seen = (name: string): FeatureAction => ({ name });
/** An activation step (TOM-749): adoption and the funnel only, never a use, never content. */
const step = (name: string, extra: Partial<FeatureAction> = {}): FeatureAction => ({ name, sinceRegistry: 2, ...extra });

export const FEATURES: readonly FeatureDefinition[] = [
  {
    id: "project.list",
    title: "Projects",
    titleZh: "项目列表",
    kind: "surface",
    actions: [counted("open"), counted("create"), counted("import")],
    sinceRegistry: 1
  },
  {
    id: "backlog.board",
    title: "Board",
    titleZh: "看板",
    kind: "surface",
    actions: [counted("open")],
    sinceRegistry: 1
  },
  {
    id: "backlog.lane",
    title: "Lanes",
    titleZh: "泳道",
    kind: "sub",
    timedIn: "backlog.board",
    actions: [seen("lane_on"), seen("lane_off"), seen("lane_collapse")],
    sinceRegistry: 1
  },
  {
    id: "backlog.table",
    title: "Table",
    titleZh: "表格",
    kind: "surface",
    actions: [counted("open")],
    sinceRegistry: 1
  },
  {
    id: "backlog.graph",
    title: "Dependency graph",
    titleZh: "依赖图",
    kind: "surface",
    actions: [counted("open")],
    sinceRegistry: 1
  },
  {
    id: "backlog.plugin",
    title: "Plugin layout",
    titleZh: "插件布局",
    kind: "surface",
    actions: [counted("open")],
    sinceRegistry: 3
  },
  {
    id: "backlog.issue",
    title: "Ticket",
    titleZh: "工单详情",
    kind: "surface",
    actions: [counted("open")],
    sinceRegistry: 1
  },
  {
    id: "backlog.create",
    title: "New ticket",
    titleZh: "新建工单",
    kind: "action",
    actions: [counted("create")],
    dims: SOURCE_DIMS,
    dimAction: "create",
    sinceRegistry: 1
  },
  {
    id: "backlog.view",
    title: "Views and filters",
    titleZh: "视图与筛选",
    kind: "sub",
    actions: [seen("view_save"), seen("view_switch"), seen("query_change")],
    sinceRegistry: 1
  },
  {
    id: "backlog.search",
    title: "Search and commands",
    titleZh: "搜索与命令面板",
    kind: "sub",
    actions: [seen("search_query"), seen("command_run")],
    sinceRegistry: 1
  },
  {
    id: "code.link",
    title: "Code link",
    titleZh: "代码链接",
    kind: "action",
    actions: [
      counted("start"),
      seen("open_pr"),
      counted("merge"),
      seen("open_worktree"),
      // A repository added to a project: what code links need first.
      step("project_repo_linked"),
      // An agent in the person's own terminal took a ticket with claim_ticket.
      step("claim_external")
    ],
    sinceRegistry: 1
  },
  {
    id: "code.terminal",
    title: "Terminal",
    titleZh: "终端",
    kind: "surface",
    actions: [counted("open"), counted("session_new")],
    sinceRegistry: 1
  },
  {
    id: "agent.chat",
    title: "Assistant",
    titleZh: "AI 助手",
    kind: "surface",
    actions: [
      counted("open"),
      seen("message_sent"),
      // A proposed requirement tree written to the backlog.
      step("plan_applied"),
      // A whole run taken back in one click.
      step("run_reverted")
    ],
    dims: ENGINE_DIMS,
    dimAction: "message_sent",
    sinceRegistry: 1
  },
  {
    id: "files.browse",
    title: "Files",
    titleZh: "文件",
    kind: "surface",
    actions: [counted("open"), counted("upload"), counted("create"), seen("restore")],
    sinceRegistry: 1
  },
  {
    id: "notes.editor",
    title: "Notes",
    titleZh: "笔记",
    kind: "surface",
    actions: [counted("open"), counted("create"), seen("follow_link")],
    sinceRegistry: 1
  },
  {
    id: "routines.list",
    title: "Routines",
    titleZh: "例行事务",
    kind: "surface",
    actions: [counted("open"), counted("create"), counted("run_now")],
    sinceRegistry: 1
  },
  {
    id: "inbox.triage",
    title: "Inbox",
    titleZh: "收件箱",
    kind: "action",
    actions: [counted("open"), counted("accept"), counted("dismiss")],
    sinceRegistry: 1
  },
  {
    id: "im",
    title: "IM",
    titleZh: "IM 接入",
    kind: "action",
    actions: [counted("ticket_created"), counted("reply")],
    dims: CHANNEL_DIMS,
    sinceRegistry: 1
  },
  {
    id: "plugins.manage",
    title: "Plugins",
    titleZh: "插件管理",
    kind: "action",
    actions: [counted("open"), counted("enable"), counted("disable")],
    sinceRegistry: 1
  },
  {
    id: "plugins.studio",
    title: "Plugin Studio",
    titleZh: "插件工作室",
    kind: "action",
    actions: [counted("open"), counted("build"), counted("test")],
    sinceRegistry: 1
  },
  {
    id: "plugins.store",
    title: "Plugin store",
    titleZh: "插件商店",
    kind: "action",
    actions: [counted("open"), counted("install"), counted("update")],
    sinceRegistry: 1
  },
  {
    id: "settings",
    title: "Settings",
    titleZh: "设置",
    kind: "action",
    actions: [counted("open"), seen("change")],
    // Settings sections register themselves; the closed set is whatever the
    // running app registers. The server keeps only ids it knows from the
    // registry snapshot it was built with.
    dims: ["theme", "language", "customThemes", "themeAutomation", "notifications", "updates", "account", "agent", "mcp", "plugins", "im", "analytics"],
    dimAction: "change",
    sinceRegistry: 1
  },
  {
    id: "pet.companion",
    title: "Pet",
    titleZh: "宠物",
    kind: "action",
    actions: [counted("open"), seen("toggle"), seen("interact")],
    sinceRegistry: 1
  },
  {
    id: "doctor",
    title: "Troubleshooting",
    titleZh: "故障排查",
    kind: "action",
    actions: [counted("open"), counted("run_check"), seen("send_report")],
    sinceRegistry: 1
  },
  {
    id: "plugin.pomodoro",
    title: "Pomodoro",
    titleZh: "番茄钟",
    kind: "action",
    actions: [counted("open"), counted("start"), counted("complete")],
    sinceRegistry: 1
  },
  {
    id: "plugin.community",
    title: "Community plugins",
    titleZh: "第三方插件汇总",
    kind: "action",
    actions: [counted("open")],
    sinceRegistry: 1
  },
  {
    id: "onboarding",
    title: "First run",
    titleZh: "首次引导",
    kind: "sub",
    actions: [
      seen("tour_start"),
      seen("tour_finish"),
      seen("hint_dismiss"),
      // The first-run check first finds the worker model and an assistant engine ready.
      step("setup_done", { once: true })
    ],
    sinceRegistry: 1
  }
];

/** Bumped whenever any row, action or `counted` flag changes. */
export const FEATURE_REGISTRY_VERSION = 3;

const BY_ID = new Map(FEATURES.map((feature) => [feature.id, feature]));

export const featureById = (id: string): FeatureDefinition | undefined => BY_ID.get(id);

/** Every id this registry version knows, retired ones included. */
export const featureIds = (): string[] => FEATURES.map((feature) => feature.id);

/** The surfaces that open a timed session: `surface` only. */
export const timerSurfaces = (): FeatureDefinition[] => FEATURES.filter((feature) => feature.kind === "surface");

export const isAction = (feature: FeatureDefinition, action: string): boolean =>
  feature.actions.some((entry) => entry.name === action);

/** Recorded at most once per anonymous id. */
export const isOnce = (featureId: string, action: string): boolean =>
  !!BY_ID.get(featureId)?.actions.some((entry) => entry.name === action && entry.once);

export const isCounted = (featureId: string, action: string): boolean => {
  const feature = BY_ID.get(featureId);
  return !!feature?.actions.some((entry) => entry.name === action && entry.counted);
};

/**
 * `dim` is dropped, never the event, when it is outside the feature's closed
 * set. `acp-*` engines are the one prefix the registry admits without a row of
 * their own, because the ACP registry adds engines by id.
 */
export function dimAllowed(feature: FeatureDefinition, dim: string | null | undefined): boolean {
  if (dim == null || dim === "") return true;
  if (!feature.dims) return false;
  if (feature.id === "agent.chat" && /^acp-[a-z0-9-]+$/.test(dim)) return true;
  if (feature.id === "settings" && /^[a-z][a-zA-Z0-9-]*$/.test(dim)) return true;
  return feature.dims.includes(dim);
}

/** The registry as the ingest side reads it: a snapshot the SQL function is seeded with. */
export function registrySnapshot(): { version: number; features: { id: string; kind: FeatureKind; actions: FeatureAction[]; dims?: string[] }[] } {
  return {
    version: FEATURE_REGISTRY_VERSION,
    features: FEATURES.map((feature) => ({
      id: feature.id,
      kind: feature.kind,
      actions: feature.actions.map((action) => ({ ...action })),
      ...(feature.dims ? { dims: [...feature.dims] } : {})
    }))
  };
}
