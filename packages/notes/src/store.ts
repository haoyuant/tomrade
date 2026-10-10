import type { Db, Migration } from "@tomradex/db";
import { linkKey, type NoteLink, type ParsedNote } from "./syntax.js";

/**
 * A derived index over a project's files, rebuilt from them on any machine:
 * nothing here is exported, and losing it costs one reindex.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS plugin_notes_docs (
        id          INTEGER PRIMARY KEY,
        project_id  TEXT NOT NULL,
        path        TEXT NOT NULL,
        title       TEXT,
        size        INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        hash        TEXT NOT NULL,
        listed      INTEGER NOT NULL DEFAULT 1,
        UNIQUE (project_id, path)
      );
      CREATE TABLE IF NOT EXISTS plugin_notes_links (
        project_id TEXT NOT NULL,
        doc_id     INTEGER NOT NULL,
        target     TEXT NOT NULL,
        name_key   TEXT NOT NULL,
        anchor     TEXT,
        alias      TEXT,
        embed      INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        line       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plugin_notes_links_key ON plugin_notes_links (project_id, name_key);
      CREATE INDEX IF NOT EXISTS plugin_notes_links_doc ON plugin_notes_links (doc_id);
      CREATE TABLE IF NOT EXISTS plugin_notes_tags (
        project_id TEXT NOT NULL,
        doc_id     INTEGER NOT NULL,
        tag        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plugin_notes_tags_tag ON plugin_notes_tags (project_id, tag);
      CREATE INDEX IF NOT EXISTS plugin_notes_tags_doc ON plugin_notes_tags (doc_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS plugin_notes_fts USING fts5(project_id UNINDEXED, title, path, body, tokenize='trigram');
    `
  }
];

export const TABLES = {
  plugin_notes_docs: { project: "project_id", export: false },
  plugin_notes_links: { project: "project_id", export: false },
  plugin_notes_tags: { project: "project_id", export: false },
  plugin_notes_fts: { project: "project_id", export: false }
} as const;

export interface DocRow {
  id: number;
  path: string;
  title: string | null;
  size: number;
  modifiedAt: number;
  hash: string;
  listed: boolean;
}

export interface LinkRow {
  docId: number;
  source: string;
  target: string;
  anchor: string | null;
  alias: string | null;
  embed: boolean;
  kind: NoteLink["kind"];
  line: number;
}

/** What one reconcile changes: documents to (re)write and paths to forget. */
export interface IndexBatch {
  put: { path: string; size: number; modifiedAt: number; hash: string; listed: boolean; body: string | null; parsed: ParsedNote | null }[];
  drop: string[];
}

/** The last segment of a link's target, normalized: the one column a backlink lookup can index on. */
export const nameKey = (target: string): string => linkKey(target).split("/").pop() ?? "";

interface RawDoc {
  id: number;
  path: string;
  title: string | null;
  size: number;
  modified_at: number;
  hash: string;
  listed: number;
}

const docOf = (r: RawDoc): DocRow => ({ id: r.id, path: r.path, title: r.title, size: r.size, modifiedAt: r.modified_at, hash: r.hash, listed: r.listed === 1 });

export class NotesStore {
  constructor(private readonly pool: Db) {}

  docs(projectId: string): DocRow[] {
    return (this.pool.for(projectId).prepare("SELECT id, path, title, size, modified_at, hash, listed FROM plugin_notes_docs WHERE project_id = ?").all(projectId) as RawDoc[]).map(docOf);
  }

  doc(projectId: string, path: string): DocRow | null {
    const row = this.pool.for(projectId).prepare("SELECT id, path, title, size, modified_at, hash, listed FROM plugin_notes_docs WHERE project_id = ? AND path = ?").get(projectId, path) as RawDoc | undefined;
    return row ? docOf(row) : null;
  }

  body(projectId: string, docId: number): string {
    return (this.pool.for(projectId).prepare("SELECT body FROM plugin_notes_fts WHERE rowid = ?").get(docId) as { body: string } | undefined)?.body ?? "";
  }

