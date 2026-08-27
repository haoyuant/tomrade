import { z } from "zod";
import type { GapCandidate } from "@tomrade/domain";
import type { LLMProvider } from "@tomrade/llm";
import { summarize, type BacklogSummary } from "./dedup.js";

const schema = z.object({
  missing: z.array(
    z.object({
      title: z.string().min(1),
      body: z.string().optional().nullable(),
      kind: z.enum(["ticket", "epic"]).optional(),
      reason: z.string()
    })
  )
});

const SYSTEM = [
  "You are a product gap analyst.",
  "Given a stated requirement and the existing backlog (title + short body), list the missing backlog items needed to fully satisfy the requirement.",
  "- Only list items that are genuinely absent (not already covered by an existing item).",
  "- Each item sized for ONE coding-agent PR; epics only for broad themes with clear children.",
  "- Reason: one sentence explaining the gap.",
  '- Return JSON: {"missing": [{"title": string, "body": string|null, "kind": "ticket"|"epic", "reason": string}]}'
].join("\n");

export async function gapAnalysis(llm: LLMProvider, input: { requirement: string; existing: BacklogSummary[] }): Promise<GapCandidate[]> {
  const user = ["REQUIREMENT:", input.requirement, "", "EXISTING BACKLOG:", ...summarize(input.existing), "", "Total existing: " + input.existing.length].join("\n");
  const out = await llm.completeJson(schema, { system: SYSTEM, user });
  return out.missing.map((m) => ({ title: m.title, body: m.body ?? null, kind: m.kind ?? "ticket", reason: m.reason }));
}
