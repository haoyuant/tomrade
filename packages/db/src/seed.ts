import { randomUUID } from "node:crypto";
import type { Queryable } from "./sqlite.js";

/** The stored shape of a view's query; the domain's `ViewQuery` without the type dependency. */
export interface ViewSeed {
  name: string;
  icon: string;
  layout: "board" | "table" | "graph";
  query: Record<string, unknown>;
}

/** The languages a seed can be written in; anything else reads as English. */
export type SeedLocale = "en" | "zh";

/** Seeded rows are data, not labels: once written they are the project's own names, so they are written in the language the person reads. */
const SEED_NAMES: Record<SeedLocale, { main: string; backlog: string; recent: string; grouped: Record<GroupedTableField, string> }> = {
  en: { main: "Main", backlog: "Backlog", recent: "Recently updated", grouped: { status: "By status", epic: "By epic", priority: "By priority", board: "By workstream" } },
  zh: { main: "主线", backlog: "看板", recent: "最近更新", grouped: { status: "按状态", epic: "按需求组", priority: "按优先级", board: "按工作流" } }
};

/** Tables grouped by one field, urgent first within a group; the renderer offers the same ones as presets (ui lib/viewPresets.ts). */
const GROUPED_TABLES = [
  { groupBy: "status", icon: "i-cards" },
  { groupBy: "epic", icon: "i-stack" },
  { groupBy: "priority", icon: "i-alarm" },
  { groupBy: "board", icon: "i-split" }
] as const;
type GroupedTableField = (typeof GROUPED_TABLES)[number]["groupBy"];

const groupedTableQuery = (groupBy: GroupedTableField): Record<string, unknown> => ({
  groupBy,
  sortBy: [
    { field: "priority", dir: "asc" },
    { field: "updated", dir: "desc" }
  ]
});

export const seedLocale = (locale?: string | null): SeedLocale => (locale?.toLowerCase().startsWith("zh") ? "zh" : "en");

/** The name a new project's first workstream gets. */
export const mainBoardName = (locale?: string | null): string => SEED_NAMES[seedLocale(locale)].main;

/** The views every new project opens with, named in `locale`. The first is what the project route lands on. */
export function defaultViews(locale?: string | null): readonly ViewSeed[] {
  const names = SEED_NAMES[seedLocale(locale)];
  return [
    { name: names.backlog, icon: "i-board", layout: "board", query: { columnBy: "status" } },
    { name: names.recent, icon: "i-clock", layout: "table", query: { sortBy: [{ field: "updated", dir: "desc" }] } },
    ...GROUPED_TABLES.map((g): ViewSeed => ({ name: names.grouped[g.groupBy], icon: g.icon, layout: "table", query: groupedTableQuery(g.groupBy) }))
  ];
}

/** Raw insert, for seeds and migrations; `ctx.views.create` is the logged path. */
export function insertViewRow(db: Queryable, projectId: string, seed: ViewSeed, rank: number, now: number, id = randomUUID()): string {
  db.prepare(
    `INSERT INTO views (id, project_id, board_id, name, icon, layout, query_json, rank, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, seed.name, seed.icon, seed.layout, JSON.stringify(seed.query), rank, now, now);
  return id;
}

export function seedDefaultViews(db: Queryable, projectId: string, now: number, locale?: string | null): string {
  let first = "";
  defaultViews(locale).forEach((seed, rank) => {
    const id = insertViewRow(db, projectId, seed, rank, now);
    if (rank === 0) first = id;
  });
  return first;
}

/** Seeds the Main workstream and the default views, named in `locale`; returns the board's id. */
export function seedProject(db: Queryable, projectId: string, now: number, locale?: string | null): string {
  const boardId = randomUUID();
  db.prepare(
    `INSERT INTO boards (id, project_id, name, icon, across, sort, note, rank, created_at, updated_at)
     VALUES (?, ?, ?, 'i-board', 0, NULL, NULL, 0, ?, ?)`
  ).run(boardId, projectId, mainBoardName(locale), now, now);
  seedDefaultViews(db, projectId, now, locale);
  return boardId;
}
