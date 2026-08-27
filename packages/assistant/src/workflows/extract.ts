import { z } from "zod";
import type { ExtractCandidate } from "@tomrade/domain";
import type { LLMProvider } from "@tomrade/llm";

const schema = z.object({
  items: z.array(
    z.object({
      title: z.string().min(1),
      body: z.string().optional().nullable(),
      kind: z.enum(["ticket", "epic"]).optional()
    })
  )
});

const SYSTEM = [
  "You extract product requirements from free-form text into backlog items.",
  "Rules:",
  "- One item per distinct requirement; sized for ONE coding-agent PR.",
  "- Title: imperative, short (<80 chars). Body: 1-3 sentences of intent, keep it lean.",
  '- kind: "epic" only for a broad theme that clearly needs children; otherwise "ticket".',
  "- Do NOT invent requirements the text does not state.",
  '- Return JSON: {"items": [{"title": string, "body": string|null, "kind": "ticket"|"epic"}]}'
].join("\n");

export async function extractTickets(llm: LLMProvider, text: string): Promise<ExtractCandidate[]> {
  const out = await llm.completeJson(schema, { system: SYSTEM, user: text });
  return out.items.map((i) => ({ title: i.title, body: i.body ?? null, kind: i.kind ?? "ticket" }));
}
