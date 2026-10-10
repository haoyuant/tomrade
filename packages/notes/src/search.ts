import type { Db } from "@tomradex/db";

export interface NoteSearchInput {
  /** Words in any order, `"quoted phrases"`, `#tags` and `path:folder`. */
  query: string;
  limit?: number;
  /** Only this folder (or file) of the store. */
  folder?: string;
  /** Leave out what the person keeps out of the agent index. */
  listedOnly?: boolean;
}

export interface NoteHit {
  path: string;
  title: string | null;
  /** 1-based line of the snippet; 0 when the hit is the title or the path alone. */
  line: number;
  snippet: string;
  /** Where the query's words sit inside `snippet`, as [start, end) offsets. */
  marks: [number, number][];
  tags: string[];
  modifiedAt: number;
}

export interface NoteSearchResult {
  hits: NoteHit[];
  /** Every match, beyond `limit`. */
  total: number;
  terms: string[];
  tags: string[];
}

export interface ParsedQuery {
  terms: string[];
  tags: string[];
  folder: string | null;
}

/** BM25 weights per column (project_id, title, path, body): a title says most about what a note is. */
const WEIGHTS = "0, 8, 4, 1";
const SNIPPET = 160;

/**
 * Words split on whitespace, except a double-quoted run (“also these”), which
 * is one term; `#tag` filters by tag, nested ones included; `path:` narrows to
 * a folder. The same reading items search gives its terms.
 */
