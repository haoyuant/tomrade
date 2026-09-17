/**
 * Renders a search benchmark run (the JSON `search.bench.test.ts` writes) as
 * Markdown and as a self-contained HTML page with charts. No dependencies, so
 * a saved run can be re-rendered without booting a context.
 */
import type { Category, Variant } from "./search-dataset.js";

export interface Agg {
  queries: number;
  recall: number;
  precision: number;
  noHit: number;
  mrr: number;
  r5: number;
  results: number;
  tokens: number;
  tokensToFirstHit: number;
}

export interface LatencyRow {
  label: string;
  limit: number | null;
  queries: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
  error?: string;
}

export interface SizeReport {
  n: number;
  avgBytes: number;
  storage: { off: number; on: number; ftsTables: number | null; itemsTable: number | null };
  writes: {
    insertOff: number;
    insertOn: number;
    rebuildOn: number;
    createK: number;
    createOff: number;
    createOn: number;
    updateK: number;
    updateOff: number;
    updateOn: number;
    deleteOff: number;
    deleteOn: number;
  };
  /** Keyed by engine id, or `id@limit` for a run with a LIMIT. */
  latency: Record<string, LatencyRow>;
  /** limit label ("all", "20", "10") → category → engine → aggregate. */
  accuracy: Record<string, Record<string, Record<string, Agg>>>;
  /** limit label → engine → aggregate over the topic categories. */
  overall: Record<string, Record<string, Agg>>;
  variants: Record<string, Record<Variant, number>>;
  perQuery: { id: string; text: string; category: Category; relevant: number; engines: Record<string, { hits: number; recall: number; rr: number; tokens: number }> }[];
}

export interface BenchReport {
  schemaVersion: 2;
  env: Record<string, string>;
  engines: Record<string, string>;
  limits: (number | null)[];
  queryCount: number;
  /** The categories `overall` aggregates. */
  topicCategories: string[];
  sizes: SizeReport[];
}

export const limitLabel = (limit: number | null | undefined) => (limit === null || limit === undefined ? "all" : String(limit));

const ms = (x: number) => (Number.isFinite(x) ? (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) : "n/a");
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "n/a");
const num = (x: number) => (Number.isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "n/a");
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`;

export function renderMarkdown(r: BenchReport): string {
  const L: string[] = [];
  L.push(`# Items search: FTS on vs off`, "");
  L.push(Object.entries(r.env).map(([k, v]) => `${k}: ${v}`).join(" · "), "");
  L.push(`Engines: ${Object.entries(r.engines).map(([id, label]) => `${id} = ${label}`).join("; ")}.`, "");
  L.push(`Labelled queries: ${r.queryCount}. Relevant = the topic's four items (adjacent words in title, reordered, split across title and body, paraphrase); key/short queries count every mention. "Overall" aggregates ${r.topicCategories.join(", ")}.`, "");

  L.push(`## Cost`, "");
  L.push(`| items | avg title+body | file, FTS off | file, FTS on | of which items_fts | insert all, off | insert all, on | rebuild index | items.create ×K off | ×K on | update ×K off | on | delete ×K off | on |`);
  L.push(`|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const s of r.sizes) {
    const w = s.writes;
    L.push(
      `| ${num(s.n)} | ${s.avgBytes.toFixed(0)} B | ${mb(s.storage.off)} | ${mb(s.storage.on)} (${(s.storage.on / s.storage.off).toFixed(2)}×) | ${s.storage.ftsTables === null ? "n/a" : mb(s.storage.ftsTables)} | ${ms(w.insertOff)} ms | ${ms(w.insertOn)} ms (${(w.insertOn / w.insertOff).toFixed(2)}×) | ${ms(w.rebuildOn)} ms | ${ms(w.createOff / w.createK)} ms/op (K=${w.createK}) | ${ms(w.createOn / w.createK)} ms/op | ${ms(w.updateOff)} ms (K=${w.updateK}) | ${ms(w.updateOn)} ms | ${ms(w.deleteOff)} ms | ${ms(w.deleteOn)} ms |`
    );
  }
  L.push("", `No engine calls a paid API; cost is disk, CPU and the tokens an agent reads back (below).`, "");

  L.push(`## Latency (ms per query)`, "");
  L.push(`| items | engine | limit | queries | p50 | p95 | max | mean |`);
  L.push(`|---:|---|---:|---:|---:|---:|---:|---:|`);
  for (const s of r.sizes)
    for (const l of Object.values(s.latency)) {
      L.push(l.error ? `| ${num(s.n)} | ${l.label} | ${limitLabel(l.limit)} | 0 | error | | | ${l.error} |` : `| ${num(s.n)} | ${l.label} | ${limitLabel(l.limit)} | ${l.queries} | ${ms(l.p50)} | ${ms(l.p95)} | ${ms(l.max)} | ${ms(l.mean)} |`);
    }
  L.push("");

  L.push(`## Overall, topic queries`, "");
  L.push(`| items | limit | engine | recall | precision | MRR | R@5 | results | est. tokens | tokens to first hit |`);
  L.push(`|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const s of r.sizes)
    for (const [lim, byEngine] of Object.entries(s.overall))
      for (const [e, a] of Object.entries(byEngine)) L.push(`| ${num(s.n)} | ${lim} | ${e} | ${pct(a.recall)} | ${pct(a.precision)} | ${a.mrr.toFixed(2)} | ${pct(a.r5)} | ${a.results.toFixed(1)} | ${num(a.tokens)} | ${num(a.tokensToFirstHit)} |`);
  L.push("");

  for (const s of r.sizes) {
    for (const [lim, byCat] of Object.entries(s.accuracy)) {
      L.push(`## Per category at ${num(s.n)} items, limit ${lim}`, "");
      const ids = Object.keys(Object.values(byCat)[0] ?? {});
      const e = ids.join(" / ");
      L.push(`| category | #q | recall ${e} | MRR ${e} | R@5 ${e} | precision ${e} | no-hit ${e} | results ${e} | est. tokens ${e} | tokens to first hit ${e} |`);
      L.push(`|---|---:|---|---|---|---|---|---|---|---|`);
      for (const [cat, byEngine] of Object.entries(byCat)) {
        const col = (f: (a: Agg) => string) => ids.map((id) => f(byEngine[id]!)).join(" / ");
        L.push(
          `| ${cat} | ${byEngine[ids[0]!]!.queries} | ${col((a) => pct(a.recall))} | ${col((a) => a.mrr.toFixed(2))} | ${col((a) => pct(a.r5))} | ${col((a) => pct(a.precision))} | ${col((a) => String(a.noHit))} | ${col((a) => a.results.toFixed(1))} | ${col((a) => num(a.tokens))} | ${col((a) => num(a.tokensToFirstHit))} |`
        );
      }
      L.push("");
    }
    L.push(`Which of a topic's four forms each engine retrieves at ${num(s.n)} items (share of en-phrase, en-reordered and zh-words queries, no limit):`, "");
    L.push(`| engine | adjacent in title | reordered | split title/body | paraphrase |`);
    L.push(`|---|---:|---:|---:|---:|`);
    for (const [e, v] of Object.entries(s.variants)) L.push(`| ${e} | ${pct(v.phrase)} | ${pct(v.reordered)} | ${pct(v.split)} | ${pct(v.paraphrase)} |`);
    L.push("");
  }
  return L.join("\n");
}

