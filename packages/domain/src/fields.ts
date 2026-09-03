import type { FieldValue, Item, ItemStatus, Patch, Priority, Provenance } from "./types.js";
import { ITEM_STATUSES } from "./types.js";

/**
 * Every attribute a view can filter, sort or group by is a field. Built-in
 * fields are columns on `items` and are the same for every project; custom
 * fields are rows in `fields` and their values live in `item_values`.
 */
export type FieldType = "text" | "number" | "date" | "select" | "labels" | "item";

/** The types a user may create. The rest are built-in only. */
export const CUSTOM_FIELD_TYPES: readonly FieldType[] = ["text", "number", "date", "select"];

export interface FieldOption {
  id: string;
  name: string;
  description: string | null;
  rank: number;
}

export interface FieldDef {
  id: string;
  /** Null for a built-in: it exists in every project. */
  projectId: string | null;
  name: string;
  type: FieldType;
  builtin: boolean;
  /** Fixed options for a select. Empty when they come from `optionsFrom`. */
  options: FieldOption[];
  /** Built-in selects whose options are rows elsewhere; the caller resolves them. */
  optionsFrom?: "boards" | "epics";
  /** Derived or system-owned: shown and sortable, never written. */
  readonly: boolean;
  can: { filter: boolean; sort: boolean; group: boolean };
  rank: number;
}

export type BuiltinFieldId = "title" | "status" | "priority" | "epic" | "labels" | "board" | "updated" | "key" | "provenance";

const PRIORITY_NAMES = ["None", "Low", "Medium", "High", "Urgent"];
const STATUS_NAMES: Record<ItemStatus, string> = { backlog: "Backlog", todo: "To Do", doing: "Doing", verifying: "Verifying", done: "Done", cancelled: "Cancelled" };

const staticOptions = (ids: readonly string[], name: (id: string) => string): FieldOption[] =>
  ids.map((id, rank) => ({ id, name: name(id), description: null, rank }));

const builtin = (
  id: BuiltinFieldId,
  name: string,
  type: FieldType,
  rank: number,
  extra: Partial<Pick<FieldDef, "options" | "optionsFrom" | "readonly" | "can">> = {}
): FieldDef => ({
  id,
  projectId: null,
  name,
  type,
  builtin: true,
  options: extra.options ?? [],
  optionsFrom: extra.optionsFrom,
  readonly: extra.readonly ?? false,
  can: extra.can ?? { filter: true, sort: true, group: type === "select" || type === "item" },
  rank
});

/** The fields every project has, in display order. Ids are reserved: a custom field can never claim one. */
export const BUILTIN_FIELDS: readonly FieldDef[] = [
  builtin("title", "Title", "text", 0, { can: { filter: true, sort: true, group: false } }),
  builtin("status", "Status", "select", 1, { options: staticOptions(ITEM_STATUSES, (s) => STATUS_NAMES[s as ItemStatus]) }),
  // Urgent first: the column order a priority board reads in.
  builtin("priority", "Priority", "select", 2, { options: staticOptions(["4", "3", "2", "1", "0"], (p) => PRIORITY_NAMES[Number(p)]) }),
  builtin("epic", "Epic", "item", 3, { optionsFrom: "epics" }),
  builtin("labels", "Labels", "labels", 4, { can: { filter: true, sort: false, group: false } }),
  builtin("board", "Board", "select", 5, { optionsFrom: "boards" }),
  builtin("updated", "Updated", "date", 6, { readonly: true, can: { filter: true, sort: true, group: false } }),
  builtin("key", "Key", "number", 7, { readonly: true, can: { filter: false, sort: true, group: false } }),
  builtin("provenance", "Last write", "select", 8, {
    readonly: true,
    options: staticOptions(["human", "ai", "locked"], (p) => ({ human: "human", ai: "ai", locked: "human-locked" })[p as Provenance]!)
  })
];

export const BUILTIN_FIELD_IDS = new Set<string>(BUILTIN_FIELDS.map((f) => f.id));

export const isBuiltinFieldId = (id: string): id is BuiltinFieldId => BUILTIN_FIELD_IDS.has(id);

/** The empty-value sentinel a group key uses, and the literal a filter may name. */
export const EMPTY_KEY = "none";

const provenanceOf = (item: Pick<Item, "humanLocked" | "updatedBy">): Provenance => (item.humanLocked ? "locked" : item.updatedBy.startsWith("ai:") ? "ai" : "human");

/**
 * The raw value of a field on an item, built-in or custom. Labels are the one
 * multi-valued field; everything else is a scalar or null.
 */
export function fieldValueOf(item: Item, fieldId: string): FieldValue | FieldValue[] | null {
  switch (fieldId) {
    case "title":
      return item.title;
    case "status":
      return item.status;
    case "priority":
      return String(item.priority);
    case "epic":
      return item.parentId;
    case "labels":
      return item.labels;
    case "board":
      return item.boardId;
    case "updated":
      return item.updatedAt;
    case "key":
      return item.keyNum;
    case "provenance":
      return provenanceOf(item);
    default:
      return item.fields[fieldId] ?? null;
  }
}

/** Which column or swimlane an item falls into for a groupable field. */
export function groupKeyOf(item: Item, fieldId: string): string {
  const v = fieldValueOf(item, fieldId);
  if (v === null || Array.isArray(v)) return EMPTY_KEY;
  return String(v);
}

/** The patch a drop into `key` writes, for a groupable field; null when the field cannot be written. */
export function patchForGroup(fieldId: string, key: string, def: FieldDef | undefined): Patch | null {
  const empty = key === EMPTY_KEY;
  switch (fieldId) {
    case "status":
      return empty ? null : { status: key as ItemStatus };
    case "priority":
      return empty ? null : { priority: Number(key) as Priority };
    case "epic":
      return { parentId: empty ? null : key };
    case "board":
      return empty ? null : { boardId: key };
    default:
      if (!def || def.builtin || def.type !== "select") return null;
      return { fields: { [fieldId]: empty ? null : key } };
  }
}
