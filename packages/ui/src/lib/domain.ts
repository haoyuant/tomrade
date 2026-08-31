import type { Board, GroupBy, Item, ItemStatus, OplogEntry, Priority, Provenance, View, ViewFilter } from "@tomrade/domain";
import type { IconId } from "~/components/icons";
import type { Locale } from "./i18n";

/**
 * Vocabulary shared by nearly every screen (status, priority, group and
 * provenance words; relative timestamps) lives here as mutable tables rather
 * than routed through the generic `t()` key system — `setDomainLocale` swaps
 * the values in place, so every existing `STATUS[k].label` / `timeAgo(...)`
 * call site picks up the active language with no change of its own. Any
 * component that reads one of these should also call `useI18n()` for
 * something else on the same render, so it re-renders when the locale flips.
 */
let currentLocale: Locale = "en";

const STATUS_LABEL: Record<Locale, Record<ItemStatus, string>> = {
  en: { backlog: "Backlog", todo: "To Do", doing: "Doing", verifying: "Verifying", done: "Done", cancelled: "Cancelled" },
  zh: { backlog: "待处理", todo: "待办", doing: "进行中", verifying: "验证中", done: "已完成", cancelled: "已取消" }
};

/** Status marks are shape-coded: each is legible in greyscale. */
export const STATUS: Record<ItemStatus, { label: string; mark: IconId }> = {
  backlog: { label: STATUS_LABEL.en.backlog, mark: "s-backlog" },
  todo: { label: STATUS_LABEL.en.todo, mark: "s-todo" },
  doing: { label: STATUS_LABEL.en.doing, mark: "s-doing" },
  verifying: { label: STATUS_LABEL.en.verifying, mark: "s-verifying" },
  done: { label: STATUS_LABEL.en.done, mark: "s-done" },
  cancelled: { label: STATUS_LABEL.en.cancelled, mark: "s-cancelled" }
};

export const STATUS_KEYS = Object.keys(STATUS) as ItemStatus[];

/** One hue stepped light to dark — a status ramp is not six accents. */
export const STATUS_FILL: Record<ItemStatus, string> = {
  backlog: "var(--tag-bg-soft)",
  todo: "var(--tag-bg-base)",
  doing: "var(--accent-light)",
  verifying: "var(--accent)",
  done: "var(--accent-active)",
  cancelled: "var(--meta)"
};

export const PRIORITIES: Priority[] = [0, 1, 2, 3, 4];
const PRIORITY_LABEL_BY_LOCALE: Record<Locale, readonly string[]> = {
  en: ["None", "Low", "Medium", "High", "Urgent"],
  zh: ["无", "低", "中", "高", "紧急"]
};
export const PRIORITY_LABEL: string[] = [...PRIORITY_LABEL_BY_LOCALE.en];

const GROUP_LABEL: Record<Locale, Record<GroupBy, string>> = {
  en: { status: "Status", priority: "Priority", epic: "Epic" },
  zh: { status: "状态", priority: "优先级", epic: "需求组" }
};

export const GROUPS: Record<GroupBy, { label: string; icon: IconId }> = {
  status: { label: GROUP_LABEL.en.status, icon: "s-doing" },
  priority: { label: GROUP_LABEL.en.priority, icon: "i-bars" },
  epic: { label: GROUP_LABEL.en.epic, icon: "i-stack" }
};

const PROVENANCE_BY_LOCALE: Record<Locale, Record<Provenance, string>> = {
  en: { ai: "ai:mcp", human: "human", locked: "human-locked" },
  zh: { ai: "ai:mcp", human: "人工", locked: "人工锁定" }
};

export const PROVENANCE: Record<Provenance, string> = { ...PROVENANCE_BY_LOCALE.en };

const BOARD_GLYPH_LABEL: Record<Locale, readonly string[]> = {
  en: ["Panel", "Stack", "Plug", "Monitor", "Board", "Filter", "Bug", "Bars"],
  zh: ["面板", "堆叠", "插头", "显示器", "看板", "筛选", "缺陷", "柱状"]
};

const NO_EPIC_LABEL: Record<Locale, string> = { en: "No epic", zh: "无需求组" };
const EPIC_FALLBACK_LABEL: Record<Locale, string> = { en: "Epic", zh: "需求组" };
const ALL_BOARDS_LABEL: Record<Locale, string> = { en: "all boards", zh: "全部看板" };

