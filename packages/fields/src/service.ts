import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import type { Db } from "@tomrade/db";
import {
  BUILTIN_FIELDS,
  CUSTOM_FIELD_TYPES,
  FieldDefinitionError,
  FieldValueError,
  NotFoundError,
  isBuiltinFieldId,
  type FieldDef,
  type FieldOption,
  type FieldType,
  type FieldValue
} from "@tomrade/domain";
import { registerChannels, registerTools } from "./contributions.js";

declare module "cordis" {
  interface Context {
    fields: Fields;
  }
}

interface FieldRow {
  id: string;
  project_id: string;
  name: string;
  type: string;
  rank: number;
  created_at: number;
  updated_at: number;
}

interface OptionRow {
  id: string;
  field_id: string;
  name: string;
  description: string | null;
  rank: number;
}

export interface CreateFieldInput {
  projectId: string;
  name: string;
  type: FieldType;
  options?: FieldOptionInput[];
  rank?: number;
}

export type FieldPatch = Partial<Pick<FieldDef, "name" | "rank">>;

export interface FieldOptionInput {
  name: string;
  description?: string | null;
}

export type FieldOptionPatch = Partial<Pick<FieldOption, "name" | "description" | "rank">>;

/** How a value sits in `item_values`: numbers in `num`, everything else in `text`. */
export type StoredValue = { num: number | null; text: string | null };

const rowToOption = (r: OptionRow): FieldOption => ({ id: r.id, name: r.name, description: r.description, rank: r.rank });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The registry every view reads its vocabulary from. Built-ins are constants;
 * custom definitions are project rows. Definitions sit outside the oplog like
 * projects do — they are schema, not work — while the values they hold are
 * written through `items.update` and carry every guarantee an item write has.
 */
export class Fields extends Service {
  static provide = "fields";
  static inject = ["db"];

  constructor(ctx: Context) {
    super(ctx, "fields");
  }

  [Service.init]() {
    this.ctx.inject(["tools"], registerTools);
    this.ctx.inject(["ipc"], registerChannels);
  }

  private get db(): Db {
    return this.ctx.db;
  }

  /** Built-ins first, then the project's own, each in its rank order. */
  list(projectId: string): FieldDef[] {
    return [...BUILTIN_FIELDS, ...this.custom(projectId)];
  }

  custom(projectId: string): FieldDef[] {
    const rows = this.db.prepare("SELECT * FROM fields WHERE project_id = ? ORDER BY rank ASC, created_at ASC").all(projectId) as FieldRow[];
    if (!rows.length) return [];
    const placeholders = rows.map(() => "?").join(",");
    const options = this.db.prepare(`SELECT * FROM field_options WHERE field_id IN (${placeholders}) ORDER BY rank ASC`).all(...rows.map((r) => r.id)) as OptionRow[];
    return rows.map((r) => this.toDef(r, options.filter((o) => o.field_id === r.id)));
  }

  get(id: string): FieldDef | null {
    const builtin = BUILTIN_FIELDS.find((f) => f.id === id);
    if (builtin) return builtin;
    const row = this.db.prepare("SELECT * FROM fields WHERE id = ?").get(id) as FieldRow | undefined;
    if (!row) return null;
    return this.toDef(row, this.db.prepare("SELECT * FROM field_options WHERE field_id = ? ORDER BY rank ASC").all(id) as OptionRow[]);
  }

