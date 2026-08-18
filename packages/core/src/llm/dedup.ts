/**
 * Dedup: given a proposed ticket, judge whether it duplicates existing backlog
 * items. Semantic recall is a future optimization; today the LLM judges against
 * a bounded candidate list (summary-first, token-budgeted).
 */
import { z } from "zod";
import type { LLMProvider } from "./provider.js";

const dedupSchema = z.object({
  is_duplicate: z.boolean(),
  duplicates: z.array(
    z.object({ id: z.string(), reason: z.string() })
  )
});

export interface DedupResult {
  isDuplicate: boolean;
  duplicates: { id: string; reason: string }[];
}

export interface DedupInput {
  title: string;
  body: string | null;
  existing: { id: string; title: string; body: string | null }[];
}

const SYSTEM = [
  "You are a backlog dedup judge.",
  "Given a proposed item and the existing backlog (title + short body each), decide whether the proposed item duplicates one or more existing items.",
  "- Only flag duplicates that are genuinely about the SAME requirement (semantic match), not mere similarity.",
  "- If duplicate, list every matched existing item id with a one-line reason.",
  "- Return JSON: {\"is_duplicate\": boolean, \"duplicates\": [{\"id\": string, \"reason\": string}]}"
].join("\n");

export async function checkDuplicate(provider: LLMProvider, input: DedupInput): Promise<DedupResult> {
  const user = [
    "PROPOSED:",
    "- " + input.title,
    input.body ? "  " + input.body : "",
    "",
    "EXISTING BACKLOG:",
    ...input.existing.map((e) => "- [" + e.id + "] " + e.title + (e.body ? " — " + e.body : "")),
    "",
    "Total existing: " + input.existing.length
  ].filter((l) => l.length > 0).join("\n");

  const out = await provider.completeJson(dedupSchema, { system: SYSTEM, user });
  return { isDuplicate: out.is_duplicate, duplicates: out.duplicates };
}
