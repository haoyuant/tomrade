import type { Context } from "cordis";
import { z } from "zod";
import type { AppSettings, Author, UndoRecord, UndoRunResult } from "@tomradex/domain";
import type { Db, Migration } from "@tomradex/db";
import type {} from "@tomradex/hub";
import type { RunChange, UndoProvider } from "@tomradex/oplog";
import { defineTool, type ToolInvocation } from "@tomradex/tools";
import type { Settings, SettingsSection } from "./index.js";
import { mapSecrets } from "./secrets.js";

/**
 * Tomrade's own settings as agent tools. What a section allows is its own
 * declaration (`agent`), and a change an agent makes lands in the project's
 * history like any other: ⌘Z, the History window and the run's Undo take it
 * back, unless the setting has moved on since.
 */

const PROVIDER = "settings";
const HIDDEN = "[hidden]";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Secrets never reach a model. */
export const redact = (value: unknown, key = ""): unknown => mapSecrets(value, (v) => (v === "" ? v : HIDDEN), key);

/** A redacted value sent back unchanged keeps what it stood for. */
function unredact(next: unknown, current: unknown): unknown {
  if (next === HIDDEN) return current;
  if (Array.isArray(next) && Array.isArray(current)) return next.map((v, i) => unredact(v, current[i]));
  if (isRecord(next) && isRecord(current)) return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, unredact(v, current[k])]));
  return next;
}

/** One line per value, for the run's list and the history window. */
const brief = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

function describe(before: unknown, after: unknown): string {
  if (!isRecord(before) || !isRecord(after)) return `${brief(before)} → ${brief(after)}`;
  const keys = Object.keys(after).filter((k) => !same(before[k], after[k]));
  return keys.map((k) => `${k} → ${brief(after[k])}`).join(", ");
}

// ── the record of what agents changed ──────────────────────────────────────