  /** One transaction: a reader never sees a document without its links. */
  apply(projectId: string, batch: IndexBatch): void {
    const db = this.pool.for(projectId);
    const find = db.prepare("SELECT id FROM plugin_notes_docs WHERE project_id = ? AND path = ?");
    const forgetDoc = (id: number) => {
      db.prepare("DELETE FROM plugin_notes_links WHERE doc_id = ?").run(id);
      db.prepare("DELETE FROM plugin_notes_tags WHERE doc_id = ?").run(id);
      db.prepare("DELETE FROM plugin_notes_fts WHERE rowid = ?").run(id);
    };
    db.transaction(() => {
      for (const path of batch.drop) {
        const row = find.get(projectId, path) as { id: number } | undefined;
        if (!row) continue;
        forgetDoc(row.id);
        db.prepare("DELETE FROM plugin_notes_docs WHERE id = ?").run(row.id);
      }
      for (const doc of batch.put) {
        const existing = find.get(projectId, doc.path) as { id: number } | undefined;
        // Touched but not changed: a new stamp, nothing to reparse.
        if (existing && !doc.parsed) {
          db.prepare("UPDATE plugin_notes_docs SET size = ?, modified_at = ?, listed = ? WHERE id = ?").run(doc.size, doc.modifiedAt, doc.listed ? 1 : 0, existing.id);
          continue;
        }
        let id: number;
        if (existing) {
          id = existing.id;
          forgetDoc(id);
          db.prepare("UPDATE plugin_notes_docs SET title = ?, size = ?, modified_at = ?, hash = ?, listed = ? WHERE id = ?").run(doc.parsed?.title ?? null, doc.size, doc.modifiedAt, doc.hash, doc.listed ? 1 : 0, id);
        } else {
          id = Number(
            db.prepare("INSERT INTO plugin_notes_docs (project_id, path, title, size, modified_at, hash, listed) VALUES (?, ?, ?, ?, ?, ?, ?)").run(projectId, doc.path, doc.parsed?.title ?? null, doc.size, doc.modifiedAt, doc.hash, doc.listed ? 1 : 0).lastInsertRowid
          );
        }
        const parsed = doc.parsed!;
        db.prepare("INSERT INTO plugin_notes_fts (rowid, project_id, title, path, body) VALUES (?, ?, ?, ?, ?)").run(id, projectId, parsed.title ?? "", doc.path, doc.body ?? "");
        const link = db.prepare("INSERT INTO plugin_notes_links (project_id, doc_id, target, name_key, anchor, alias, embed, kind, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const l of parsed.links) if (l.target) link.run(projectId, id, l.target, nameKey(l.target), l.anchor, l.alias, l.embed ? 1 : 0, l.kind, l.line);
        const tag = db.prepare("INSERT INTO plugin_notes_tags (project_id, doc_id, tag) VALUES (?, ?, ?)");
        for (const t of parsed.tags) tag.run(projectId, id, t);
      }
    });
  }

  /** Links whose last segment could name `name` — the candidates a backlink is resolved from. */
  linksNamed(projectId: string, name: string): LinkRow[] {
    return (
      this.pool
        .for(projectId)
        .prepare(
          `SELECT l.doc_id, d.path AS source, l.target, l.anchor, l.alias, l.embed, l.kind, l.line
           FROM plugin_notes_links l JOIN plugin_notes_docs d ON d.id = l.doc_id
           WHERE l.project_id = ? AND l.name_key = ? ORDER BY d.path, l.line`
        )
        .all(projectId, name) as { doc_id: number; source: string; target: string; anchor: string | null; alias: string | null; embed: number; kind: string; line: number }[]
    ).map((r) => ({ docId: r.doc_id, source: r.source, target: r.target, anchor: r.anchor, alias: r.alias, embed: r.embed === 1, kind: r.kind as NoteLink["kind"], line: r.line }));
  }

  /** Every tag with how many documents carry it, the most used first. */
  tags(projectId: string): { tag: string; count: number }[] {
    return this.pool
      .for(projectId)
      .prepare("SELECT tag, COUNT(DISTINCT doc_id) AS count FROM plugin_notes_tags WHERE project_id = ? GROUP BY tag ORDER BY count DESC, tag ASC")
      .all(projectId) as { tag: string; count: number }[];
  }

  tagsOf(projectId: string, docIds: number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    if (!docIds.length) return out;
    const rows = this.pool
      .for(projectId)
      .prepare(`SELECT doc_id, tag FROM plugin_notes_tags WHERE doc_id IN (${docIds.map(() => "?").join(",")}) ORDER BY tag`)
      .all(...docIds) as { doc_id: number; tag: string }[];
    for (const r of rows) out.set(r.doc_id, [...(out.get(r.doc_id) ?? []), r.tag]);
    return out;
  }
}
