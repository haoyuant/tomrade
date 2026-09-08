/**
 * The SQL compiler and the pure evaluator are two implementations of one
 * query language. Every case here runs both over the same data and demands
 * the same ids in the same order.
 */
import { describe, expect, it } from "vitest";
import { compareItems, matchesFilter, type FieldDef, type FilterClause, type Item, type QueryContext, type SortKey } from "@tomrade/domain";
import { fresh } from "@tomrade/testkit";

async function seed() {
  const f = await fresh();
  const { fields, items, boards, board, project } = f;
  const other = boards.create({ projectId: project.id, name: "Core" });
  const points = fields.create({ projectId: project.id, name: "Story points", type: "number" });
  const due = fields.create({ projectId: project.id, name: "Due", type: "date" });
  const area = fields.create({ projectId: project.id, name: "Area", type: "select", options: [{ name: "Web" }, { name: "Mobile" }, { name: "Desktop" }] });
  const note = fields.create({ projectId: project.id, name: "Note", type: "text" });
  const [web, mobile, desktop] = area.options;
  const epic = items.create({ title: "Reporting", kind: "epic", boardId: board.id, by: "human" });
  const rows = [
    { title: "Alpha export", status: "todo", priority: 3, labels: ["ui", "bug"], fields: { [points.id]: 5, [due.id]: "2026-09-10", [area.id]: mobile.id, [note.id]: "Needs design" }, parentId: epic.id, by: "human" },
    { title: "beta import", status: "doing", priority: 4, labels: ["core"], fields: { [points.id]: 1, [area.id]: web.id }, by: "ai:mcp", boardId: other.id },
    { title: "Gamma sync", status: "done", priority: 1, labels: [], fields: { [points.id]: 13, [due.id]: "2026-08-01", [area.id]: desktop.id, [note.id]: "design done" }, by: "human" },
    { title: "delta cleanup", status: "backlog", priority: 2, labels: ["ui"], fields: {}, by: "ai:mcp" },
    { title: "Epsilon audit", status: "todo", priority: 0, labels: ["core", "ui"], fields: { [points.id]: 5, [due.id]: "2026-09-30", [area.id]: web.id }, parentId: epic.id, by: "human" }
  ] as const;
  const created = rows.map((r, i) => items.create({ boardId: board.id, rank: i, ...r }));
  const locked = items.update(created[2].id, { humanLocked: true }, "human");
  const defs = new Map(fields.list(project.id).map((d) => [d.id, d]));
  const ctx: QueryContext = {
    defs,
    optionRank: (fieldId, key) => {
      if (fieldId === "board") return boards.list(project.id).find((b) => b.id === key)?.rank ?? 0;
      return (defs.get(fieldId) as FieldDef).options.findIndex((o) => o.id === key);
    },
    optionName: (_fieldId, key) => items.get(key)?.title ?? ""
  };
  return { ...f, ids: { points, due, area, note, web, mobile, desktop, epic, other, locked }, created, ctx };
}

function evaluate(all: Item[], filter: FilterClause[], sortBy: SortKey[], ctx: QueryContext): string[] {
  return all
    .filter((i) => matchesFilter(i, filter))
    .sort((a, b) => compareItems(a, b, sortBy, ctx, (i) => i.rank))
    .map((i) => i.id);
}

