import type { CreateItemInput, FieldDef, ItemStatus, Patch, Priority, ViewQuery } from "@tomradex/domain";

/** Two field patches as one write; `fields` maps merge rather than replace. */
export function mergePatch(a: Patch, b: Patch): Patch {
  const out: Patch = { ...a, ...b };
  if (a.fields || b.fields) out.fields = { ...(a.fields ?? {}), ...(b.fields ?? {}) };
  return out;
}

/**
 * What an armed filter implies for a new issue, so it cannot vanish the moment
 * it is created: the first named value of every `in` clause.
 */
export function seedFromFilter(query: ViewQuery, fieldById: Map<string, FieldDef>): Patch {
  const patch: Patch = {};
  for (const clause of query.filter) {
    if (clause.op !== "in") continue;
    const value = clause.values.find((v) => v !== null);
    if (value === undefined) continue;
    switch (clause.field) {
      case "status":
        patch.status = String(value) as ItemStatus;
        break;
      case "priority":
        patch.priority = Number(value) as Priority;
        break;
      case "epic":
        patch.parentId = String(value);
        break;
      case "board":
        patch.boardId = String(value);
        break;
      case "labels":
        patch.labels = [String(value)];
        break;
      default: {
        const def = fieldById.get(clause.field);
        if (def && !def.builtin) patch.fields = { ...(patch.fields ?? {}), [clause.field]: value };
      }
    }
  }
  return patch;
}

/** A patch as creation input; null when no workstream can be found to land on. */
export function toCreateInput(title: string, patch: Patch, fallbackBoardId: string): Omit<CreateItemInput, "by"> | null {
  const boardId = patch.boardId ?? fallbackBoardId;
  if (!boardId) return null;
  return {
    title,
    boardId,
    status: patch.status ?? "todo",
    priority: patch.priority,
    parentId: patch.parentId ?? null,
    labels: patch.labels,
    fields: patch.fields
  };
}
