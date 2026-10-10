/**
 * Opt-in benchmark of title/body search with the FTS5 index against the code
 * path it replaced (every row fetched, `includes()` in JS) and a no-index SQL
 * middle ground, over the labelled dataset in fixtures/search-dataset.ts.
 * Reports storage and write cost, query latency, result payload and accuracy
 * per query category, with and without a limit, at each size.
 * `pnpm bench:search`; TOMRADE_BENCH_SIZES=1000,10000 TOMRADE_BENCH_SEED=42
 * TOMRADE_BENCH_LIMITS=20,10 TOMRADE_BENCH_RUNS=3 TOMRADE_BENCH_OUTPUT=dir;
 * TOMRADE_BENCH_WEIGHTS=1,10 adds FTS engines with other BM25 title weights.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { it } from "vitest";
import type { ProjectDb } from "@tomradex/db";
import { fresh } from "@tomradex/testkit";
import { compileSearch } from "../src/query.js";
import { generateDataset, type BenchItem, type BenchQuery, type Category, type Variant } from "./fixtures/search-dataset.js";
import { limitLabel, renderMarkdown, type Agg, type BenchReport, type SizeReport } from "./fixtures/search-bench-report.js";
import { renderHtml } from "./fixtures/search-bench-html.js";

const SELECT_ITEM = "SELECT i.*, COALESCE(p.key_prefix, 'TOM') AS key_prefix FROM items i LEFT JOIN projects p ON p.id = i.project_id";
const ORDER = "i.rank ASC, i.updated_at DESC";

interface Row {
  id: string;
  project_id: string;
  board_id: string;
  key_num: number;
  title: string;
  body: string | null;
  kind: string;
  work_type: string;
  status: string;
  priority: number;
  rank: number;
  updated_at: number;
  updated_by: string;
  version: number;
}

interface Engine {
  id: string;
  label: string;
  /** Raw SQL over the rows; these are the engines scored for accuracy. */
  raw?: boolean;
  /** Result keys in the order the tool would return them, plus the payload the tool would serialize. */
  run(q: string, limit?: number): { keys: number[]; payload: string };
}

const EMPTY_EVIDENCE = { resources: [], submissions: [], reviews: [] };

/** What list_items serializes for a row the raw engines fetched: the Item shape with nothing attached. */
function toolShape(r: Row): object {
  return {
    evidence: EMPTY_EVIDENCE,
    id: r.id,
    projectId: r.project_id,
    boardId: r.board_id,
    keyNum: r.key_num,
    key: `TOM-${r.key_num}`,
    title: r.title,
    body: r.body,
    kind: r.kind,
    workType: r.work_type,
    playbookId: null,
    status: r.status,
    priority: r.priority,
    parentId: null,
    rank: r.rank,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    version: r.version,
    humanLocked: false,
    labels: [],
    blocks: [],
    blockedBy: [],
    fields: {}
  };
}

const includesQuery = (q: string) => {
  const s = q.trim().toLowerCase();
  return (title: string, body: string | null) => !s || title.toLowerCase().includes(s) || (body ?? "").toLowerCase().includes(s);
};
const cut = <T>(xs: T[], limit?: number) => (limit === undefined ? xs : xs.slice(0, limit));
const limitSql = (limit?: number) => (limit === undefined ? "" : " LIMIT ?");
const limitParams = (limit?: number) => (limit === undefined ? [] : [limit]);

