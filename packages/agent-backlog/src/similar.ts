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
  duplicates: z.array(z.object({ id: z.string(), reason: z.string() })),
  related: z.array(z.object({ id: z.string(), reason: z.string() }))
});

const JUDGE_SYSTEM = [
  "You judge backlog duplication. Given a proposed item and candidate existing items, sort the candidates:",
  "- duplicates: genuinely the SAME requirement (semantic match, not surface similarity).",
  "- related: same area or parent theme, but a different requirement.",
  "Leave out candidates that are neither.",
  'Return JSON: {"duplicates": [{"id","reason"}], "related": [{"id","reason"}]}'
].join("\n");

/** Lexical candidates, then a worker-model judgement; falls back to scores alone when no model answers. */
export async function findSimilar(llm: LlmService | null, proposed: { title: string; body?: string | null }, existing: Item[], limit = 5): Promise<SimilarResult> {
  const scored = existing
    .map((item) => ({ item, score: Math.max(overlap(proposed.title, item.title), overlap(proposed.title, item.body ?? "") * 0.7) }))
    .filter((s) => s.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit * 3, 9));
  if (!scored.length) return { verdict: "none", matches: [] };

  const toMatch = (s: (typeof scored)[number], reason: string): SimilarMatch => ({
    id: s.item.id,
    key: s.item.key,
    title: s.item.title,
    kind: s.item.kind,
    status: s.item.status,
    score: Number(s.score.toFixed(2)),
    reason
  });

  if (llm) {
    try {
      const user = [
        `PROPOSED: ${proposed.title}`,
        proposed.body ? `  ${proposed.body}` : "",
        "",
        "CANDIDATES:",
        ...scored.map((s) => `- [${s.item.id}] (${s.item.kind}) ${s.item.title}${s.item.body ? " — " + s.item.body.slice(0, 120) : ""}`)
      ]
        .filter(Boolean)
        .join("\n");
      const out = await llm.completeJson(judgeSchema, { system: JUDGE_SYSTEM, user });
      const byId = new Map(scored.map((s) => [s.item.id, s]));
      const dup = out.duplicates.flatMap((d) => (byId.has(d.id) ? [toMatch(byId.get(d.id)!, d.reason)] : []));
      const rel = out.related.flatMap((r) => (byId.has(r.id) ? [toMatch(byId.get(r.id)!, r.reason)] : []));
      return { verdict: dup.length ? "duplicate" : rel.length ? "related" : "none", matches: [...dup, ...rel].slice(0, limit) };
    } catch {
      // fall through to lexical
    }
  }
  const top = scored.slice(0, limit).map((s) => toMatch(s, "similar title"));
  return { verdict: scored[0].score > 0.72 ? "duplicate" : scored[0].score > 0.35 ? "related" : "none", matches: top };
}
