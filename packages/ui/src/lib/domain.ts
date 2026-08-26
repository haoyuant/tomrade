import type { Board, GroupBy, Item, ItemStatus, OplogEntry, Priority, Provenance, View, ViewFilter } from "@tomrade/core";
import type { IconId } from "~/components/icons";

/** Status marks are shape-coded: each is legible in greyscale. */
export const STATUS: Record<ItemStatus, { label: string; mark: IconId }> = {
  backlog: { label: "Backlog", mark: "s-backlog" },
  todo: { label: "To Do", mark: "s-todo" },
  doing: { label: "Doing", mark: "s-doing" },
  verifying: { label: "Verifying", mark: "s-verifying" },
  done: { label: "Done", mark: "s-done" },
  cancelled: { label: "Cancelled", mark: "s-cancelled" }
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
export const PRIORITY_LABEL = ["None", "Low", "Medium", "High", "Urgent"] as const;

export const GROUPS: Record<GroupBy, { label: string; icon: IconId }> = {
  status: { label: "Status", icon: "s-doing" },
  priority: { label: "Priority", icon: "i-bars" },
  epic: { label: "Epic", icon: "i-stack" }
};

export const PROVENANCE: Record<Provenance, string> = {
  ai: "ai:mcp",
  human: "human",
  locked: "human-locked"
};

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

/** "2m ago", but "now" stays bare — "now ago" is not a phrase. */
export const agoLabel = (ts: number, now = Date.now()) => {
  const short = timeAgo(ts, now);
  return short === "now" ? "now" : `${short} ago`;
};

/** Short relative time, the same string the card prints and recency sorts on. */
export function timeAgo(ts: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - ts) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo` : `${Math.round(months / 12)}y`;
}

/** What one oplog row did, phrased from the before/after snapshots. */
export function describeWrite(entry: OplogEntry): string {
  if (entry.op === "create") return "created the issue";
  if (entry.op === "delete") return "deleted the issue";
  const before = entry.before as Item | null;
  const after = entry.after as Item | null;
  if (before && after) {
    if (before.status !== after.status) return `set status to ${after.status}`;
    if (before.priority !== after.priority) return `set priority to ${PRIORITY_LABEL[after.priority].toLowerCase()}`;
    if (before.humanLocked !== after.humanLocked) return after.humanLocked ? "locked title and body" : "unlocked title and body";
    if (before.parentId !== after.parentId) return after.parentId ? "linked the issue to an epic" : "unlinked the issue from its epic";
    if (before.labels.join() !== after.labels.join()) return "changed the labels";
    if (before.boardId !== after.boardId) return "moved the issue to another board";
    if (before.title !== after.title) return "edited the title";
    if (before.body !== after.body) return "edited the description";
    if (before.rank !== after.rank) return "reordered the issue";
  }
  return "updated the issue";
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
  if (group === "epic") return key === "none" ? "No epic" : (epicNames.get(key) ?? "Epic");
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

export const boardSubtitle = (board: Board) => board.subtitle ?? (board.across ? "all boards" : "");
