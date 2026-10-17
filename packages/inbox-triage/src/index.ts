import type { Context } from "cordis";
import { z } from "zod";
import { wordsLocale, type Item, type Priority, type WordsLocale } from "@tomradex/domain";
import { overlap } from "@tomradex/agent-backlog";
import type { InboxEntry, InboxKind, TriageSuggestion } from "@tomradex/inbox";
import type {} from "@tomradex/items";
import type { LLMProvider, LlmService } from "@tomradex/llm";
import type {} from "@tomradex/settings";
import { TRIAGE_WORDS } from "./words.js";

export const name = "inbox-triage";
export const inject = ["inbox", "items", "llm", "settings"];

/** The language the model is asked to write in: prompt text, not words. */
const LANGUAGE: Record<WordsLocale, string> = { en: "English", zh: "Simplified Chinese" };

/** How many tickets and entries the model weighs; the rest are too unlike to matter. */
const TICKETS = 8;
const ENTRIES = 5;

const answerSchema = z.object({
  action: z.enum(["accept", "merge", "duplicate"]),
  target: z.string().nullable().optional(),
  kind: z.enum(["bug", "feedback", "idea"]),
  priority: z.number().int().min(0).max(4),
  title: z.string(),
  reason: z.string(),
  reply: z.string().nullable().optional()
});

const SYSTEM = (language: string, canReply: boolean) =>
  [
    "You pre-triage one piece of user feedback for a product backlog. A person confirms or changes what you propose.",
    "Decide ONE action:",
    '- "merge": it asks for the same thing as one of the TICKETS (the same requirement or the same bug, not merely the same area). target = that ticket\'s label (T1…).',
    '- "duplicate": it repeats one of the other untriaged ENTRIES and no ticket fits. target = that entry\'s label (E1…).',
    '- "accept": anything else — it becomes a new ticket. target = null.',
    "kind: bug (something is broken), idea (a new capability), feedback (anything else).",
    "priority: 0 none, 1 low, 2 medium, 3 high (blocks real work, many affected), 4 urgent (data loss, crash on start, security).",
    "title: a short, specific ticket title in the feedback's own language, without prefixes like 'Bug:'.",
    `reason: one sentence, in ${language}, saying why.`,
    canReply
      ? "reply: a short, friendly answer to whoever wrote it, in the feedback's own language: thank them, say what happens next (tracked, already tracked, or a duplicate). Promise no dates. null only when nothing needs saying."
      : "reply: null (this source takes no replies).",
    'Return JSON only: {"action","target","kind","priority","title","reason","reply"}'
  ].join("\n");

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The tickets and other entries worth showing the model, nearest first. */
export function candidates(entry: InboxEntry, items: Item[], entries: InboxEntry[]): { tickets: Item[]; entries: InboxEntry[] } {
  const text = `${entry.title}\n${entry.body}`;
  const score = (title: string, body: string) => Math.max(overlap(entry.title, title), overlap(text, `${title}\n${body}`) * 0.8);
  const near = <T>(list: T[], of: (x: T) => number, n: number) =>
    list
      .map((x) => ({ x, s: of(x) }))
      .filter((c) => c.s > 0.1)
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .map((c) => c.x);
  return {
    tickets: near(
      items.filter((i) => i.kind === "ticket" && i.status !== "cancelled"),
      (i) => score(i.title, i.body ?? ""),
      TICKETS
    ),
    entries: near(
      entries.filter((e) => e.id !== entry.id && e.status === "new"),
      (e) => score(e.title, e.body),
      ENTRIES
    )
  };
}

/** One worker-model call: what to do with the entry, given what it may repeat. */
export async function suggest(
  llm: LLMProvider,
  entry: InboxEntry,
  scope: { canReply: boolean; items: Item[]; entries: InboxEntry[]; locale: WordsLocale }
): Promise<TriageSuggestion> {
  const near = candidates(entry, scope.items, scope.entries);
  const tickets = new Map(near.tickets.map((t, i) => [`T${i + 1}`, t]));
  const others = new Map(near.entries.map((e, i) => [`E${i + 1}`, e]));
  const user = [
    "FEEDBACK",
    `kind given by the source: ${entry.kind}`,
    `title: ${entry.title}`,
    entry.body.trim() ? `body:\n${clip(entry.body.trim(), 4000)}` : "",
    "",
    "TICKETS",
    ...(tickets.size ? [...tickets].map(([label, t]) => `- ${label} [${t.key}, ${t.status}] ${t.title}${t.body ? ` — ${clip(t.body.replace(/\s+/g, " "), 200)}` : ""}`) : ["- (none)"]),
    "",
    "ENTRIES",
    ...(others.size ? [...others].map(([label, e]) => `- ${label} ${e.title}${e.body ? ` — ${clip(e.body.replace(/\s+/g, " "), 200)}` : ""}`) : ["- (none)"])
  ].join("\n");
  const out = await llm.completeJson(answerSchema, { system: SYSTEM(LANGUAGE[scope.locale], scope.canReply), user, maxTokens: 1500, timeoutMs: 120_000, purpose: "inbox" });
  const target = out.target ?? null;
  const ticket = out.action === "merge" && target ? tickets.get(target) : undefined;
  const other = out.action === "duplicate" && target ? others.get(target) : undefined;
  return {
    action: ticket ? "merge" : other ? "duplicate" : "accept",
    kind: out.kind as InboxKind,
    priority: out.priority as Priority,
    title: out.title.trim() || entry.title,
    itemId: ticket?.id ?? null,
    duplicateOf: other?.id ?? null,
    reason: out.reason.trim(),
    reply: scope.canReply ? out.reply?.trim() || null : null
  };
}

export function apply(ctx: Context) {
  const locale = (): WordsLocale => wordsLocale(ctx.settings.locale?.());
  const llm = (): LlmService => ctx.llm;
  ctx.inbox.triager({
    id: "worker",
    title: () => TRIAGE_WORDS(locale())("title"),
    available: async () => {
      const worker = await llm().worker();
      return worker.ok ? null : (worker.reason ?? null);
    },
    suggest: (entry, scope) => suggest(llm(), entry, { canReply: scope.canReply, items: ctx.items.list({ projectId: scope.projectId }), entries: scope.entries, locale: locale() })
  });
}
