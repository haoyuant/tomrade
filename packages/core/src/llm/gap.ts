/**
 * Gap analysis: a stated requirement vs. the existing backlog -> missing items.
 * Not a retrieval problem: the LLM compares the requirement against a compact
 * summary-first projection of the backlog.
 */
import { z } from "zod";
import type { LLMProvider } from "./provider.js";
import type { ItemKind } from "../types.js";

const gapSchema = z.object({
  missing: z.array(
    z.object({
      title: z.string().min(1),
      body: z.string().optional().nullable(),
      kind: z.enum(["ticket", "epic"]).optional(),
      reason: z.string()
    })
  )
});

export interface GapCandidate {
  title: string;
  body: string | null;
  kind: ItemKind;
  reason: string;
}

const SYSTEM = [
  "You are a product gap analyst.",
  "Given a stated requirement and the existing backlog (title + short body), list the missing backlog items needed to fully satisfy the requirement.",
  "- Only list items that are genuinely absent (not already covered by an existing item).",
  "- Each item sized for ONE coding-agent PR; epics only for broad themes with clear children.",
  "- Reason: one sentence explaining the gap.",
  "- Return JSON: {\"missing\": [{\"title\": string, \"body\": string|null, \"kind\": \"ticket\"|\"epic\", \"reason\": string}]}"
].join("\n");

export async function gapAnalysis(
  provider: LLMProvider,
  input: { requirement: string; existing: { id: string; title: string; body: string | null }[] }
): Promise<GapCandidate[]> {
  const user = [
    "REQUIREMENT:",
    input.requirement,
    "",
    "EXISTING BACKLOG:",
    ...input.existing.map((e) => "- [" + e.id + "] " + e.title + (e.body ? " — " + e.body : "")),
    "",
    "Total existing: " + input.existing.length
  ].join("\n");

  const out = await provider.completeJson(gapSchema, { system: SYSTEM, user });
  return out.missing.map((m) => ({
    title: m.title,
    body: m.body ?? null,
    kind: m.kind ?? "ticket",
    reason: m.reason
  }));
}
