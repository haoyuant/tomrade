import { z } from "zod";
import type { NightShiftTicketView, NightShiftView } from "./service.js";
import type { BriefWords } from "./words.js";

export const Judgement = z.object({
  criteria: z.array(z.object({ text: z.string(), met: z.enum(["yes", "no", "unknown"]), evidence: z.string() })),
  outOfScope: z.array(z.string()),
  unverified: z.array(z.string()),
  risk: z.enum(["low", "medium", "high"])
});
export type Judgement = z.infer<typeof Judgement>;

/** What the morning report knows of one delivered ticket: git's word, and the model's when one was asked. */
export interface Delivery {
  prUrl: string | null;
  stat: string | null;
  lines: number | null;
  judgement: Judgement | null;
}

export const judgeSystem = (language: string) =>
  [
    "You check one finished ticket for someone reading a report in the morning, before they review its pull request.",
    "Judge only from what you are given: the ticket, the diff and what the agent said. List each acceptance criterion the ticket states.",
    'A criterion is "yes" only when the material shows it, and evidence names what shows it. When it does not show either way, it is "unknown" with empty evidence. Never guess, and never count an agent saying it is done as proof.',
    "outOfScope: changes the ticket did not ask for. unverified: what nothing here shows was tried or tested. risk: how much a reviewer should look, from what the change touches.",
    `Write every text field in ${language}.`
  ].join("\n");

export const judgeUser = (ticket: { key: string; title: string; body: string | null }, said: string | null, diff: { stat: string; patch: string }) =>
  [`TICKET ${ticket.key}: ${ticket.title}`, (ticket.body ?? "").slice(0, 6000), "", "THE AGENT'S LAST WORD", said ?? "(nothing)", "", "CHANGED FILES", diff.stat, "", "DIFF", diff.patch].join("\n");

const RISK = { high: 0, medium: 1, low: 2 };

/** Riskier first, then bigger; what nothing is known of goes last. */
function reviewOrder(tickets: NightShiftTicketView[], deliveries: Map<string, Delivery>): NightShiftTicketView[] {
  const risk = (t: NightShiftTicketView) => {
    const r = deliveries.get(t.itemId)?.judgement?.risk;
    return r ? RISK[r] : 3;
  };
  const size = (t: NightShiftTicketView) => deliveries.get(t.itemId)?.lines ?? -1;
  return [...tickets].sort((a, b) => risk(a) - risk(b) || size(b) - size(a));
}

function detail(ticket: NightShiftTicketView, delivery: Delivery | undefined, w: BriefWords): string[] {
  const out: string[] = [`### ${ticket.key} ${ticket.title}`];
  if (delivery?.prUrl) out.push(`${w("pullRequest")}: ${delivery.prUrl}`, "");
  if (ticket.note) out.push(ticket.note, "");
  const judged = delivery?.judgement;
  if (!judged) out.push(w("notJudged"), "");
  else {
    const mark = { yes: "✓", no: "✗", unknown: "?" };
    out.push(`${w("riskLabel")}: ${w(judged.risk === "high" ? "riskHigh" : judged.risk === "medium" ? "riskMedium" : "riskLow")}`, "", `**${w("criteria")}**`, "");
    if (!judged.criteria.length) out.push(`- ${w("noCriteria")}`);
    for (const c of judged.criteria) out.push(`- ${mark[c.met]} ${c.text}: ${c.met !== "unknown" && c.evidence ? c.evidence : w("noEvidence")}`);
    out.push("");
    if (judged.outOfScope.length) out.push(`**${w("outOfScope")}**`, "", ...judged.outOfScope.map((x) => `- ${x}`), "");
    if (judged.unverified.length) out.push(`**${w("unverified")}**`, "", ...judged.unverified.map((x) => `- ${x}`), "");
  }
  if (delivery?.stat) out.push("```", delivery.stat, "```", "");
  return out;
}

/** The report itself: plain Markdown, and every section is left out when it has nothing to say. */
export function renderBrief(shift: NightShiftView, deliveries: Map<string, Delivery>, w: BriefWords, dateLabel: string): string {
  const of = (...states: NightShiftTicketView["state"][]) => shift.tickets.filter((t) => states.includes(t.state));
  const minutes = Math.max(1, Math.round(((shift.endedAt ?? shift.startedAt) - shift.startedAt) / 60_000));
  const facts = [
    w("sumDelivered", { n: of("delivered").length }),
    w("sumMerged", { n: of("done").length }),
    w("sumNeedsYou", { n: of("needs-you").length }),
    w("sumFailed", { n: of("failed").length }),
    w("sumSkipped", { n: of("skipped").length }),
    w("sumTook", { minutes }),
    shift.spentUsd > 0 ? w(shift.costKnown ? "sumSpent" : "sumSpentPartly", { amount: `$${shift.spentUsd.toFixed(2)}` }) : w("sumNoCost")
  ];
  const lines = [`# ${w("title", { date: dateLabel })}`, "", facts.join(" · "), ""];
  if (shift.halt) lines.push(w(shift.halt === "stopped" ? "haltStopped" : shift.halt === "deadline" ? "haltDeadline" : shift.halt === "budget" ? "haltBudget" : "haltFailures"), "");
  const toReview = reviewOrder(of("delivered"), deliveries);
  if (toReview.length) {
    lines.push(`## ${w("reviewFirst")}`, "");
    toReview.forEach((t, i) => lines.push(`${i + 1}. ${t.key} ${t.title}${deliveries.get(t.itemId)?.prUrl ? `: ${deliveries.get(t.itemId)!.prUrl}` : ""}`));
    lines.push("");
  }
  const section = (title: string, tickets: NightShiftTicketView[], next?: string) => {
    if (!tickets.length) return;
    lines.push(`## ${title}`, "");
    if (next) lines.push(next, "");
    for (const t of tickets) lines.push(`- ${t.key} ${t.title}${t.note ? `: ${t.note}` : ""}`);
    lines.push("");
  };
  section(w("needsYou"), of("needs-you"), w("needsYouNext"));
  section(w("failed"), of("failed"), w("failedNext"));
  section(w("skipped"), of("skipped"));
  const worked = [...toReview, ...reviewOrder(of("done"), deliveries)];
  if (worked.length) {
    lines.push(`## ${w("details")}`, "");
    for (const t of worked) lines.push(...detail(t, deliveries.get(t.itemId), w));
  }
  return lines.join("\n").trimEnd() + "\n";
}