function rawEngines(db: ProjectDb, pid: string, ftsDb: ProjectDb, ftsPid: string, base: number, weights: number[]): Engine[] {
  const out = (rows: Row[]) => ({ keys: rows.map((r) => r.key_num - base), payload: JSON.stringify(rows.map(toolShape)) });
  const fts = (search: string, limit?: number, weight?: number) => {
    const s = compileSearch(search);
    const joins = weight === undefined ? s.joins : s.joins.map((j) => j.replace(/bm25\(items_fts, [\d.]+, 1\)/, `bm25(items_fts, ${weight}, 1)`));
    const sql = `${SELECT_ITEM} ${joins.join(" ")} WHERE i.project_id = ?${s.where.length ? " AND " + s.where.join(" AND ") : ""} ORDER BY ${[...s.orderBy, ORDER].join(", ")}${limitSql(limit)}`;
    return out(ftsDb.prepare(sql).all(...s.joinParams, ftsPid, ...s.whereParams, ...s.orderParams, ...limitParams(limit)) as Row[]);
  };
  return [
    {
      id: "grep",
      label: "grep-js (main: fetch all, includes)",
      raw: true,
      run(q, limit) {
        // The old path has no LIMIT to push down: it must read every row before it can cut.
        const rows = db.prepare(`${SELECT_ITEM} WHERE i.project_id = ? ORDER BY ${ORDER}`).all(pid) as Row[];
        const ok = includesQuery(q);
        return out(cut(rows.filter((r) => ok(r.title, r.body)), limit));
      }
    },
    {
      id: "instr",
      label: "instr-sql (no index, every word)",
      raw: true,
      run(q, limit) {
        const words = q.trim().split(/\s+/).filter(Boolean);
        const where = words.map(() => "instr(lower(i.title || ' ' || coalesce(i.body, '')), ?) > 0");
        const sql = `${SELECT_ITEM} WHERE i.project_id = ?${where.length ? " AND " + where.join(" AND ") : ""} ORDER BY ${ORDER}${limitSql(limit)}`;
        return out(db.prepare(sql).all(pid, ...words.map((w) => w.toLowerCase()), ...limitParams(limit)) as Row[]);
      }
    },
    { id: "fts", label: "fts5 trigram + BM25 (this branch)", raw: true, run: (q, limit) => fts(q, limit) },
    // grep's semantics on the index: the whole query as one contiguous term, still ranked.
    { id: "phrase", label: "fts5 phrase (whole query quoted)", raw: true, run: (q, limit) => fts(`"${q.trim().replace(/["\u201c\u201d]/g, "")}"`, limit) },
    ...weights.map((w) => ({ id: `fts-w${w}`, label: `fts5 with BM25 title weight ${w}`, raw: true, run: (q: string, limit?: number) => fts(q, limit, w) }))
  ];
}

type ItemsService = Awaited<ReturnType<typeof fresh>>["items"];

function serviceEngines(offItems: ItemsService, offPid: string, onItems: ItemsService, onPid: string, base: number): Engine[] {
  return [
    {
      id: "svc-old",
      label: "items.list() then includes (old list_items)",
      run(q, limit) {
        const rows = offItems.list({ projectId: offPid });
        const ok = includesQuery(q);
        const hits = cut(rows.filter((i) => ok(i.title, i.body)), limit);
        return { keys: hits.map((i) => i.keyNum - base), payload: JSON.stringify(hits) };
      }
    },
    {
      id: "svc-new",
      label: "items.list({ search, limit }) (new list_items)",
      run(q, limit) {
        const hits = onItems.list({ projectId: onPid, search: q, limit });
        return { keys: hits.map((i) => i.keyNum - base), payload: JSON.stringify(hits) };
      }
    }
  ];
}

/** Roughly what a tokenizer charges: a CJK character is a token, four other bytes are one. */
function estTokens(s: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
    else other += Buffer.byteLength(ch);
  }
  return Math.round(cjk + other / 4);
}

interface QueryResult {
  query: BenchQuery;
  keys: number[];
  recall: number;
  precision: number | null;
  rr: number;
  r5: number;
  tokens: number;
  tokensToFirstHit: number | null;
}