const MIGRATIONS: Migration[] = [
  {
    // Machine-local like the files' undo stack: settings belong to this machine or its person, not to the project.
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS plugin_settings_changes (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL,
      at          INTEGER NOT NULL,
      by          TEXT NOT NULL,
      run_id      TEXT,
      before_json TEXT NOT NULL,
      after_json  TEXT NOT NULL,
      undone_at   INTEGER
    )`
  }
];

const TABLES = { plugin_settings_changes: { project: "project_id", export: false } } as const;

interface ChangeRow {
  seq: number;
  at: number;
  by: Author;
  runId: string | null;
  /** Section id → value, for every section the call changed. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  undoneAt: number | null;
}

interface RawChange {
  seq: number;
  at: number;
  by: string;
  run_id: string | null;
  before_json: string;
  after_json: string;
  undone_at: number | null;
}

const rowOf = (r: RawChange): ChangeRow => ({
  seq: r.seq,
  at: r.at,
  by: r.by as Author,
  runId: r.run_id,
  before: JSON.parse(r.before_json) as Record<string, unknown>,
  after: JSON.parse(r.after_json) as Record<string, unknown>,
  undoneAt: r.undone_at
});

class Changes {
  constructor(private readonly db: Db) {}

  record(projectId: string, row: Omit<ChangeRow, "seq" | "undoneAt">): void {
    this.db.for(projectId)
      .prepare("INSERT INTO plugin_settings_changes (project_id, at, by, run_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(projectId, row.at, row.by, row.runId, JSON.stringify(row.before), JSON.stringify(row.after));
  }

  get(projectId: string, seq: number): ChangeRow | null {
    const r = this.db.for(projectId).prepare("SELECT * FROM plugin_settings_changes WHERE project_id = ? AND seq = ?").get(projectId, seq) as RawChange | undefined;
    return r ? rowOf(r) : null;
  }

  list(projectId: string, limit: number): ChangeRow[] {
    return (this.db.for(projectId).prepare("SELECT * FROM plugin_settings_changes WHERE project_id = ? ORDER BY seq DESC LIMIT ?").all(projectId, limit) as RawChange[]).map(rowOf);
  }

  ofRun(projectId: string, runId: string): ChangeRow[] {
    return (this.db.for(projectId).prepare("SELECT * FROM plugin_settings_changes WHERE project_id = ? AND run_id = ? ORDER BY seq DESC").all(projectId, runId) as RawChange[]).map(rowOf);
  }

  markUndone(projectId: string, seq: number, at: number | null): void {
    this.db.for(projectId).prepare("UPDATE plugin_settings_changes SET undone_at = ? WHERE project_id = ? AND seq = ?").run(at, projectId, seq);
  }

  forget(projectId: string): void {
    this.db.for(projectId).prepare("DELETE FROM plugin_settings_changes WHERE project_id = ? AND undone_at IS NOT NULL").run(projectId);
  }
}

// ── tools and history ──────────────────────────────────────────────────────

const GetSettings = z.object({
  section: z.string().optional().describe("One section's id, to get its schema too. Omit for every section with its current value.")
});

const UpdateSettings = z.object({
  changes: z.record(z.string(), z.unknown()).describe("Section id → new value. An object section takes only the fields that change; any other section takes its whole new value.")
});

export function agentAccess(ctx: Context): void {
  const settings = ctx.settings as Settings;
  ctx.db.migrate("settings", MIGRATIONS, { tables: TABLES });
  const changes = new Changes(ctx.db);
  const titleOf = (id: string) => settings.section(id)?.title ?? id;
  const labelOf = (row: ChangeRow) => Object.keys(row.after).map(titleOf).join(", ");
  const current = () => settings.get() as unknown as Record<string, unknown>;

  /** Puts `to` back, if every section still reads `from`. */
  const restore = (row: ChangeRow, from: Record<string, unknown>, to: Record<string, unknown>) => {
    const now = current();
    const moved = Object.keys(from).filter((id) => !same(now[id], from[id]));
    if (moved.length) throw new Error(`${moved.map(titleOf).join(", ")} changed again since — leaving ${moved.length === 1 ? "it" : "them"} as ${moved.length === 1 ? "it is" : "they are"}`);
    settings.set(to as unknown as AppSettings);
  };

  const view = (section: SettingsSection, withSchema: boolean) => {
    const access = settings.accessOf(section);
    return {
      id: section.id,
      title: section.title,
      ...(section.description ? { description: section.description } : {}),
      access,
      ...(access === "none" ? {} : { value: redact(current()[section.id]) }),
      ...(withSchema && access !== "none" ? { schema: z.toJSONSchema(section.schema) } : {})
    };
  };

  ctx.tools.register(defineTool({
    name: "get_settings",
    title: "Read Tomrade's settings",
    description: "Tomrade's own settings — appearance, language, the pet, notes and more — with each section's current value and whether you may change it (access: write, read or none). Secrets come back as [hidden].",
    input: GetSettings,
    execute: ({ section }) => {
      if (!section) return { sections: settings.sections().map((s) => view(settings.section(s.id)!, false)) };
      const found = settings.section(section);
      if (!found) throw new Error(`No settings section "${section}" — call get_settings without one to list them`);
      return view(found, true);
    }
  }));

  ctx.tools.register(defineTool({
    name: "update_settings",
    title: "Change Tomrade's settings",
    description: "Change Tomrade's own settings, only when the user asks you to. Sections whose access is write can change (get_settings says which and what they take); the rest are the user's to change in Settings. The change shows at once and can be undone like any other.",
    input: UpdateSettings,
    execute: ({ changes: requested }, invocation: ToolInvocation) => {
      const ids = Object.keys(requested);
      if (!ids.length) throw new Error("changes is empty — name at least one section");
      const now = current();
      const next: Record<string, unknown> = {};
      for (const id of ids) {
        const section = settings.section(id);
        if (!section) throw new Error(`No settings section "${id}" — get_settings lists them`);
        if (settings.accessOf(section) !== "write") throw new Error(`${section.title} is the user's to change, in Settings › ${section.title}. Tell them so; do not retry`);
        const value = unredact(requested[id], now[id]);
        const parsed = section.schema.safeParse(isRecord(now[id]) && isRecord(value) ? { ...now[id], ...value } : value);
        if (!parsed.success) {
          const issue = parsed.error.issues[0]!;
          throw new Error(`${[id, ...issue.path].join(".")}: ${issue.message} — get_settings with section "${id}" has its schema`);
        }
        next[id] = parsed.data;
      }
      const changed = ids.filter((id) => !same(now[id], next[id]));
      if (!changed.length) return { changed: [], note: "Already set that way." };
      settings.set(Object.fromEntries(changed.map((id) => [id, next[id]])) as unknown as AppSettings);
      const after = current();
      const before = Object.fromEntries(changed.map((id) => [id, now[id]]));
      const landed = Object.fromEntries(changed.map((id) => [id, after[id]]));
      if (invocation.projectId && ctx.db.has(invocation.projectId)) {
        changes.record(invocation.projectId, { at: Date.now(), by: invocation.by, runId: invocation.run?.id ?? null, before, after: landed });
        ctx.oplog.forgetUndone(invocation.projectId);
      }
      return { changed: changed.map((id) => ({ section: id, title: titleOf(id), before: redact(before[id]), after: redact(landed[id]) })) };
    }
  }));

  const recordOf = (row: ChangeRow): UndoRecord => ({
    ref: `${PROVIDER}:${row.seq}`,
    provider: PROVIDER,
    id: String(row.seq),
    entity: "setting",
    entityId: Object.keys(row.after).join(","),
    op: "set",
    label: labelOf(row),
    target: null,
    by: row.by,
    at: row.at,
    runId: row.runId,
    device: ctx.hub.deviceId,
    undoable: true,
    undoneAt: row.undoneAt
  });

  const undo = (projectId: string, row: ChangeRow): string => {
    if (row.undoneAt !== null) throw new Error("That settings change is already undone");
    restore(row, row.after, row.before);
    changes.markUndone(projectId, row.seq, Date.now());
    return `Put ${labelOf(row)} back`;
  };

  const provider: UndoProvider = {
    id: PROVIDER,
    timeline: (projectId, limit) => (ctx.db.has(projectId) ? changes.list(projectId, limit).map(recordOf) : []),
    undo: (projectId, id) => {
      const row = changes.get(projectId, Number(id));
      if (!row) throw new Error("That settings change is no longer in the history");
      return undo(projectId, row);
    },
    redo: (projectId, id) => {
      const row = changes.get(projectId, Number(id));
      if (!row) throw new Error("That settings change is no longer in the history");
      if (row.undoneAt === null) throw new Error("That settings change is not undone");
      restore(row, row.before, row.after);
      changes.markUndone(projectId, row.seq, null);
      return `Changed ${labelOf(row)} again`;
    },
    forget: (projectId) => {
      if (ctx.db.has(projectId)) changes.forget(projectId);
    },
    runChanges: (projectId, runId): RunChange[] =>
      ctx.db.has(projectId)
        ? changes.ofRun(projectId, runId).reverse().flatMap((row) => Object.keys(row.after).map((id) => ({ key: titleOf(id), label: describe(row.before[id], row.after[id]), op: "updated" as const })))
        : [],
    undoRun: (projectId, runId): UndoRunResult => {
      const result: UndoRunResult = { reverted: 0, kept: [] };
      if (!ctx.db.has(projectId)) return result;
      for (const row of changes.ofRun(projectId, runId)) {
        if (row.undoneAt !== null) continue;
        try {
          undo(projectId, row);
          result.reverted += Object.keys(row.after).length;
        } catch (error) {
          result.kept.push({ entity: "setting", entityId: Object.keys(row.after).join(","), label: labelOf(row), reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return result;
    }
  };
  ctx.oplog.provide(provider);
}
