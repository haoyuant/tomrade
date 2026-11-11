import { z } from "zod";
import type { Item } from "@tomradex/domain";
import type { NodeConfig } from "./rules.js";

export const RuleWhen = z.object({
  label: z.string().optional(),
  workType: z.enum(["coding", "general"]).optional(),
  /** This priority or higher: 0 none, 1 low, 2 medium, 3 high, 4 urgent. */
  minPriority: z.number().int().min(0).max(4).optional(),
  titleHas: z.string().optional()
});

export const RuleThen = z.object({
  /** Left out of the plan's suggestion; a person who ticks it anyway still runs it. */
  skip: z.boolean().optional(),
  mode: z.enum(["terminal", "run"]).optional(),
  engine: z.string().min(1).optional(),
  permissionMode: z.string().min(1).optional(),
  autoMerge: z.boolean().optional(),
  /** Computers, by name, this work is never sent to. */
  notOn: z.array(z.string().min(1).max(80)).max(20).optional()
});

export const WorkRule = z.object({ id: z.string().min(1), name: z.string().min(1), when: RuleWhen, then: RuleThen });
export type WorkRule = z.infer<typeof WorkRule>;
export const WorkRules = z.array(WorkRule).max(50);

const has = (text: string, part: string) => text.toLowerCase().includes(part.toLowerCase());

/** Every condition set must hold; a rule that sets none matches nothing, so a half-made rule cannot take the whole backlog. */
function holds(when: WorkRule["when"], item: Item): boolean {
  const label = when.label?.trim();
  const title = when.titleHas?.trim();
  if (!label && !title && when.workType === undefined && when.minPriority === undefined) return false;
  if (label && !item.labels.some((l) => l.toLowerCase() === label.toLowerCase())) return false;
  if (title && !has(item.title, title)) return false;
  if (when.workType !== undefined && item.workType !== when.workType) return false;
  return when.minPriority === undefined || item.priority >= when.minPriority;
}

/** Rules run top to bottom and the first that matches is the one: their order is how the person ranks them. */
export const ruleFor = (rules: readonly WorkRule[], item: Item): WorkRule | null => rules.find((rule) => holds(rule.when, item)) ?? null;

/** The computers a ticket is never sent to: every rule that matches it adds its own, whichever rule sets how it runs. */
export const keptFrom = (rules: readonly WorkRule[], item: Item): string[] => [...new Set(rules.filter((rule) => holds(rule.when, item)).flatMap((rule) => rule.then.notOn ?? []))];

export function ruleConfig(rule: WorkRule): NodeConfig {
  const { mode, engine, permissionMode, autoMerge } = rule.then;
  return { ...(mode ? { mode } : {}), ...(engine ? { engine } : {}), ...(permissionMode ? { permissionMode } : {}), ...(autoMerge !== undefined ? { autoMerge } : {}) };
}
