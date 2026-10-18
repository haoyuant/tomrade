import { z } from "zod";
import type { LanguageTag } from "@tomradex/domain";
import { SCHEDULE_WORDS } from "./words.js";

/** One ticket a template makes. Defaults suit a to-do as well as a coding task: General, on To Do. */
export const TicketSpec = z.object({
  /** `{date}`, `{weekday}`, `{week}`, `{month}`, `{year}` are filled in when it runs. */
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(""),
  workType: z.enum(["coding", "general"]).default("general"),
  status: z.enum(["backlog", "todo"]).default("todo"),
  priority: z.number().int().min(0).max(4).default(2),
  labels: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  /** The workstream; null is the project's first. */
  boardId: z.string().nullable().default(null),
  /** Start it as soon as it exists: a General ticket with the assistant, a coding one in the app. */
  start: z.boolean().default(false)
});
export type TicketSpec = z.output<typeof TicketSpec>;

export const Action = z.discriminatedUnion("kind", [
  /** One or more tickets — a day's to-do, a week's chores, a release checklist. */
  z.object({ kind: z.literal("tickets"), items: z.array(TicketSpec).min(1).max(20) }),
  /** A prompt to the assistant, in a conversation of its own. */
  z.object({
    kind: z.literal("assistant"),
    prompt: z.string().trim().min(1).max(20_000),
    /** Null is the assistant's default engine. */
    engine: z.string().nullable().default(null),
    /** Engine knobs for the conversation: model, effort. */
    options: z.record(z.string(), z.unknown()).nullable().default(null)
  })
]);
export type Action = z.output<typeof Action>;

export const TemplateInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  action: Action
});
export type TemplateInput = z.input<typeof TemplateInput>;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO week, Monday-first: 2026-W42. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${pad(Math.ceil(((t.getTime() - start.getTime()) / 86_400_000 + 1) / 7))}`;
}

/** `{date}` 2026-10-12, `{weekday}` Monday / 周一, `{week}` 2026-W42, `{month}` 2026-10, `{year}` 2026 — on this machine's calendar. */
export function fillTemplate(text: string, at: number, locale: LanguageTag = "en"): string {
  const d = new Date(at);
  return text
    .replaceAll("{date}", `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    .replaceAll("{weekday}", SCHEDULE_WORDS(locale)(WEEKDAYS[d.getDay()]!))
    .replaceAll("{week}", isoWeek(d))
    .replaceAll("{month}", `${d.getFullYear()}-${pad(d.getMonth() + 1)}`)
    .replaceAll("{year}", String(d.getFullYear()));
}
