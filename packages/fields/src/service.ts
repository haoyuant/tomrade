import { randomUUID } from "node:crypto";
import { Context, Service } from "cordis";
import type { ProjectDb } from "@tomradex/db";
import {
  BUILTIN_FIELDS,
  CHECKED,
  CUSTOM_FIELD_TYPES,
  FieldDefinitionError,
  FieldValueError,
  NotFoundError,
  isBuiltinFieldId,
  wordsLocale,
  type FieldDef,
  type FieldOption,
  type FieldType,
  type FieldValue
} from "@tomradex/domain";
import { registerChannels, registerTools } from "./contributions.js";
import { errorMessage } from "@tomradex/contracts";

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

/**
 * A read-only number a plugin computes from its own tables in the project's
 * file. Both SQL strings run against that file: `values` lists every item that
 * has one, `expr` is the value for the item aliased `i` in a view query — the
 * two must agree, as the renderer sorts on the first and the items service on
 * the second.
 */
export interface DerivedField {
  id: string;
  /** English; `names` may say it in the person's language. */
  name: string;
  names?: Partial<Record<"en" | "zh", string>>;
  unit?: "usd";
  /** `SELECT item_id, value …` — one row per item with a value. */
  values: string;
  /** A scalar subquery over `i`, e.g. `SELECT SUM(x) FROM t WHERE t.item_id = i.id`. */
  expr: string;
}

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

  private derivedFields = new Map<string, DerivedField>();

  constructor(ctx: Context) {
    super(ctx, "fields");
  }

  /** Reversible: the field leaves every list, view and query with the plugin that computes it. */
  derive(field: DerivedField): () => void {
    if (isBuiltinFieldId(field.id) || this.derivedFields.has(field.id)) throw new FieldDefinitionError(field.id, "that field id is taken");
    return this.ctx.effect(() => {
      this.derivedFields.set(field.id, field);
      return () => this.derivedFields.delete(field.id);
    }, `fields.derive(${field.id})`);
  }

  derived(): FieldDef[] {
    const locale = wordsLocale((this.ctx.get("settings") as { locale?: () => string } | undefined)?.locale?.());
    return [...this.derivedFields.values()].map((f, n) => ({
      id: f.id,
      projectId: null,
      name: f.names?.[locale] ?? f.name,
      type: "number" as const,
      builtin: true,
      options: [],
      readonly: true,
      can: { filter: true, sort: true, group: false },
      rank: BUILTIN_FIELDS.length + n,
      derived: true,
      ...(f.unit ? { unit: f.unit } : {})
    }));
  }

  /** The scalar SQL for each derived field, for the items service's query compiler. */
  derivedSql(): Map<string, string> {
    return new Map([...this.derivedFields.values()].map((f) => [f.id, f.expr]));
  }

  /** Each item's derived values, by item id. A field whose SQL fails is left out rather than failing the read. */
  derivedValues(projectId: string): Map<string, Record<string, number>> {
    const out = new Map<string, Record<string, number>>();
    if (!this.derivedFields.size || !this.ctx.db.has(projectId)) return out;
    const db = this.ctx.db.for(projectId);
    for (const f of this.derivedFields.values()) {
      let rows: { item_id: string; value: number | null }[];
      try {
        rows = db.prepare(f.values).all() as { item_id: string; value: number | null }[];
      } catch (err) {
        this.ctx.logger.warn(`derived field ${f.id}: ${errorMessage(err)}`);
        continue;
      }
      for (const r of rows) {
        if (r.value === null || !Number.isFinite(r.value)) continue;
        const values = out.get(r.item_id) ?? {};
        values[f.id] = r.value;
        out.set(r.item_id, values);
      }
    }
    return out;
  }

  [Service.init]() {
    this.ctx.inject(["tools"], registerTools);
    this.ctx.inject(["ipc"], registerChannels);
  }

  /** Resolved per call; a project that is not open on this machine has no fields to speak of. */
  private db(projectId: string): ProjectDb {
    if (!this.ctx.db.has(projectId)) throw new NotFoundError(projectId);
    return this.ctx.db.for(projectId);
  }

  /** Built-ins first, then the project's own, each in its rank order. */
  list(projectId: string): FieldDef[] {
    return [...BUILTIN_FIELDS, ...this.derived(), ...this.custom(projectId)];
  }

  custom(projectId: string): FieldDef[] {
    if (!this.ctx.db.has(projectId)) return [];
    const db = this.ctx.db.for(projectId);
    const rows = db.prepare("SELECT * FROM fields WHERE project_id = ? ORDER BY rank ASC, created_at ASC").all(projectId) as FieldRow[];
    if (!rows.length) return [];
    const placeholders = rows.map(() => "?").join(",");
    const options = db.prepare(`SELECT * FROM field_options WHERE field_id IN (${placeholders}) ORDER BY rank ASC`).all(...rows.map((r) => r.id)) as OptionRow[];
    return rows.map((r) => this.toDef(r, options.filter((o) => o.field_id === r.id)));
  }

  get(projectId: string, id: string): FieldDef | null {
    const builtin = BUILTIN_FIELDS.find((f) => f.id === id) ?? this.derived().find((f) => f.id === id);
    if (builtin) return builtin;
    if (!this.ctx.db.has(projectId)) return null;
    const db = this.ctx.db.for(projectId);
    const row = db.prepare("SELECT * FROM fields WHERE id = ?").get(id) as FieldRow | undefined;
    if (!row) return null;
    return this.toDef(row, db.prepare("SELECT * FROM field_options WHERE field_id = ? ORDER BY rank ASC").all(id) as OptionRow[]);
  }

  create(input: CreateFieldInput): FieldDef {
    if (!CUSTOM_FIELD_TYPES.includes(input.type)) throw new FieldDefinitionError(input.name, `type ${input.type} cannot be created`);
    const name = input.name.trim();
    if (!name) throw new FieldDefinitionError(input.name, "a field needs a name");
    const db = this.db(input.projectId);
    this.assertNameFree(db, input.projectId, name);
    const now = Date.now();
    const id = randomUUID();
    const rank = input.rank ?? ((db.prepare("SELECT MAX(rank) AS m FROM fields WHERE project_id = ?").get(input.projectId) as { m: number | null }).m ?? -1) + 1;
    db.transaction(() => {
      db.prepare("INSERT INTO fields (id, project_id, name, type, rank, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.projectId, name, input.type, rank, now, now);
      (input.options ?? []).forEach((o, i) => this.insertOption(db, id, o, i));
    });
    return this.get(input.projectId, id)!;
  }

  update(projectId: string, id: string, patch: FieldPatch): FieldDef {
    const db = this.db(projectId);
    const existing = this.customRow(db, id);
    const name = patch.name?.trim() ?? existing.name;
    if (!name) throw new FieldDefinitionError(id, "a field needs a name");
    if (name !== existing.name) this.assertNameFree(db, existing.project_id, name);
    db.prepare("UPDATE fields SET name = ?, rank = ?, updated_at = ? WHERE id = ?").run(name, patch.rank ?? existing.rank, Date.now(), id);
    return this.get(projectId, id)!;
  }

  /** Takes every value with it. The caller confirms; there is no undo for schema. */
  remove(projectId: string, id: string): void {
    const db = this.db(projectId);
    this.customRow(db, id);
    db.transaction(() => {
      db.prepare("DELETE FROM item_values WHERE field_id = ?").run(id);
      db.prepare("DELETE FROM field_options WHERE field_id = ?").run(id);
      db.prepare("DELETE FROM fields WHERE id = ?").run(id);
    });
  }

  addOption(projectId: string, fieldId: string, input: FieldOptionInput): FieldOption {
    const db = this.db(projectId);
    const field = this.customRow(db, fieldId);
    if (field.type !== "select") throw new FieldDefinitionError(fieldId, "only a select has options");
    const rank = ((db.prepare("SELECT MAX(rank) AS m FROM field_options WHERE field_id = ?").get(fieldId) as { m: number | null }).m ?? -1) + 1;
    const id = this.insertOption(db, fieldId, input, rank);
    this.touch(db, fieldId);
    return rowToOption(db.prepare("SELECT * FROM field_options WHERE id = ?").get(id) as OptionRow);
  }

  updateOption(projectId: string, fieldId: string, optionId: string, patch: FieldOptionPatch): FieldOption {
    const db = this.db(projectId);
    const existing = this.optionRow(db, fieldId, optionId);
    const name = patch.name?.trim() ?? existing.name;
    if (!name) throw new FieldDefinitionError(fieldId, "an option needs a name");
    db.prepare("UPDATE field_options SET name = ?, description = ?, rank = ? WHERE id = ?").run(name, patch.description === undefined ? existing.description : patch.description, patch.rank ?? existing.rank, optionId);
    this.touch(db, fieldId);
    return rowToOption(db.prepare("SELECT * FROM field_options WHERE id = ?").get(optionId) as OptionRow);
  }

  /** Items holding the option are moved to `moveTo` or cleared. Returns how many were touched. */
  removeOption(projectId: string, fieldId: string, optionId: string, opts: { moveTo?: string } = {}): number {
    const db = this.db(projectId);
    this.optionRow(db, fieldId, optionId);
    if (opts.moveTo) this.optionRow(db, fieldId, opts.moveTo);
    return db.transaction(() => {
      const touched = opts.moveTo
        ? db.prepare("UPDATE item_values SET text = ? WHERE field_id = ? AND text = ?").run(opts.moveTo, fieldId, optionId).changes
        : db.prepare("DELETE FROM item_values WHERE field_id = ? AND text = ?").run(fieldId, optionId).changes;
      db.prepare("DELETE FROM field_options WHERE id = ?").run(optionId);
      this.touch(db, fieldId);
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
      if (this.derivedFields.has(fieldId)) throw new FieldValueError(fieldId, "a derived field is computed, never written");
      const def = defs.get(fieldId);
      if (!def) throw new FieldValueError(fieldId, "no such field in this project");
      // An unticked checkbox is the absence of a value, not a stored zero.
      const cleared = value === null || (def.type === "checkbox" && (value === 0 || value === "" || value === "false"));
      out.set(fieldId, cleared ? null : storedValue(def, value));
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
      can: { filter: true, sort: type !== "checkbox", group: type === "select" || type === "checkbox" },
      rank: r.rank
    };
  }

  private customRow(db: ProjectDb, id: string): FieldRow {
    if (isBuiltinFieldId(id) || this.derivedFields.has(id)) throw new FieldDefinitionError(id, "built-in fields cannot be changed");
    const row = db.prepare("SELECT * FROM fields WHERE id = ?").get(id) as FieldRow | undefined;
    if (!row) throw new NotFoundError(id);
    return row;
  }

  private optionRow(db: ProjectDb, fieldId: string, optionId: string): OptionRow {
    this.customRow(db, fieldId);
    const row = db.prepare("SELECT * FROM field_options WHERE id = ? AND field_id = ?").get(optionId, fieldId) as OptionRow | undefined;
    if (!row) throw new NotFoundError(optionId);
    return row;
  }

  private insertOption(db: ProjectDb, fieldId: string, input: FieldOptionInput, rank: number): string {
    const name = input.name.trim();
    if (!name) throw new FieldDefinitionError(fieldId, "an option needs a name");
    const id = randomUUID();
    db.prepare("INSERT INTO field_options (id, field_id, name, description, rank) VALUES (?, ?, ?, ?, ?)").run(id, fieldId, name, input.description ?? null, rank);
    return id;
  }

  /** A field's name is its identity in a filter bar, so two cannot share one; built-in names are taken too. */
  private assertNameFree(db: ProjectDb, projectId: string, name: string): void {
    const lower = name.toLowerCase();
    const taken = [...BUILTIN_FIELDS.map((f) => f.name), ...[...this.derivedFields.values()].flatMap((f) => [f.name, ...Object.values(f.names ?? {})])];
    if (taken.some((n) => n.toLowerCase() === lower)) throw new FieldDefinitionError(name, `"${name}" is a built-in field`);
    const clash = db.prepare("SELECT 1 FROM fields WHERE project_id = ? AND lower(name) = ?").get(projectId, lower);
    if (clash) throw new FieldDefinitionError(name, `a field named "${name}" already exists`);
  }

  private touch(db: ProjectDb, fieldId: string): void {
    db.prepare("UPDATE fields SET updated_at = ? WHERE id = ?").run(Date.now(), fieldId);
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
    case "checkbox":
      if (value !== CHECKED && value !== "true") throw new FieldValueError(def.id, "expects 1 (ticked) or null (unticked)");
      return { num: CHECKED, text: null };
    default:
      throw new FieldValueError(def.id, `${def.type} values are not stored here`);
  }
}
