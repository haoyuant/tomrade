import type { Context } from "cordis";
import { z } from "zod";
import type { Author, Item } from "@tomrade/domain";
import type { LlmService } from "@tomrade/llm";
import { LlmError } from "@tomrade/llm";
import { overlap } from "./similar.js";

export const planSchema = z.object({
  epics: z.array(
    z.object({
      title: z.string().min(1),
      body: z.string().default(""),
      features: z.array(z.object({ title: z.string().min(1), body: z.string().default(""), priority: z.number().int().min(0).max(4).optional() })).default([])
    })
  ),
  notes: z.string().optional()
});
export type Plan = z.infer<typeof planSchema>;

const PLAN_SYSTEM = [
  "You decompose a product requirement into a backlog tree: epics, each holding features.",
  "House rules:",
  "- 2–6 epics: broad themes with clear children, no filler.",
  "- Every feature is sized for ONE pull request by a coding agent. Split anything bigger.",
  "- Titles: imperative, under 80 characters. Bodies: 1–3 sentences of intent, lean.",
  "- Do NOT invent requirements the input does not state; note genuine gaps in `notes` instead.",
  "- Do not re-propose work the existing backlog already covers.",
  '- Return JSON: {"epics": [{"title", "body", "features": [{"title", "body", "priority"?}]}], "notes"?}'
].join("\n");

export async function generatePlan(llm: LlmService | null, requirement: string, existing: Item[]): Promise<Plan> {
  if (!llm) throw new LlmError("planning needs a worker model — configure one in Settings → Assistant");
  const user = [
    "REQUIREMENT:",
    requirement,
    "",
    "EXISTING BACKLOG (do not duplicate):",
    ...existing.slice(0, 200).map((i) => `- [${i.key}] (${i.kind}) ${i.title}`),
    existing.length ? "" : "- (empty)"
  ].join("\n");
  return llm.completeJson(planSchema, { system: PLAN_SYSTEM, user });
}

export interface ApplyOutcome {
  rootKey: string;
  created: { key: string; kind: string; title: string; parentKey: string | null }[];
  skipped: { title: string; reason: string }[];
}

/**
 * One SQLite transaction writes the whole tree — no half-applied plan, one
 * run_id, one revert. Features that lexically duplicate an existing item are
 * skipped and reported rather than written.
 */
export function applyPlan(
  ctx: Context,
  opts: { projectId: string; author: Author; rootTitle: string; rootBody: string; plan: Plan; existing: Item[] }
): ApplyOutcome {
  const boardId = ctx.boards.defaultFor(opts.projectId).id;
  const created: ApplyOutcome["created"] = [];
  const skipped: ApplyOutcome["skipped"] = [];
  const dupOf = (title: string): Item | undefined => opts.existing.find((i) => overlap(title, i.title) > 0.66);

  const rootKey = ctx.db.for(opts.projectId).transaction(() => {
    const root = ctx.items.create({ projectId: opts.projectId, boardId, kind: "epic", title: opts.rootTitle, body: opts.rootBody, by: opts.author });
    created.push({ key: root.key, kind: "epic", title: root.title, parentKey: null });
    for (const epic of opts.plan.epics) {
      const parent = ctx.items.create({ projectId: opts.projectId, boardId, kind: "epic", title: epic.title, body: epic.body || null, parentId: root.id, by: opts.author });
      created.push({ key: parent.key, kind: "epic", title: parent.title, parentKey: root.key });
      for (const feature of epic.features) {
        const existing = dupOf(feature.title);
        if (existing) {
          skipped.push({ title: feature.title, reason: `already covered by ${existing.key} "${existing.title}"` });
          continue;
        }
        const item = ctx.items.create({
          projectId: opts.projectId,
          boardId,
          kind: "ticket",
          title: feature.title,
          body: feature.body || null,
          priority: (feature.priority ?? 2) as Item["priority"],
          parentId: parent.id,
          by: opts.author
        });
        created.push({ key: item.key, kind: "ticket", title: item.title, parentKey: parent.key });
      }
    }
    return root.key;
  });
  return { rootKey, created, skipped };
}

export const gapSchema = z.object({
  missing: z.array(z.object({ title: z.string().min(1), body: z.string().optional().nullable(), reason: z.string() }))
});

const GAP_SYSTEM = [
  "You are a product gap analyst.",
  "Given a stated requirement and the existing backlog, list the missing backlog items needed to fully satisfy the requirement.",
  "- Only items that are genuinely absent. Each sized for ONE pull request.",
  "- Reason: one sentence explaining the gap.",
  '- Return JSON: {"missing": [{"title", "body"?, "reason"}]}'
].join("\n");

export async function findGaps(llm: LlmService | null, requirement: string, existing: Item[]): Promise<{ title: string; body: string | null; reason: string }[]> {
  if (!llm) throw new LlmError("gap analysis needs a worker model — configure one in Settings → Assistant");
  const user = ["REQUIREMENT:", requirement, "", "EXISTING BACKLOG:", ...existing.slice(0, 300).map((i) => `- [${i.key}] ${i.title}${i.body ? " — " + i.body.slice(0, 100) : ""}`)].join("\n");
  const out = await llm.completeJson(gapSchema, { system: GAP_SYSTEM, user });
  return out.missing.map((m) => ({ title: m.title, body: m.body ?? null, reason: m.reason }));
}
