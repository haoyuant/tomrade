import { describe, expect, it } from "vitest";
import { CORE_RULES, mergeStates, type LogOp, type MergeState } from "../src/merge.js";

const item = (id: string, key: number, patch: Record<string, unknown> = {}) => ({
  id,
  project_id: "p",
  board_id: "b",
  key_num: key,
  title: `Item ${key}`,
  body: null,
  kind: "ticket",
  status: "backlog",
  priority: 2,
  parent_id: null,
  rank: 0,
  updated_at: 100,
  updated_by: "human",
  version: 1,
  human_locked: 0,
  ...patch
});

const state = (items: Record<string, unknown>[], extra: Partial<MergeState["tables"]> = {}): MergeState => ({
  project: { id: "p", name: "P", description: null, key_prefix: "APP", created_at: 1 },
  tables: { items, ...extra }
});

const op = (device: string, seq: number, at: number, entityId: string, patch: Record<string, unknown>): LogOp => ({
  device,
  deviceSeq: seq,
  at,
  by: "human",
  entity: "item",
  entityId,
  op: "update",
  patch
});

const merge = (base: MergeState | null, ours: MergeState, theirs: MergeState, logs = { ours: [] as LogOp[], theirs: [] as LogOp[] }) =>
  mergeStates({ base, ours, theirs, logs, rules: CORE_RULES });