export function parseQuery(query: string): ParsedQuery {
  const words: string[] = [];
  const closer: Record<string, string> = { '"': '"', "“": "”" };
  let i = 0;
  while (i < query.length) {
    const c = query[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const close = closer[c];
    if (close) {
      const end = query.indexOf(close, i + 1);
      const phrase = (end === -1 ? query.slice(i + 1) : query.slice(i + 1, end)).trim();
      if (phrase) words.push(`\u0000${phrase}`);
      i = end === -1 ? query.length : end + 1;
      continue;
    }
    let j = i;
    while (j < query.length && !/\s/.test(query[j]!)) j++;
    words.push(query.slice(i, j));
    i = j;
  }
  const out: ParsedQuery = { terms: [], tags: [], folder: null };
  for (const word of words) {
    if (word.startsWith("\u0000")) out.terms.push(word.slice(1));
    else if (/^#[^#\s]/.test(word)) out.tags.push(word.slice(1).replace(/\/+$/, "").toLowerCase());
    else if (/^(path|in):./i.test(word)) out.folder = word.replace(/^(path|in):/i, "").replace(/^\/+|\/+$/g, "");
    else out.terms.push(word);
  }
  return out;
}

interface Row {
  id: number;
  path: string;
  title: string | null;
  modified_at: number;
  body: string;
}

/** Full-text search over one project's index: trigram FTS5 ranked by BM25, short words through `instr`. */
export function searchNotes(pool: Db, projectId: string, input: NoteSearchInput): NoteSearchResult {
  const q = parseQuery(input.query);
  if (input.folder) q.folder = input.folder.replace(/^\/+|\/+$/g, "");
  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
  if (!q.terms.length && !q.tags.length && !q.folder) return { hits: [], total: 0, terms: [], tags: [] };
  // A trigram cannot see a word under three characters (two-character Chinese words among them).
  const indexed = q.terms.filter((t) => [...t].length >= 3);
  const short = q.terms.filter((t) => [...t].length < 3).map((t) => t.toLowerCase());
  const where: string[] = ["d.project_id = ?"];
  const params: unknown[] = [projectId];
  if (indexed.length) {
    where.push("plugin_notes_fts MATCH ?");
    params.push(indexed.map((t) => `"${t.replace(/"/g, '""')}"`).join(" "));
  }
  for (const s of short) {
    where.push("instr(lower(f.title || ' ' || f.path || ' ' || f.body), ?) > 0");
    params.push(s);
  }
  for (const tag of q.tags) {
    where.push("d.id IN (SELECT doc_id FROM plugin_notes_tags WHERE project_id = ? AND (tag = ? OR substr(tag, 1, length(?) + 1) = ? || '/'))");
    params.push(projectId, tag, tag, tag);
  }
  if (q.folder) {
    where.push("(d.path = ? OR substr(d.path, 1, length(?) + 1) = ? || '/')");
    params.push(q.folder, q.folder, q.folder);
  }
  if (input.listedOnly) where.push("d.listed = 1");
  const from = "FROM plugin_notes_fts f JOIN plugin_notes_docs d ON d.id = f.rowid";
  const titleHits = short.length ? `(${short.map(() => "(instr(lower(f.title || ' ' || f.path), ?) > 0)").join(" + ")}) DESC, ` : "";
  const order = indexed.length ? `bm25(plugin_notes_fts, ${WEIGHTS}) ASC` : `${titleHits}d.modified_at DESC`;
  const db = pool.for(projectId);
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${where.join(" AND ")}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT d.id, d.path, d.title, d.modified_at, f.body ${from} WHERE ${where.join(" AND ")} ORDER BY ${order}, d.path LIMIT ?`)
    .all(...params, ...(indexed.length ? [] : short), limit) as Row[];
  const tagRows = rows.length
    ? (db.prepare(`SELECT doc_id, tag FROM plugin_notes_tags WHERE doc_id IN (${rows.map(() => "?").join(",")}) ORDER BY tag`).all(...rows.map((r) => r.id)) as { doc_id: number; tag: string }[])
    : [];
  const tagsOf = new Map<number, string[]>();
  for (const r of tagRows) tagsOf.set(r.doc_id, [...(tagsOf.get(r.doc_id) ?? []), r.tag]);
  const marked = [...q.terms, ...q.tags.map((t) => `#${t}`)];
  const hits = rows.map((r) => ({ path: r.path, title: r.title, modifiedAt: r.modified_at, tags: tagsOf.get(r.id) ?? [], ...snippetOf(r.body, marked) }));
  return { hits, total, terms: q.terms, tags: q.tags };
}

/** The line that holds the most of the query's words, cut around the first of them, with each word marked. */
export function snippetOf(body: string, terms: string[]): { line: number; snippet: string; marks: [number, number][] } {
  const lower = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const lines = body.split(/\r?\n/);
  // Front matter is bookkeeping, not what a note says.
  let first = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) first = end + 1;
  }
  let best = -1;
  let bestScore = 0;
  for (let i = first; i < lines.length && bestScore < lower.length; i++) {
    const text = lines[i]!.toLowerCase();
    const score = lower.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  let line = best;
  if (line < 0) for (let i = first; i < lines.length && line < 0; i++) if (lines[i]!.trim()) line = i;
  if (line < 0) return { line: 0, snippet: "", marks: [] };
  const raw = lines[line]!.replace(/\s+/g, " ").trim();
  let start = 0;
  if (raw.length > SNIPPET && best >= 0) {
    const first = Math.min(...lower.map((t) => raw.toLowerCase().indexOf(t)).filter((n) => n >= 0));
    start = Math.max(0, Math.min(first - 40, raw.length - SNIPPET));
  }
  const cut = raw.slice(start, start + SNIPPET);
  const snippet = `${start > 0 ? "…" : ""}${cut}${start + SNIPPET < raw.length ? "…" : ""}`;
  const offset = start > 0 ? 1 : 0;
  const marks: [number, number][] = [];
  const hay = cut.toLowerCase();
  for (const t of lower) {
    for (let at = hay.indexOf(t); at >= 0; at = hay.indexOf(t, at + t.length)) marks.push([at + offset, at + offset + t.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([...m]);
  }
  return { line: best >= 0 ? line + 1 : 0, snippet, marks: merged };
}
