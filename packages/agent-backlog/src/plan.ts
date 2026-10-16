import type { Context } from "cordis";
import { z } from "zod";
import type { Author, Item } from "@tomradex/domain";
import type { LlmService } from "@tomradex/llm";
import { LlmError } from "@tomradex/llm";
import { overlap } from "./similar.js";

const PRIORITY_WORDS: Record<string, number> = { none: 0, low: 1, medium: 2, normal: 2, high: 3, urgent: 4, critical: 4, 无: 0, 低: 1, 中: 2, 高: 3, 紧急: 4 };

/**
 * What a model may get wrong without costing the whole plan: a priority written
 * as a word is read as its level, and an unreadable priority, work type or body
 * falls back to the default instead of failing validation.
 */
const priority = z
  .preprocess((value) => {
    if (typeof value !== "string") return value;
    const word = value.trim().toLowerCase();
    return word in PRIORITY_WORDS ? PRIORITY_WORDS[word] : /^[0-4]$/.test(word) ? Number(word) : undefined;
  }, z.number().int().min(0).max(4).optional())
  .catch(undefined);

export const planSchema = z.object({
  epics: z.array(
    z.object({
      title: z.string().min(1),
      body: z.string().catch(""),
      features: z.array(z.object({ title: z.string().min(1), body: z.string().catch(""), workType: z.enum(["coding", "general"]).optional().catch(undefined), priority })).default([])
    })
  ),
  notes: z.string().optional().catch(undefined)
});
export type Plan = z.infer<typeof planSchema>;

const PLAN_SYSTEM = [
  "You decompose a requirement into a backlog tree: epics, each holding independently deliverable tickets (the JSON field is named features for compatibility). Work may include code, documents, design, media, or offline human activities.",
  "House rules:",
  "- 2–6 epics: broad themes with clear children, no filler.",
  "- Each ticket has one independently deliverable and reviewable outcome. Coding tickets should fit one pull request; general tickets do not require Git, a file, or an agent. Assign workType coding or general to every ticket.",
  "- Titles: imperative, under 80 characters. Bodies: 1–3 sentences of intent, lean.",
  "- Do NOT invent requirements the input does not state; note genuine gaps in `notes` instead.",
  "- Build coding tickets on the tech stack the requirement records. Never choose a stack yourself: when none is recorded, keep ticket titles stack-neutral and say so in `notes`.",
  "- Do not re-propose work the existing backlog already covers.",
  "- priority, when you give one, is an integer: 0 none, 1 low, 2 medium, 3 high, 4 urgent.",
  '- Return JSON: {"epics": [{"title", "body", "features": [{"title", "body", "workType": "coding" | "general", "priority"?: 0-4}]}], "notes"?}'
].join("\n");

/** The language a plan is written in: the person's, which the requirement may not show (an agent can restate it in English). */
export type PlanLanguage = "en" | "zh";
const LANGUAGE_NAME: Record<PlanLanguage, string> = { en: "English", zh: "Simplified Chinese (简体中文)" };

export async function generatePlan(llm: LlmService | null, requirement: string, existing: Item[], language: PlanLanguage = "en"): Promise<Plan> {
  if (!llm) throw new LlmError("planning needs a worker model — configure one in Settings → Assistant");
  const system = `${PLAN_SYSTEM}\n- Write every title, body and note in ${LANGUAGE_NAME[language]}, the person's language, whatever language the requirement is written in. JSON keys and workType values stay in English.`;
  const user = [
    "REQUIREMENT:",
    requirement,
    "",
    "EXISTING BACKLOG (do not duplicate):",
    ...existing.slice(0, 200).map((i) => `- [${i.key}] (${i.kind}) ${i.title}`),
    existing.length ? "" : "- (empty)"
  ].join("\n");
  return llm.completeJson(planSchema, { system, user, purpose: "plan" });
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
          workType: feature.workType,
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
  "- Only items that are genuinely absent. Each has an independently reviewable outcome; only coding work is sized for one pull request. Include required document, design, media, and human work.",
  "- Reason: one sentence explaining the gap.",
  '- Return JSON: {"missing": [{"title", "body"?, "reason"}]}'
].join("\n");

export async function findGaps(llm: LlmService | null, requirement: string, existing: Item[]): Promise<{ title: string; body: string | null; reason: string }[]> {
  if (!llm) throw new LlmError("gap analysis needs a worker model — configure one in Settings → Assistant");
  const user = ["REQUIREMENT:", requirement, "", "EXISTING BACKLOG:", ...existing.slice(0, 300).map((i) => `- [${i.key}] ${i.title}${i.body ? " — " + i.body.slice(0, 100) : ""}`)].join("\n");
  const out = await llm.completeJson(gapSchema, { system: GAP_SYSTEM, user, purpose: "gaps" });
  return out.missing.map((m) => ({ title: m.title, body: m.body ?? null, reason: m.reason }));
}