function score(query: BenchQuery, keys: number[], payloadParts: number[]): QueryResult {
  const rel = new Set(query.relevant);
  const tp = keys.filter((k) => rel.has(k)).length;
  const first = keys.findIndex((k) => rel.has(k));
  const top5 = keys.slice(0, 5).filter((k) => rel.has(k)).length;
  return {
    query,
    keys,
    recall: query.relevant.length ? tp / query.relevant.length : 1,
    precision: keys.length ? tp / keys.length : null,
    rr: first >= 0 ? 1 / (first + 1) : 0,
    r5: query.relevant.length ? top5 / Math.min(5, query.relevant.length) : 1,
    tokens: payloadParts.reduce((a, b) => a + b, 0),
    tokensToFirstHit: first >= 0 ? payloadParts.slice(0, first + 1).reduce((a, b) => a + b, 0) : null
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const quantile = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

function aggregate(rows: QueryResult[]): Agg {
  const withHits = rows.filter((r) => r.keys.length > 0);
  return {
    queries: rows.length,
    recall: mean(rows.map((r) => r.recall)),
    precision: mean(withHits.map((r) => r.precision!)),
    noHit: rows.length - withHits.length,
    mrr: mean(rows.map((r) => r.rr)),
    r5: mean(rows.map((r) => r.r5)),
    results: mean(rows.map((r) => r.keys.length)),
    tokens: mean(rows.map((r) => r.tokens)),
    tokensToFirstHit: mean(rows.filter((r) => r.tokensToFirstHit !== null).map((r) => r.tokensToFirstHit!))
  };
}

function timed<T>(fn: () => T): { result: T; ms: number } {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}

function seedRows(db: ProjectDb, pid: string, boardId: string, items: BenchItem[], base: number): number {
  const stmt = db.prepare(
    "INSERT INTO items (id, project_id, board_id, key_num, title, body, kind, work_type, status, priority, rank, updated_at, updated_by, version) VALUES (?, ?, ?, ?, ?, ?, 'ticket', 'coding', ?, ?, ?, ?, 'human', 1)"
  );
  const statuses = ["backlog", "todo", "doing", "done"];
  const now = Date.now();
  const year = 365 * 24 * 3600 * 1000;
  const { ms } = timed(() =>
    db.transaction(() => {
      for (const it of items) {
        // Recency and rank carry no relevance signal, as in a real backlog.
        const updatedAt = now - ((it.key * 7919) % year);
        stmt.run(randomUUID(), pid, boardId, base + it.key, it.title, it.body, statuses[it.key % 4], 1 + (it.key % 3), it.key, updatedAt);
      }
    })
  );
  db.prepare("UPDATE projects SET next_key_num = ? WHERE id = ?").run(base + items.length + 1, pid);
  return ms;
}

function fileBytes(db: ProjectDb): number {
  db.pragma("wal_checkpoint(TRUNCATE)");
  return fs.statSync(db.path).size;
}

function tableBytes(db: ProjectDb, like: string): number | null {
  try {
    const r = db.prepare("SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name LIKE ?").get(like) as { bytes: number };
    return r.bytes;
  } catch {
    return null;
  }
}

/** Categories a lexical engine can score on; typo/synonym are the ceiling, key/short have lexical labels. */
const TOPIC_CATEGORIES: Category[] = ["en-phrase", "en-reordered", "en-single", "zh-phrase", "zh-words", "zh-single-2", "zh-single-3", "mixed"];
/** Queries whose words stand apart, so every form but the paraphrase is reachable in principle. */
const SPLIT_WORD_CATEGORIES: Category[] = ["en-phrase", "en-reordered", "zh-words"];

async function runSize(n: number, seed: number, limits: (number | null)[], root: string): Promise<{ size: SizeReport; engines: Record<string, string> }> {
  const { items, queries } = generateDataset(n, seed);
  const avgBytes = items.reduce((s, it) => s + Buffer.byteLength(it.title + it.body), 0) / items.length;
  const variantOf = new Map(items.filter((it) => it.variant).map((it) => [it.key, it.variant!]));

  const off = await fresh({ cacheDir: fs.mkdtempSync(path.join(root, `off-${n}-`)) });
  const on = await fresh({ cacheDir: fs.mkdtempSync(path.join(root, `on-${n}-`)) });
  off.db.exec("DROP TRIGGER items_fts_ai; DROP TRIGGER items_fts_ad; DROP TRIGGER items_fts_au; DROP TABLE items_fts;");
  const base = Math.max(
    (off.db.prepare("SELECT COALESCE(MAX(key_num), 0) AS m FROM items").get() as { m: number }).m,
    (on.db.prepare("SELECT COALESCE(MAX(key_num), 0) AS m FROM items").get() as { m: number }).m
  );

  const insertOff = seedRows(off.db, off.project.id, off.board.id, items, base);
  const insertOn = seedRows(on.db, on.project.id, on.board.id, items, base);
  const storage = { off: fileBytes(off.db), on: fileBytes(on.db), ftsTables: tableBytes(on.db, "items_fts%"), itemsTable: tableBytes(on.db, "items") };
  const rebuildOn = timed(() => on.db.exec("INSERT INTO items_fts(items_fts) VALUES ('rebuild')")).ms;

  const weights = (process.env.TOMRADE_BENCH_WEIGHTS ?? "").split(",").filter(Boolean).map(Number);
  const engines = [...rawEngines(off.db, off.project.id, on.db, on.project.id, base, weights), ...serviceEngines(off.items, off.project.id, on.items, on.project.id, base)];
  const byId = Object.fromEntries(engines.map((e) => [e.id, e]));
  const raw = engines.filter((e) => e.raw);

  // Accuracy: one unlimited pass per raw engine; a LIMIT is a prefix of the same order, so every limit is scored from it.
  const full = new Map<string, { keys: number[]; parts: number[] }[]>();
  for (const e of raw) {
    full.set(
      e.id,
      queries.map((q) => {
        const r = e.run(q.text);
        return { keys: r.keys, parts: (JSON.parse(r.payload) as object[]).map((o) => estTokens(JSON.stringify(o))) };
      })
    );
  }
  // The service must agree with the raw FTS SQL, and a LIMIT must be that order's prefix, or the numbers describe the wrong thing.
  for (const q of queries.filter((_, i) => i % 7 === 0)) {
    const all = byId.fts!.run(q.text).keys;
    const ten = byId.fts!.run(q.text, 10).keys;
    if (ten.join() !== all.slice(0, 10).join()) throw new Error(`LIMIT 10 is not the prefix of the full order for ${JSON.stringify(q.text)}`);
    try {
      if (byId["svc-new"]!.run(q.text).keys.join() !== all.join()) throw new Error(`svc-new and fts disagree on ${JSON.stringify(q.text)}`);
      if (byId["svc-new"]!.run(q.text, 10).keys.join() !== ten.join()) throw new Error(`svc-new limit 10 and fts limit 10 disagree on ${JSON.stringify(q.text)}`);
    } catch (err) {
      if (!(err as Error).message.includes("too many SQL variables")) throw err;
    }
  }

  const categories = [...new Set(queries.map((q) => q.category))];
  const accuracy: SizeReport["accuracy"] = {};
  const overall: SizeReport["overall"] = {};
  const perQuery: SizeReport["perQuery"] = queries.map((q) => ({ id: q.id, text: q.text, category: q.category, relevant: q.relevant.length, engines: {} }));
  for (const limit of limits) {
    const label = limitLabel(limit);
    const k = limit ?? undefined;
    accuracy[label] = {};
    overall[label] = {};
    const scored = new Map<string, QueryResult[]>();
    for (const [engine, list] of full) scored.set(engine, list.map((r, i) => score(queries[i]!, cut(r.keys, k), cut(r.parts, k))));
    for (const cat of categories) {
      accuracy[label]![cat] = {};
      for (const [engine, list] of scored) accuracy[label]![cat]![engine] = aggregate(list.filter((r) => r.query.category === cat));
    }
    for (const [engine, list] of scored) {
      overall[label]![engine] = aggregate(list.filter((r) => TOPIC_CATEGORIES.includes(r.query.category)));
      if (limit === null) list.forEach((r, i) => (perQuery[i]!.engines[engine] = { hits: r.keys.length, recall: r.recall, rr: r.rr, tokens: r.tokens }));
    }
  }
  const variants: SizeReport["variants"] = {};
  for (const [engine, list] of full) {
    const counts: Record<Variant, number> = { phrase: 0, reordered: 0, split: 0, paraphrase: 0 };
    const rows = list.map((r, i) => ({ ...r, query: queries[i]! })).filter((r) => SPLIT_WORD_CATEGORIES.includes(r.query.category));
    for (const r of rows) for (const key of r.keys) if (variantOf.has(key) && r.query.relevant.includes(key)) counts[variantOf.get(key)!]++;
    variants[engine] = Object.fromEntries(Object.entries(counts).map(([v, c]) => [v, c / rows.length])) as Record<Variant, number>;
  }

  // Latency: a query's cost is its median of a few runs after a warm-up; the spread is across queries.
  const runs = Number(process.env.TOMRADE_BENCH_RUNS ?? 3);
  const step = n >= 50_000 ? 5 : 1;
  const sample = queries.filter((_, i) => i % step === 0);
  const smallest = limits.filter((l): l is number => l !== null).sort((a, b) => a - b)[0];
  const latencyRuns: { engine: Engine; limit?: number }[] = [
    ...engines.map((engine) => ({ engine })),
    ...(smallest === undefined ? [] : [byId.instr!, byId.fts!, byId.phrase!, byId["svc-new"]!].map((engine) => ({ engine, limit: smallest })))
  ];
  const latency: SizeReport["latency"] = {};
  for (const { engine, limit } of latencyRuns) {
    const per: number[] = [];
    let error: string | undefined;
    try {
      engine.run(sample[0]!.text, limit);
      for (const q of sample) {
        const t: number[] = [];
        for (let i = 0; i < runs; i++) t.push(timed(() => engine.run(q.text, limit)).ms);
        per.push(quantile(t, 0.5));
      }
    } catch (err) {
      error = (err as Error).message;
    }
    latency[limit === undefined ? engine.id : `${engine.id}@${limit}`] = {
      label: engine.label,
      limit: limit ?? null,
      queries: per.length,
      p50: quantile(per, 0.5),
      p95: quantile(per, 0.95),
      max: per.length ? Math.max(...per) : NaN,
      mean: mean(per),
      ...(error ? { error } : {})
    };
  }

  // Writes after the reads, so every engine saw the same corpus.
  const updateK = Math.min(1000, Math.floor(n / 5));
  const pickKeys = Array.from({ length: updateK }, (_, i) => base + 1 + Math.floor((i * n) / updateK));
  const createK = Math.min(200, updateK);
  const createOn = timed(() => {
    for (let i = 0; i < createK; i++) on.items.create({ projectId: on.project.id, boardId: on.board.id, title: `Bench create ${i}`, body: "Created through the service.", by: "human" });
  }).ms;
  const createOff = timed(() => {
    for (let i = 0; i < createK; i++) off.items.create({ projectId: off.project.id, boardId: off.board.id, title: `Bench create ${i}`, body: "Created through the service.", by: "human" });
  }).ms;
  const updateSql = "UPDATE items SET title = title || ' (edited)', body = coalesce(body, '') || ' Edited.', version = version + 1, updated_at = ? WHERE project_id = ? AND key_num = ?";
  const update = (db: ProjectDb, pid: string) => timed(() => db.transaction(() => { for (const key of pickKeys) db.prepare(updateSql).run(Date.now(), pid, key); })).ms;
  const updateOff = update(off.db, off.project.id);
  const updateOn = update(on.db, on.project.id);
  const del = (db: ProjectDb, pid: string) => timed(() => db.transaction(() => { for (const key of pickKeys) db.prepare("DELETE FROM items WHERE project_id = ? AND key_num = ?").run(pid, key); })).ms;
  const deleteOff = del(off.db, off.project.id);
  const deleteOn = del(on.db, on.project.id);

  off.db.close();
  on.db.close();
  return {
    engines: Object.fromEntries(engines.map((e) => [e.id, e.label])),
    size: {
      n,
      avgBytes,
      storage,
      writes: { insertOff, insertOn, rebuildOn, createK, createOff, createOn, updateK, updateOff, updateOn, deleteOff, deleteOn },
      latency,
      accuracy,
      overall,
      variants,
      perQuery
    }
  };
}

it.skipIf(!process.env.TOMRADE_BENCH)(
  "items search: FTS on vs off",
  async () => {
    const sizes = (process.env.TOMRADE_BENCH_SIZES ?? "1000,10000,100000").split(",").map(Number);
    const seed = Number(process.env.TOMRADE_BENCH_SEED ?? 42);
    const limits: (number | null)[] = [null, ...(process.env.TOMRADE_BENCH_LIMITS ?? "20,10").split(",").map(Number)];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-search-bench-"));
    const reports: SizeReport[] = [];
    let engines: Record<string, string> = {};
    for (const n of sizes) {
      console.log(`[bench] n=${n} …`);
      const r = await runSize(n, seed, limits, root);
      reports.push(r.size);
      engines = r.engines;
    }
    fs.rmSync(root, { recursive: true, force: true });
    const probe = await fresh();
    const sqlite = (probe.db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
    const report: BenchReport = {
      schemaVersion: 2,
      env: { date: new Date().toISOString().slice(0, 10), node: process.version, sqlite, cpu: os.cpus()[0]?.model ?? "?", seed: String(seed) },
      engines,
      limits,
      queryCount: reports[0]?.perQuery.length ?? 0,
      topicCategories: TOPIC_CATEGORIES,
      sizes: reports
    };
    const outDir = path.resolve(process.env.TOMRADE_BENCH_OUTPUT ?? "artifacts/search-bench");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outDir, `${stamp}.md`), renderMarkdown(report));
    fs.writeFileSync(path.join(outDir, `${stamp}.html`), renderHtml(report));
    for (const s of reports)
      for (const [lim, byEngine] of Object.entries(s.overall))
        console.log(`[bench] n=${s.n} limit=${lim} ` + Object.entries(byEngine).map(([e, a]) => `${e}: recall ${(a.recall * 100).toFixed(0)}% mrr ${a.mrr.toFixed(2)} prec ${(a.precision * 100).toFixed(0)}% tokens ${a.tokens.toFixed(0)}`).join(" | "));
    console.log(`[bench] written to ${outDir}/${stamp}.{json,md,html}`);
  },
  3_600_000
);