describe("items.query ↔ pure evaluator parity", () => {
  type Seeded = Awaited<ReturnType<typeof seed>>;
  /** `keepsAll` marks a filter that is expected to pass everything through. */
  const cases: { name: string; filter?: (s: Seeded) => FilterClause[]; sort?: (s: Seeded) => SortKey[]; keepsAll?: true }[] = [
    { name: "no filter, manual order" },
    { name: "status in", filter: () => [{ field: "status", op: "in", values: ["todo", "doing"] }] },
    { name: "status not-in", filter: () => [{ field: "status", op: "not-in", values: ["done"] }] },
    { name: "priority in (numbers as keys)", filter: () => [{ field: "priority", op: "in", values: ["3", "4"] }] },
    { name: "labels any of", filter: () => [{ field: "labels", op: "in", values: ["core"] }] },
    { name: "labels empty", filter: () => [{ field: "labels", op: "in", values: [null] }] },
    { name: "labels not core", filter: () => [{ field: "labels", op: "not-in", values: ["core"] }] },
    { name: "epic in", filter: (s) => [{ field: "epic", op: "in", values: [s.ids.epic.id] }] },
    { name: "epic empty", filter: () => [{ field: "epic", op: "in", values: [null] }] },
    { name: "epic not-in empty", filter: () => [{ field: "epic", op: "not-in", values: [null] }] },
    { name: "board in", filter: (s) => [{ field: "board", op: "in", values: [s.ids.other.id] }] },
    { name: "provenance ai", filter: () => [{ field: "provenance", op: "in", values: ["ai"] }] },
    { name: "provenance locked", filter: () => [{ field: "provenance", op: "in", values: ["locked"] }] },
    { name: "title contains", filter: () => [{ field: "title", op: "contains", values: ["A"] }] },
    { name: "custom select in", filter: (s) => [{ field: s.ids.area.id, op: "in", values: [s.ids.web.id] }] },
    { name: "custom select in or empty", filter: (s) => [{ field: s.ids.area.id, op: "in", values: [s.ids.web.id, null] }] },
    { name: "custom select not-in", filter: (s) => [{ field: s.ids.area.id, op: "not-in", values: [s.ids.web.id] }] },
    { name: "custom select not-in incl empty", filter: (s) => [{ field: s.ids.area.id, op: "not-in", values: [s.ids.web.id, null] }] },
    { name: "number gte", filter: (s) => [{ field: s.ids.points.id, op: "gte", values: [5] }] },
    { name: "number lte", filter: (s) => [{ field: s.ids.points.id, op: "lte", values: [5] }] },
    { name: "date gte", filter: (s) => [{ field: s.ids.due.id, op: "gte", values: ["2026-09-01"] }] },
    { name: "text contains", filter: (s) => [{ field: s.ids.note.id, op: "contains", values: ["design"] }] },
    { name: "updated lte today keeps everything written today", filter: () => [{ field: "updated", op: "lte", values: [new Date().toISOString().slice(0, 10)] }], keepsAll: true },
    { name: "updated lte yesterday drops everything written today", filter: () => [{ field: "updated", op: "lte", values: [new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)] }] },
    { name: "updated gte tomorrow drops everything", filter: () => [{ field: "updated", op: "gte", values: [new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)] }] },
    { name: "two clauses and", filter: (s) => [{ field: "labels", op: "in", values: ["ui"] }, { field: s.ids.points.id, op: "gte", values: [1] }] },
    { name: "sort priority asc (urgent first)", sort: () => [{ field: "priority", dir: "asc" }] },
    { name: "sort status desc", sort: () => [{ field: "status", dir: "desc" }] },
    { name: "sort title", sort: () => [{ field: "title", dir: "asc" }] },
    { name: "sort key desc", sort: () => [{ field: "key", dir: "desc" }] },
    { name: "sort number desc, empties last", sort: (s) => [{ field: s.ids.points.id, dir: "desc" }] },
    { name: "sort number asc, empties last", sort: (s) => [{ field: s.ids.points.id, dir: "asc" }] },
    { name: "sort date", sort: (s) => [{ field: s.ids.due.id, dir: "asc" }] },
    { name: "sort custom select by option order", sort: (s) => [{ field: s.ids.area.id, dir: "asc" }] },
    { name: "sort text", sort: (s) => [{ field: s.ids.note.id, dir: "asc" }] },
    { name: "sort epic by title", sort: () => [{ field: "epic", dir: "asc" }] },
    { name: "sort board", sort: () => [{ field: "board", dir: "desc" }] },
    { name: "sort provenance", sort: () => [{ field: "provenance", dir: "asc" }] },
    { name: "sort two keys", sort: (s) => [{ field: s.ids.points.id, dir: "asc" }, { field: "title", dir: "desc" }] },
    { name: "filter + sort", filter: () => [{ field: "labels", op: "in", values: ["ui"] }], sort: (s) => [{ field: s.ids.due.id, dir: "desc" }] }
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const s = await seed();
      const filter = c.filter?.(s) ?? [];
      const sortBy = c.sort?.(s) ?? [];
      const all = s.items.list({ projectId: s.project.id });
      const expected = evaluate(all, filter, sortBy, s.ctx);
      const actual = s.items.query({ projectId: s.project.id, filter, sortBy }).map((i) => i.id);
      expect(actual).toEqual(expected);
      // a query that filters must have filtered, or the case proves nothing
      if (filter.length && !c.keepsAll) expect(actual.length).toBeLessThan(all.length);
      else expect(actual.length).toBe(all.length);
    });
  }

  it("unknown or unsortable fields are ignored rather than breaking the query", async () => {
    const s = await seed();
    const all = s.items.list({ projectId: s.project.id }).length;
    expect(s.items.query({ projectId: s.project.id, filter: [{ field: "ghost", op: "in", values: ["x"] }], sortBy: [{ field: "labels", dir: "asc" }] }).length).toBe(all);
  });
});
