import { z } from "zod";
import type { Item } from "@tomrade/domain";
import type { LlmService } from "@tomrade/llm";

/** Latin words plus CJK bigrams, so “喝水提醒” and "water reminder" both score. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9]+/g)) out.add(match[0]);
  const cjk = lower.replace(/[^㐀-鿿]/g, "");
  for (let i = 0; i < cjk.length - 1; i += 1) out.add(cjk.slice(i, i + 2));
  if (cjk.length === 1) out.add(cjk);
  return out;
}

export function overlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.sqrt(ta.size * tb.size);
}

export interface SimilarMatch {
  id: string;
  key: string;
  title: string;
  kind: string;
  status: string;
  score: number;
  reason: string;
}

export interface SimilarResult {
  verdict: "duplicate" | "related" | "none";
  matches: SimilarMatch[];
}

const judgeSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int(),
      duplicates: z.array(z.object({ id: z.string(), reason: z.string() })),
      related: z.array(z.object({ id: z.string(), reason: z.string() }))
    })
  )
});

const JUDGE_SYSTEM = [
  "You judge backlog duplication. For EACH proposed item (by index), sort its candidate existing items:",
  "- duplicates: genuinely the SAME requirement (semantic match, not surface similarity).",
  "- related: same area or parent theme, but a different requirement.",
  "Leave out candidates that are neither. Cover every proposed index.",
  'Return JSON: {"results": [{"index", "duplicates": [{"id","reason"}], "related": [{"id","reason"}]}]}'
].join("\n");

interface Scored {
  item: Item;
  score: number;
}

const toMatch = (s: Scored, reason: string): SimilarMatch => ({
  id: s.item.id,
  key: s.item.key,
  title: s.item.title,
  kind: s.item.kind,
  status: s.item.status,
  score: Number(s.score.toFixed(2)),
  reason
});

const candidatesFor = (title: string, existing: Item[], limit: number): Scored[] =>
  existing
    .map((item) => ({ item, score: Math.max(overlap(title, item.title), overlap(title, item.body ?? "") * 0.7) }))
    .filter((s) => s.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit * 3, 9));

const lexicalVerdict = (scored: Scored[], limit: number): SimilarResult =>
  scored.length
    ? { verdict: scored[0].score > 0.72 ? "duplicate" : scored[0].score > 0.35 ? "related" : "none", matches: scored.slice(0, limit).map((s) => toMatch(s, "similar title")) }
    : { verdict: "none", matches: [] };

/**
 * Lexical candidates per proposal, then ONE worker-model judgement covering all
 * of them — the concurrency lives inside the tool, so checking ten titles costs
 * one model call, not ten. Falls back to scores alone when no model answers.
 */
export async function findSimilarBatch(llm: LlmService | null, proposals: { title: string; body?: string | null }[], existing: Item[], limit = 5): Promise<SimilarResult[]> {
  const scored = proposals.map((p) => candidatesFor(p.title, existing, limit));
  if (llm && scored.some((s) => s.length)) {
    try {
      const sections = proposals.map((p, i) =>
        [
          `PROPOSED #${i}: ${p.title}`,
          p.body ? `  ${p.body}` : "",
          "  CANDIDATES:",
          ...scored[i].map((s) => `  - [${s.item.id}] (${s.item.kind}) ${s.item.title}${s.item.body ? " — " + s.item.body.slice(0, 120) : ""}`),
          scored[i].length ? "" : "  - (none)"
        ]
          .filter(Boolean)
          .join("\n")
      );
      const out = await llm.completeJson(judgeSchema, { system: JUDGE_SYSTEM, user: sections.join("\n\n") });
      return proposals.map((_p, i) => {
        const judged = out.results.find((r) => r.index === i);
        if (!judged) return lexicalVerdict(scored[i], limit);
        const byId = new Map(scored[i].map((s) => [s.item.id, s]));
        const dup = judged.duplicates.flatMap((d) => (byId.has(d.id) ? [toMatch(byId.get(d.id)!, d.reason)] : []));
        const rel = judged.related.flatMap((r) => (byId.has(r.id) ? [toMatch(byId.get(r.id)!, r.reason)] : []));
        return { verdict: dup.length ? "duplicate" : rel.length ? "related" : "none", matches: [...dup, ...rel].slice(0, limit) } as SimilarResult;
      });
    } catch {
      // fall through to lexical
    }
  }
  return scored.map((s) => lexicalVerdict(s, limit));
}

export async function findSimilar(llm: LlmService | null, proposed: { title: string; body?: string | null }, existing: Item[], limit = 5): Promise<SimilarResult> {
  return (await findSimilarBatch(llm, [proposed], existing, limit))[0];
}