  create(input: CreateFieldInput): FieldDef {
    if (!CUSTOM_FIELD_TYPES.includes(input.type)) throw new FieldDefinitionError(input.name, `type ${input.type} cannot be created`);
    const name = input.name.trim();
    if (!name) throw new FieldDefinitionError(input.name, "a field needs a name");
    this.assertNameFree(input.projectId, name);
    const now = Date.now();
    const id = randomUUID();
    const rank =
      input.rank ?? ((this.db.prepare("SELECT MAX(rank) AS m FROM fields WHERE project_id = ?").get(input.projectId) as { m: number | null }).m ?? -1) + 1;
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO fields (id, project_id, name, type, rank, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.projectId, name, input.type, rank, now, now);
      (input.options ?? []).forEach((o, i) => this.insertOption(id, o, i));
    });
    return this.get(id)!;
  }

  update(id: string, patch: FieldPatch): FieldDef {
    const existing = this.customRow(id);
    const name = patch.name?.trim() ?? existing.name;
    if (!name) throw new FieldDefinitionError(id, "a field needs a name");
    if (name !== existing.name) this.assertNameFree(existing.project_id, name);
    this.db.prepare("UPDATE fields SET name = ?, rank = ?, updated_at = ? WHERE id = ?").run(name, patch.rank ?? existing.rank, Date.now(), id);
    return this.get(id)!;
  }

  /** Takes every value with it. The caller confirms; there is no undo for schema. */
  remove(id: string): void {
    this.customRow(id);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM item_values WHERE field_id = ?").run(id);
      this.db.prepare("DELETE FROM field_options WHERE field_id = ?").run(id);
      this.db.prepare("DELETE FROM fields WHERE id = ?").run(id);
    });
  }

  addOption(fieldId: string, input: FieldOptionInput): FieldOption {
    const field = this.customRow(fieldId);
    if (field.type !== "select") throw new FieldDefinitionError(fieldId, "only a select has options");
    const rank = ((this.db.prepare("SELECT MAX(rank) AS m FROM field_options WHERE field_id = ?").get(fieldId) as { m: number | null }).m ?? -1) + 1;
    const id = this.insertOption(fieldId, input, rank);
    this.touch(fieldId);
    return rowToOption(this.db.prepare("SELECT * FROM field_options WHERE id = ?").get(id) as OptionRow);
  }

  updateOption(fieldId: string, optionId: string, patch: FieldOptionPatch): FieldOption {
    const existing = this.optionRow(fieldId, optionId);
    const name = patch.name?.trim() ?? existing.name;
    if (!name) throw new FieldDefinitionError(fieldId, "an option needs a name");
    this.db
      .prepare("UPDATE field_options SET name = ?, description = ?, rank = ? WHERE id = ?")
      .run(name, patch.description === undefined ? existing.description : patch.description, patch.rank ?? existing.rank, optionId);
    this.touch(fieldId);
    return rowToOption(this.db.prepare("SELECT * FROM field_options WHERE id = ?").get(optionId) as OptionRow);
  }

  /** Items holding the option are moved to `moveTo` or cleared. Returns how many were touched. */
  removeOption(fieldId: string, optionId: string, opts: { moveTo?: string } = {}): number {
    this.optionRow(fieldId, optionId);
    if (opts.moveTo) this.optionRow(fieldId, opts.moveTo);
    return this.db.transaction(() => {
      const touched = opts.moveTo
        ? this.db.prepare("UPDATE item_values SET text = ? WHERE field_id = ? AND text = ?").run(opts.moveTo, fieldId, optionId).changes
        : this.db.prepare("DELETE FROM item_values WHERE field_id = ? AND text = ?").run(fieldId, optionId).changes;
      this.db.prepare("DELETE FROM field_options WHERE id = ?").run(optionId);
      this.touch(fieldId);
      return touched;
    });
  }

  /**
   * Check a `fields` patch against the project's definitions and say how each
   * value is stored. Null clears. Built-ins are refused here: they have their
   * own patch keys and their own rules.
   */
  normalize(projectId: string, patch: Record<string, FieldValue | null>): Map<string, StoredValue | null> {
    const defs = new Map(this.custom(projectId).map((f) => [f.id, f]));
    const out = new Map<string, StoredValue | null>();
    for (const [fieldId, value] of Object.entries(patch)) {
      if (isBuiltinFieldId(fieldId)) throw new FieldValueError(fieldId, "built-in fields are written through their own patch keys");
      const def = defs.get(fieldId);
      if (!def) throw new FieldValueError(fieldId, "no such field in this project");
      out.set(fieldId, value === null ? null : storedValue(def, value));
    }
    return out;
  }

  private toDef(r: FieldRow, options: OptionRow[]): FieldDef {
    const type = r.type as FieldType;
    return {
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      type,
      builtin: false,
      options: options.map(rowToOption),
      readonly: false,
      can: { filter: true, sort: true, group: type === "select" },
      rank: r.rank
    };
  }

  private customRow(id: string): FieldRow {
    if (isBuiltinFieldId(id)) throw new FieldDefinitionError(id, "built-in fields cannot be changed");
    const row = this.db.prepare("SELECT * FROM fields WHERE id = ?").get(id) as FieldRow | undefined;
    if (!row) throw new NotFoundError(id);
    return row;
  }

  private optionRow(fieldId: string, optionId: string): OptionRow {
    this.customRow(fieldId);
    const row = this.db.prepare("SELECT * FROM field_options WHERE id = ? AND field_id = ?").get(optionId, fieldId) as OptionRow | undefined;
    if (!row) throw new NotFoundError(optionId);
    return row;
  }

  private insertOption(fieldId: string, input: FieldOptionInput, rank: number): string {
    const name = input.name.trim();
    if (!name) throw new FieldDefinitionError(fieldId, "an option needs a name");
    const id = randomUUID();
    this.db.prepare("INSERT INTO field_options (id, field_id, name, description, rank) VALUES (?, ?, ?, ?, ?)").run(id, fieldId, name, input.description ?? null, rank);
    return id;
  }

  /** A field's name is its identity in a filter bar, so two cannot share one; built-in names are taken too. */
  private assertNameFree(projectId: string, name: string): void {
    const lower = name.toLowerCase();
    if (BUILTIN_FIELDS.some((f) => f.name.toLowerCase() === lower)) throw new FieldDefinitionError(name, `"${name}" is a built-in field`);
    const clash = this.db.prepare("SELECT 1 FROM fields WHERE project_id = ? AND lower(name) = ?").get(projectId, lower);
    if (clash) throw new FieldDefinitionError(name, `a field named "${name}" already exists`);
  }

  private touch(fieldId: string): void {
    this.db.prepare("UPDATE fields SET updated_at = ? WHERE id = ?").run(Date.now(), fieldId);
  }
}

/** Where a value goes, and whether it is a value the field can hold at all. */
export function storedValue(def: FieldDef, value: FieldValue): StoredValue {
  switch (def.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new FieldValueError(def.id, "expects a number");
      return { num: value, text: null };
    case "text":
      if (typeof value !== "string") throw new FieldValueError(def.id, "expects text");
      return { num: null, text: value };
    case "date":
      if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) throw new FieldValueError(def.id, "expects a date as YYYY-MM-DD");
      return { num: null, text: value };
    case "select":
      if (typeof value !== "string" || !def.options.some((o) => o.id === value)) throw new FieldValueError(def.id, "expects one of the field's option ids");
      return { num: null, text: value };
    default:
      throw new FieldValueError(def.id, `${def.type} values are not stored here`);
  }
}
