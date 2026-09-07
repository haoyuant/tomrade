/**
 * The field registry: built-ins are constant and untouchable, custom fields
 * are project rows whose values ride on items through the ordinary write path.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_FIELDS, FieldDefinitionError, FieldValueError } from "@tomrade/domain";
import { fresh } from "@tomrade/testkit";

describe("fields", () => {
  it("lists built-ins first, then the project's own in rank order", async () => {
    const { fields, project } = await fresh();
    const points = fields.create({ projectId: project.id, name: "Story points", type: "number" });
    const due = fields.create({ projectId: project.id, name: "Due", type: "date" });
    const all = fields.list(project.id);
    expect(all.slice(0, BUILTIN_FIELDS.length).map((f) => f.id)).toEqual(BUILTIN_FIELDS.map((f) => f.id));
    expect(all.slice(BUILTIN_FIELDS.length).map((f) => f.id)).toEqual([points.id, due.id]);
    expect(points.can).toEqual({ filter: true, sort: true, group: false });
  });

  it("a select carries its options in order and can grow, rename and shed them", async () => {
    const { fields, items, board, project } = await fresh();
    const area = fields.create({ projectId: project.id, name: "Area", type: "select", options: [{ name: "Web" }, { name: "Mobile", description: "iOS + Android" }] });
    expect(area.options.map((o) => o.name)).toEqual(["Web", "Mobile"]);
    expect(area.can.group).toBe(true);
    const desk = fields.addOption(project.id, area.id, { name: "Desktop" });
    fields.updateOption(project.id, area.id, desk.id, { name: "Desktop app", rank: -1 });
    expect(fields.get(project.id, area.id)!.options.map((o) => o.name)).toEqual(["Desktop app", "Web", "Mobile"]);

    const [web, mobile] = area.options;
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, fields: { [area.id]: web.id }, by: "human" });
    const b = items.create({ projectId: project.id, title: "B", boardId: board.id, fields: { [area.id]: mobile.id }, by: "human" });
    // removing an option clears or moves the items holding it
    expect(fields.removeOption(project.id, area.id, web.id, { moveTo: mobile.id })).toBe(1);
    expect(items.get(project.id, a.id)!.fields[area.id]).toBe(mobile.id);
    expect(fields.removeOption(project.id, area.id, mobile.id)).toBe(2);
    expect(items.get(project.id, a.id)!.fields).toEqual({});
    expect(items.get(project.id, b.id)!.fields).toEqual({});
  });

  it("names are unique per project and never shadow a built-in", async () => {
    const { fields, project, projects } = await fresh();
    fields.create({ projectId: project.id, name: "Due", type: "date" });
    expect(() => fields.create({ projectId: project.id, name: "due", type: "text" })).toThrow(FieldDefinitionError);
    expect(() => fields.create({ projectId: project.id, name: "Status", type: "text" })).toThrow(FieldDefinitionError);
    const other = projects.create({ name: "Other" });
    expect(fields.create({ projectId: other.id, name: "Due", type: "date" }).name).toBe("Due");
  });

  it("built-ins cannot be changed or removed", async () => {
    const { fields, project } = await fresh();
    expect(() => fields.update(project.id, "status", { name: "State" })).toThrow(FieldDefinitionError);
    expect(() => fields.remove(project.id, "priority")).toThrow(FieldDefinitionError);
    expect(() => fields.addOption(project.id, "status", { name: "Blocked" })).toThrow(FieldDefinitionError);
  });

  it("values are typed: the wrong shape is refused before the write path", async () => {
    const { fields, items, board, project } = await fresh();
    const points = fields.create({ projectId: project.id, name: "Story points", type: "number" });
    const due = fields.create({ projectId: project.id, name: "Due", type: "date" });
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    expect(() => items.update(project.id, item.id, { fields: { [points.id]: "five" } }, "human")).toThrow(FieldValueError);
    expect(() => items.update(project.id, item.id, { fields: { [due.id]: "next week" } }, "human")).toThrow(FieldValueError);
    expect(() => items.update(project.id, item.id, { fields: { status: "done" } }, "human")).toThrow(FieldValueError);
    expect(() => items.update(project.id, item.id, { fields: { ghost: 1 } }, "human")).toThrow(FieldValueError);
    // a refused value is not a write: the version did not move
    expect(items.get(project.id, item.id)!.version).toBe(1);
    const next = items.update(project.id, item.id, { fields: { [points.id]: 5, [due.id]: "2026-09-12" } }, "human");
    expect(next.fields).toEqual({ [points.id]: 5, [due.id]: "2026-09-12" });
    expect(next.version).toBe(2);
  });

  it("a checkbox is stored only when ticked; unticking clears the row", async () => {
    const { fields, items, board, project } = await fresh();
    const done = fields.create({ projectId: project.id, name: "Reviewed", type: "checkbox" });
    expect(done.can).toEqual({ filter: true, sort: false, group: true });
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, fields: { [done.id]: 1 }, by: "human" });
    expect(item.fields).toEqual({ [done.id]: 1 });
    expect(items.update(project.id, item.id, { fields: { [done.id]: 0 } }, "human").fields).toEqual({});
    expect(() => items.update(project.id, item.id, { fields: { [done.id]: 2 } }, "human")).toThrow(FieldValueError);
    expect(items.query({ projectId: project.id, filter: [{ field: done.id, op: "in", values: [null] }] }).map((i) => i.id)).toEqual([item.id]);
  });

  it("a fields patch merges: null clears one key and leaves the rest", async () => {
    const { fields, items, oplog, board, project } = await fresh();
    const points = fields.create({ projectId: project.id, name: "Story points", type: "number" });
    const note = fields.create({ projectId: project.id, name: "Note", type: "text" });
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, fields: { [points.id]: 3, [note.id]: "spike first" }, by: "human" });
    const cleared = items.update(project.id, item.id, { fields: { [points.id]: null } }, "human");
    expect(cleared.fields).toEqual({ [note.id]: "spike first" });
    // and the write is undoable like any other
    oplog.undoLast(project.id, item.id);
    expect(items.get(project.id, item.id)!.fields).toEqual({ [points.id]: 3, [note.id]: "spike first" });
  });

  it("removing a field takes its values with it; deleting a project takes its fields", async () => {
    const { fields, items, board, project, projects, db } = await fresh();
    const points = fields.create({ projectId: project.id, name: "Story points", type: "number" });
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, fields: { [points.id]: 8 }, by: "human" });
    fields.remove(project.id, points.id);
    expect(items.get(project.id, item.id)!.fields).toEqual({});
    expect(fields.custom(project.id)).toEqual([]);
    const other = projects.create({ name: "Other" });
    fields.create({ projectId: other.id, name: "Area", type: "select", options: [{ name: "Web" }] });
    projects.remove(other.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM field_options").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM fields").get() as { n: number }).n).toBe(0);
  });
});
