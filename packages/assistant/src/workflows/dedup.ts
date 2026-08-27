import { z } from "zod";
import type { DedupResult } from "@tomrade/domain";
import type { LLMProvider } from "@tomrade/llm";

const schema = z.object({
  is_duplicate: z.boolean(),
  duplicates: z.array(z.object({ id: z.string(), reason: z.string() }))
});

export interface BacklogSummary {
  id: string;
  title: string;
  body: string | null;
}

export interface DedupInput {
  title: string;
  body: string | null;
  existing: BacklogSummary[];
}

const SYSTEM = [
  "You are a backlog dedup judge.",
  "Given a proposed item and the existing backlog (title + short body each), decide whether the proposed item duplicates one or more existing items.",
  "- Only flag duplicates that are genuinely about the SAME requirement (semantic match), not mere similarity.",
  "- If duplicate, list every matched existing item id with a one-line reason.",
  '- Return JSON: {"is_duplicate": boolean, "duplicates": [{"id": string, "reason": string}]}'
].join("\n");

export const summarize = (existing: BacklogSummary[]): string[] => existing.map((e) => "- [" + e.id + "] " + e.title + (e.body ? " — " + e.body : ""));

export async function checkDuplicate(llm: LLMProvider, input: DedupInput): Promise<DedupResult> {
  const user = ["PROPOSED:", "- " + input.title, input.body ? "  " + input.body : "", "", "EXISTING BACKLOG:", ...summarize(input.existing), "", "Total existing: " + input.existing.length]
    .filter((l) => l.length > 0)
    .join("\n");
  const out = await llm.completeJson(schema, { system: SYSTEM, user });
  return { isDuplicate: out.is_duplicate, duplicates: out.duplicates };
}