describe("three-way merge", () => {
  it("refuses incompatible delivery histories instead of importing two active deliveries", () => {
    const delivery = (id: string, sequence: number) => ({ id, item_id: "a", sequence, state: "active" });
    const base = state([item("a", 1)]);
    expect(() => merge(base, state([item("a", 1)], { deliveries: [delivery("one", 1)] }), state([item("a", 1)], { deliveries: [delivery("two", 2)] }))).toThrow("Delivery sync conflict");
    const both = state([item("a", 1)], { deliveries: [delivery("a:delivery:1", 1)] });
    expect(merge(base, both, both).merged.tables.deliveries).toHaveLength(1);
  });

  it("refuses an undo that would orphan a concurrently submitted file reference", () => {
    const resource = { id: "r", role: "output", deliveryId: "d", createdAt: 1 };
    const evidence = (resources: unknown[], submissions: unknown[]) => JSON.stringify({ resources, submissions, reviews: [] });
    const base = state([item("a", 1, { evidence_json: evidence([resource], []) })]);
    const undo = state([item("a", 1, { evidence_json: evidence([], []) })]);
    const submitted = state([item("a", 1, { evidence_json: evidence([resource], [{ id: "s", deliveryId: "d", artifactIds: ["r"], submittedAt: 2 }]) })]);
    expect(() => merge(base, undo, submitted)).toThrow("evidence sync conflict");
    expect(() => merge(base, submitted, undo)).toThrow("evidence sync conflict");
  });
  it("keeps independent delivery artifacts from both machines and honors undo removals", () => {
    const evidence = (resources: { id: string; createdAt: number }[]) => JSON.stringify({ resources, submissions: [], reviews: [] });
    const original = { id: "reference", createdAt: 1 };
    const a = { id: "artifact-a", createdAt: 2 };
    const b = { id: "artifact-b", createdAt: 3 };
    const base = state([item("a", 1, { evidence_json: evidence([original]) })]);
    const ours = state([item("a", 1, { evidence_json: evidence([original, a]) })]);
    const theirs = state([item("a", 1, { evidence_json: evidence([original, b]) })]);
    const merged = merge(base, ours, theirs).merged.tables.items[0];
    expect(JSON.parse(String(merged.evidence_json)).resources).toEqual([original, a, b]);
    const undone = state([item("a", 1, { evidence_json: evidence([]) })]);
    expect(JSON.parse(String(merge(base, undone, theirs).merged.tables.items[0].evidence_json)).resources).toEqual([b]);
  });
  it("takes each side's own edits when they touch different fields of one row", () => {
    const base = state([item("a", 1)]);
    const ours = state([item("a", 1, { status: "doing", updated_at: 200, version: 2 })]);
    const theirs = state([item("a", 1, { title: "Renamed", updated_at: 300, version: 2 })]);
    const { merged, conflicts } = merge(base, ours, theirs);
    expect(merged.tables.items[0]).toMatchObject({ status: "doing", title: "Renamed", updated_at: 300, version: 3 });
    expect(conflicts).toEqual([]);
  });

  it("settles the same field by the later log entry and notes it", () => {
    const base = state([item("a", 1)]);
    const ours = state([item("a", 1, { status: "doing" })]);
    const theirs = state([item("a", 1, { status: "done" })]);
    const logs = { ours: [op("m1", 5, 1000, "a", { status: "doing" })], theirs: [op("m2", 9, 2000, "a", { status: "done" })] };
    const { merged, conflicts } = merge(base, ours, theirs, logs);
    expect(merged.tables.items[0].status).toBe("done");
    expect(conflicts).toEqual([expect.objectContaining({ entity: "item", entityId: "a", field: "status", ours: "doing", theirs: "done", took: "theirs", reason: "later" })]);
    const flipped = merge(base, ours, theirs, { ours: [op("m1", 5, 3000, "a", { status: "doing" })], theirs: logs.theirs });
    expect(flipped.merged.tables.items[0].status).toBe("doing");
    expect(flipped.conflicts[0].took).toBe("ours");
  });

  it("breaks a timestamp tie by device id, and falls back to theirs without a log", () => {
    const base = state([item("a", 1)]);
    const ours = state([item("a", 1, { status: "doing" })]);
    const theirs = state([item("a", 1, { status: "done" })]);
    const tie = merge(base, ours, theirs, { ours: [op("zz", 1, 1000, "a", { status: "doing" })], theirs: [op("aa", 1, 1000, "a", { status: "done" })] });
    expect(tie.merged.tables.items[0].status).toBe("doing");
    expect(tie.conflicts[0].reason).toBe("device");
    const silent = merge(base, ours, theirs);
    expect(silent.merged.tables.items[0].status).toBe("done");
    expect(silent.conflicts[0].reason).toBe("no-log");
  });

  it("is deterministic: swapping sides yields the same rows", () => {
    const base = state([item("a", 1), item("b", 2)]);
    const ours = state([item("a", 1, { status: "doing" }), item("b", 2, { title: "B!" })]);
    const theirs = state([item("a", 1, { status: "done" }), item("b", 2, { priority: 1 })]);
    const logs = { ours: [op("m1", 1, 100, "a", { status: "doing" })], theirs: [op("m2", 1, 200, "a", { status: "done" })] };
    const one = merge(base, ours, theirs, logs).merged;
    const two = merge(base, theirs, ours, { ours: logs.theirs, theirs: logs.ours }).merged;
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it("keeps a row one side edited and the other deleted, with a note", () => {
    const base = state([item("a", 1), item("b", 2)]);
    const ours = state([item("a", 1, { title: "kept" })]); // deleted b, edited a
    const theirs = state([item("b", 2, { title: "edited there" })]); // deleted a, edited b
    const { merged, conflicts } = merge(base, ours, theirs);
    expect(merged.tables.items.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(conflicts.map((c) => [c.entityId, c.reason, c.took])).toEqual([
      ["a", "edited-over-delete", "ours"],
      ["b", "edited-over-delete", "theirs"]
    ]);
  });

  it("lets an untouched row's deletion stand", () => {
    const base = state([item("a", 1), item("b", 2)]);
    const ours = state([item("a", 1)]);
    const theirs = state([item("a", 1), item("b", 2)]);
    expect(merge(base, ours, theirs).merged.tables.items.map((r) => r.id)).toEqual(["a"]);
  });

  it("merges set tables as union minus one side's removals", () => {
    const rel = (from: string, to: string) => ({ from_item_id: from, to_item_id: to, kind: "blocks" });
    const base = state([], { item_relations: [rel("a", "b"), rel("a", "c")] });
    const ours = state([], { item_relations: [rel("a", "b"), rel("a", "d")] }); // removed a→c, added a→d
    const theirs = state([], { item_relations: [rel("a", "b"), rel("a", "c"), rel("x", "y")] }); // added x→y
    const rows = merge(base, ours, theirs).merged.tables.item_relations.map((r) => `${r.from_item_id}>${r.to_item_id}`);
    expect(rows).toEqual(["a>b", "a>d", "x>y"]);
    // Without a base nothing can be called a removal: pure union.
    const union = merge(null, ours, theirs).merged.tables.item_relations.length;
    expect(union).toBe(4);
  });

  it("renumbers our unpublished issues when both sides created the same key", () => {
    const base = state([item("a", 1)]);
    const ours = state([item("a", 1), item("o1", 2), item("o2", 3)]);
    const theirs = state([item("a", 1), item("t1", 2)]);
    const { merged, renumbered } = merge(base, ours, theirs);
    const keys = Object.fromEntries(merged.tables.items.map((r) => [r.id, r.key_num]));
    expect(keys.t1).toBe(2);
    expect(keys.o2).toBe(3);
    expect(keys.o1).toBe(4);
    expect(renumbered).toEqual([{ itemId: "o1", from: 2, to: 4 }]);
  });

  it("orders quietly: view ranks take theirs on a collision with no note", () => {
    const base = state([], { view_item_rank: [{ view_id: "v", item_id: "a", rank: 1 }] });
    const ours = state([], { view_item_rank: [{ view_id: "v", item_id: "a", rank: 2 }] });
    const theirs = state([], { view_item_rank: [{ view_id: "v", item_id: "a", rank: 3 }] });
    const { merged, conflicts } = merge(base, ours, theirs);
    expect(merged.tables.view_item_rank[0].rank).toBe(3);
    expect(conflicts).toEqual([]);
  });

  it("arbitrates a custom value through the item's fields patch", () => {
    const base = state([item("a", 1)], { item_values: [{ item_id: "a", field_id: "f", num: 1, text: null }] });
    const ours = state([item("a", 1)], { item_values: [{ item_id: "a", field_id: "f", num: 5, text: null }] });
    const theirs = state([item("a", 1)], { item_values: [{ item_id: "a", field_id: "f", num: 8, text: null }] });
    const logs = { ours: [op("m1", 1, 900, "a", { fields: { f: 5 } })], theirs: [op("m2", 1, 500, "a", { fields: { f: 8 } })] };
    const { merged, conflicts } = merge(base, ours, theirs, logs);
    expect(merged.tables.item_values[0].num).toBe(5);
    expect(conflicts[0]).toMatchObject({ table: "item_values", entityId: "a", took: "ours" });
  });
});
