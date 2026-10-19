import type { ProjectDb } from "@tomradex/db";
import type { InputModality } from "./model.js";

const TABLE = "plugin_llm_refused_media";

// Machine-local, like the worker calls: what each profile's model turned down on this computer.
export const REFUSED_MEDIA_MIGRATION = {
  version: 2,
  up: `CREATE TABLE ${TABLE} (profile TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (profile, kind))`
};
export const REFUSED_MEDIA_TABLES = { [TABLE]: { export: false as const } };

/**
 * The media each profile's model refused, so it is not offered again. Kept for the model it was
 * refused by: a profile pointed at another model starts over.
 */
export class RefusedMedia {
  private rows = new Map<string, { model: string; kinds: Set<InputModality> }>();
  private db: ProjectDb | null = null;

  /** Reads what was kept; later refusals are written through. Null detaches. */
  attach(db: ProjectDb | null): void {
    this.db = db;
    if (!db) return;
    this.rows.clear();
    for (const row of db.prepare(`SELECT profile, model, kind FROM ${TABLE}`).all() as { profile: string; model: string; kind: InputModality }[]) {
      const kept = this.rows.get(row.profile);
      if (kept?.model === row.model) kept.kinds.add(row.kind);
      else this.rows.set(row.profile, { model: row.model, kinds: new Set([row.kind]) });
    }
  }

  of(profile: string, model: string): InputModality[] {
    const kept = this.rows.get(profile);
    return kept?.model === model ? [...kept.kinds] : [];
  }

  add(profile: string, model: string, kinds: InputModality[]): void {
    const kept = this.rows.get(profile);
    if (kept?.model !== model) this.forget(profile);
    const row = this.rows.get(profile) ?? { model, kinds: new Set<InputModality>() };
    this.rows.set(profile, row);
    for (const kind of kinds) {
      row.kinds.add(kind);
      this.db?.prepare(`INSERT INTO ${TABLE} (profile, model, kind, at) VALUES (?, ?, ?, ?) ON CONFLICT(profile, kind) DO UPDATE SET model = excluded.model, at = excluded.at`).run(profile, model, kind, Date.now());
    }
  }

  /** Drops what a profile that is gone, or now names another model, was refused. */
  keepFor(profiles: { id: string; model: string }[]): void {
    for (const [id, kept] of this.rows) if (!profiles.some((p) => p.id === id && p.model === kept.model)) this.forget(id);
  }

  private forget(profile: string): void {
    this.rows.delete(profile);
    this.db?.prepare(`DELETE FROM ${TABLE} WHERE profile = ?`).run(profile);
  }
}