/** Called once per render from `I18nProvider`; see the file-level comment above. */
export function setDomainLocale(locale: Locale): void {
  currentLocale = locale;
  for (const k of STATUS_KEYS) STATUS[k].label = STATUS_LABEL[locale][k];
  PRIORITY_LABEL.splice(0, PRIORITY_LABEL.length, ...PRIORITY_LABEL_BY_LOCALE[locale]);
  for (const g of Object.keys(GROUPS) as GroupBy[]) GROUPS[g].label = GROUP_LABEL[locale][g];
  for (const p of Object.keys(PROVENANCE) as Provenance[]) PROVENANCE[p] = PROVENANCE_BY_LOCALE[locale][p];
  for (let i = 0; i < BOARD_GLYPHS.length; i++) BOARD_GLYPHS[i][1] = BOARD_GLYPH_LABEL[locale][i];
}

export const DEFAULT_COLUMNS: Record<GroupBy, string[]> = {
  status: ["todo", "doing", "verifying", "done"],
  priority: ["4", "3", "2", "1"],
  epic: []
};

export const BOARD_GLYPHS: [IconId, string][] = [
  ["i-panel", "Panel"],
  ["i-stack", "Stack"],
  ["i-plug", "Plug"],
  ["i-monitor", "Monitor"],
  ["i-board", "Board"],
  ["i-filter", "Filter"],
  ["i-bug", "Bug"],
  ["i-bars", "Bars"]
];

export function provenanceOf(item: Item): Provenance {
  if (item.humanLocked) return "locked";
  return item.updatedBy.startsWith("ai:") ? "ai" : "human";
}

/** "2m ago" / "2分钟前", but "now"/"刚刚" stays bare — "now ago" is not a phrase in either language. */
export const agoLabel = (ts: number, now = Date.now()) => {
  const short = timeAgo(ts, now);
  if (currentLocale === "zh") return short === "刚刚" ? short : `${short}前`;
  return short === "now" ? "now" : `${short} ago`;
};

/** Short relative time, the same string the card prints and recency sorts on. */
export function timeAgo(ts: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - ts) / 60000));
  const zh = currentLocale === "zh";
  if (mins < 1) return zh ? "刚刚" : "now";
  if (mins < 60) return zh ? `${mins}分钟` : `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return zh ? `${hours}小时` : `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return zh ? `${days}天` : `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return zh ? `${months}个月` : `${months}mo`;
  const years = Math.round(months / 12);
  return zh ? `${years}年` : `${years}y`;
}

/** What one oplog row did, phrased from the before/after snapshots. */
export function describeWrite(entry: OplogEntry): string {
  const zh = currentLocale === "zh";
  if (entry.op === "create") return zh ? "创建了该工作项" : "created the issue";
  if (entry.op === "delete") return zh ? "删除了该工作项" : "deleted the issue";
  if (entry.op === "purge") return zh ? "永久删除了该工作项" : "permanently deleted the issue";
  const before = entry.before as Item | null;
  const after = entry.after as Item | null;
  if (before && after) {
    if (before.status !== after.status) return zh ? `将状态设为${STATUS[after.status].label}` : `set status to ${after.status}`;
    if (before.priority !== after.priority)
      return zh ? `将优先级设为${PRIORITY_LABEL[after.priority]}` : `set priority to ${PRIORITY_LABEL[after.priority].toLowerCase()}`;
    if (before.humanLocked !== after.humanLocked)
      return after.humanLocked ? (zh ? "锁定了标题与描述" : "locked title and body") : zh ? "解除了标题与描述的锁定" : "unlocked title and body";
    if (before.parentId !== after.parentId)
      return after.parentId
        ? zh
          ? "将该工作项关联到了需求组"
          : "linked the issue to an epic"
        : zh
          ? "取消了该工作项与需求组的关联"
          : "unlinked the issue from its epic";
    if (before.labels.join() !== after.labels.join()) return zh ? "修改了标签" : "changed the labels";
    if (before.boardId !== after.boardId) return zh ? "将该工作项移动到了其他看板" : "moved the issue to another board";
    if (before.title !== after.title) return zh ? "编辑了标题" : "edited the title";
    if (before.body !== after.body) return zh ? "编辑了描述" : "edited the description";
    if (before.rank !== after.rank) return zh ? "调整了该工作项的顺序" : "reordered the issue";
  }
  return zh ? "更新了该工作项" : "updated the issue";
}

/** The mark an oplog row carries in the ledger gutter. */
export function ledgerMarkOf(entry: OplogEntry): "tick" | "lock" | null {
  const locked = entry.op === "update" && !!(entry.after as Item | null)?.humanLocked && !(entry.before as Item | null)?.humanLocked;
  if (locked) return "lock";
  return entry.by.startsWith("ai:") ? "tick" : null;
}

/* ═══ the live query ═══════════════════════════════════════════════════
   A saved view is a stored query; the bar edits a live copy of it. Nothing
   renders from the view directly, so "saved" and "showing" can differ and
   the difference is always visible. */

export interface BoardQuery {
  group: GroupBy;
  columns: string[];
  wip: Record<string, number>;
  labels: string[];
  epics: string[];
  priorities: Priority[];
  provenance: Provenance[];
}

export function queryFromView(view: View, epicColumns: string[]): BoardQuery {
  const f = view.filter ?? {};
  const columns = view.groupBy === "epic" && !view.columns.length ? epicColumns : [...view.columns];
  return {
    group: view.groupBy,
    columns,
    wip: { ...(view.wip ?? {}) },
    labels: [...(f.labels ?? [])],
    epics: [...(f.epics ?? [])],
    priorities: [...(f.priorities ?? [])],
    provenance: [...(f.provenance ?? [])]
  };
}

/**
 * Switching grouping restores the saved columns when it lands back on the saved
 * mode, and falls to the mode's defaults otherwise. One implementation, shared by
 * the segmented control and the palette.
 */
export function queryWithGroup(q: BoardQuery, group: GroupBy, saved: BoardQuery, epicColumns: string[]): BoardQuery {
  if (q.group === group) return q;
  if (group === saved.group) return { ...q, group, columns: [...saved.columns], wip: { ...saved.wip } };
  const columns = group === "epic" ? epicColumns : DEFAULT_COLUMNS[group];
  return { ...q, group, columns: [...columns], wip: {} };
}

export function filterFromQuery(q: BoardQuery): ViewFilter {
  const f: ViewFilter = {};
  if (q.labels.length) f.labels = [...q.labels];
  if (q.epics.length) f.epics = [...q.epics];
  if (q.priorities.length) f.priorities = [...q.priorities];
  if (q.provenance.length) f.provenance = [...q.provenance];
  return f;
}

const signature = (q: BoardQuery) =>
  JSON.stringify([
    q.group,
    q.columns,
    Object.keys(q.wip)
      .sort()
      .map((k) => `${k}:${q.wip[k]}`),
    [...q.labels].sort(),
    [...q.epics].sort(),
    [...q.priorities].sort(),
    [...q.provenance].sort()
  ]);

export const isDirty = (q: BoardQuery, saved: BoardQuery) => signature(q) !== signature(saved);

export const filterCount = (q: BoardQuery) => q.labels.length + q.epics.length + q.priorities.length + q.provenance.length;

/** Which column an item falls into, given the grouping. */
export function columnKeyOf(item: Item, group: GroupBy): string {
  if (group === "priority") return String(item.priority);
  if (group === "epic") return item.parentId ?? "none";
  return item.status;
}

export function columnLabel(key: string, group: GroupBy, epicNames: Map<string, string>): string {
  if (group === "priority") return PRIORITY_LABEL[Number(key) as Priority];
  if (group === "epic") return key === "none" ? NO_EPIC_LABEL[currentLocale] : (epicNames.get(key) ?? EPIC_FALLBACK_LABEL[currentLocale]);
  return STATUS[key as ItemStatus]?.label ?? key;
}

/** The patch a drop into `key` writes. Never the board — moving a workstream is deliberate. */
export function patchForColumn(key: string, group: GroupBy) {
  if (group === "priority") return { priority: Number(key) as Priority };
  if (group === "epic") return { parentId: key === "none" ? null : key };
  return { status: key as ItemStatus };
}

/** The board owns the issue; the query only slices it. */
export function matchesQuery(item: Item, q: BoardQuery): boolean {
  if (q.labels.length && !q.labels.some((l) => item.labels.includes(l))) return false;
  if (q.epics.length && !q.epics.includes(item.parentId ?? "none")) return false;
  if (q.priorities.length && !q.priorities.includes(item.priority)) return false;
  if (q.provenance.length && !q.provenance.includes(provenanceOf(item))) return false;
  return true;
}

/** A cross-board space borrows every issue; a board owns only its own. */
export const inBoard = (item: Item, board: Board) => board.across || item.boardId === board.id;

/** Epics are structure, not cards: they name the epic columns and never fill one. */
export const isTicket = (item: Item) => item.kind !== "epic";

export function itemsFor(items: Item[], board: Board, q: BoardQuery, ranks: Record<string, number> = {}): Item[] {
  const out = items.filter((i) => isTicket(i) && inBoard(i, board) && matchesQuery(i, q) && q.columns.includes(columnKeyOf(i, q.group)));
  if (board.sort === "recent") return out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.sort((a, b) => (ranks[a.id] ?? a.rank) - (ranks[b.id] ?? b.rank) || b.updatedAt - a.updatedAt);
}

export const boardSubtitle = (board: Board) => board.subtitle ?? (board.across ? ALL_BOARDS_LABEL[currentLocale] : "");
