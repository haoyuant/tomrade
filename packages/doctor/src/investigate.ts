import path from "node:path";
import { z } from "zod";
import type { Context } from "cordis";
import type { CardAction, FindingCard, ThreadMessage, TurnIO } from "@tomradex/agent";
import { defineTool, type ToolInvocation } from "@tomradex/tools";
import { errorLines, newestFiles, scrub, tail } from "./evidence.js";
import type { Diagnosis } from "./service.js";

/** What the investigating agent may call: it reads, looks up, asks and concludes — never changes the setup or the work. */
export const INVESTIGATION_TOOLS = new Set(["doctor_read_log", "doctor_check_again", "doctor_conclude", "ask_user", "web_search", "web_fetch"]);

export const CONCLUSION = "doctor/conclusion";

export const Conclusion = z.object({
  headline: z.string().min(1).max(200).describe("The cause, in one plain sentence in the person's language"),
  explanation: z.string().max(1500).optional().describe("Why you think so, and what to do — in the person's language, no jargon"),
  confidence: z.enum(["high", "medium", "low"]).describe("high only when the evidence shows it; low for a guess"),
  offer: z.array(z.enum(["sign-in", "install", "settings", "retry-with", "recheck"])).max(4).default([])
    .describe("Buttons to offer: sign in to / install / open the settings of the failing agent, carry on with another agent, check again")
});
export type Conclusion = z.infer<typeof Conclusion>;

const LOG_LINES = 400;
const LOG_CHARS = 64_000;
const BRIEF_LOG_CHARS = 16_000;

export interface LogSource {
  id: string;
  file: string;
}

/** The troubleshooting thread a call belongs to, or why it may not make it. */
function doctorRun(ctx: Context, tool: string, inv: ToolInvocation) {
  const run = inv.run;
  const thread = run ? ctx.agent.store.thread(run.projectId, run.threadId) : null;
  if (!run || thread?.surface !== "doctor") throw new Error(`${tool} works only inside a troubleshooting conversation`);
  return { run, thread };
}

export interface InvestigationHost {
  ctx: Context;
  sources(engineId?: string): Promise<LogSource[]>;
  latest(threadId: string): Diagnosis | null;
  recheck(projectId: string, threadId: string, runId: string): Promise<Diagnosis>;
}

/** The tools a troubleshooting run gets; every other tool is refused inside one. */
export function investigationTools(host: InvestigationHost) {
  const { ctx } = host;
  return [
    defineTool({
      name: "doctor_read_log",
      surface: "doctor",
      title: "Read a log the troubleshooter may read",
      description: "Read more of a log that belongs to this troubleshooting: Tomrade's own, or the failing agent's. Without `source` it lists the sources. Keys, the home folder and email addresses come back masked.",
      input: z.object({ source: z.string().optional(), lines: z.number().int().min(10).max(LOG_LINES).optional() }),
      async execute({ source, lines }, inv) {
        const { thread } = doctorRun(ctx, "doctor_read_log", inv);
        const topic = host.latest(thread.id)?.topic;
        const sources = await host.sources(topic?.engineId);
        if (!source) return { sources: sources.map((s) => s.id) };
        const found = sources.find((s) => s.id === source);
        if (!found) throw new Error(`No log "${source}" here — call doctor_read_log without source to list them`);
        return tail(found.file, lines ?? 200, LOG_CHARS) ?? "(empty or unreadable)";
      }
    }),
    defineTool({
      name: "doctor_check_again",
      surface: "doctor",
      title: "Run the troubleshooting checks again",
      description: "Check everything again — the agent, its sign-in, the models, a real test turn — and get the results. Takes up to a minute and a half; use it to see whether something changed.",
      input: z.object({}),
      async execute(_args, inv) {
        const { run } = doctorRun(ctx, "doctor_check_again", inv);
        const diagnosis = await host.recheck(run.projectId, run.threadId, run.id);
        return diagnosis.rows.map((r) => `[${r.state}] ${r.title}: ${r.line}`).join("\n");
      }
    }),
    defineTool({
      name: "doctor_conclude",
      surface: "doctor",
      title: "Say what the problem is",
      description: "Record what you found: the cause, why, how sure you are, and which buttons to offer the person. Call it once, when you know enough; then tell the person the same in two or three short sentences.",
      input: Conclusion,
      async execute(args, inv) {
        const { run } = doctorRun(ctx, "doctor_conclude", inv);
        run.scratch.set(CONCLUSION, args);
        return "Noted — the person sees it as a card with those buttons.";
      }
    })
  ];
}

/** Tomrade's newest log and the failing agent's own, by the names the tools use. */
export async function logSources(ctx: Context, logDir: string | undefined, engineId?: string): Promise<LogSource[]> {
  const out: LogSource[] = [];
  if (logDir) for (const file of newestFiles(logDir, (n) => n.endsWith(".log"), 2)) out.push({ id: `tomrade/${path.basename(file)}`, file });
  const engine = engineId ? ctx.agent.engineOf(engineId) : undefined;
  let files: string[] = [];
  try { files = (await engine?.diagnostics?.logs?.()) ?? []; } catch {}
  for (const file of files.slice(0, 3)) out.push({ id: `${engineId}/${path.basename(file)}`, file });
  return out;
}

/** The investigating agent's first message: the job, the house rules, and every piece of evidence the checks gathered. */
export function brief(diagnosis: Diagnosis, failing: string | null, locale: "en" | "zh"): string {
  const topic = diagnosis.topic;
  let logs = diagnosis.logs.map((l) => `── ${l.source} ──\n${[...errorLines(l.text, 20), "…", ...l.text.split("\n").slice(-40)].join("\n")}`).join("\n\n");
  if (logs.length > BRIEF_LOG_CHARS) logs = `${logs.slice(0, BRIEF_LOG_CHARS)}\n… (more with doctor_read_log)`;
  return scrub([
    "You are troubleshooting the person's Tomrade, a desktop app that runs AI agents on their backlog.",
    failing ? `The agent "${failing}" failed; you are a different agent, asked to find out why and what they can do.` : "They asked for a general check of their setup.",
    "",
    "How to work:",
    "- Work from the evidence below. doctor_read_log reads more of a log, doctor_check_again runs the checks again (with a real test turn), web_search can look up an error message. Nothing else is available here, and you must not change their setup, files or tickets.",
    "- If only the person can tell you something (which edition, which network, what they changed), ask with ask_user.",
    "- When you know enough, call doctor_conclude once: the cause in one sentence, what to do, how sure you are, and which buttons to offer. Then say the same to the person in two or three short sentences.",
    "- Say plainly when the evidence does not settle it. A guess is marked low.",
    `- Write to the person in ${locale === "zh" ? "Chinese" : "English"}.`,
    "",
    "== The error ==",
    topic.error ? [topic.engineId ? `engine: ${topic.engineId}` : "", topic.error, topic.details ?? ""].filter(Boolean).join("\n") : "(no failed turn — a general check)",
    "",
    "== Checks ==",
    ...diagnosis.rows.map((r) => `[${r.state}] ${r.title}: ${r.line}${r.evidence ? `\n    ${r.evidence.split("\n").slice(0, 12).join("\n    ")}` : ""}`),
    "",
    "== Facts ==",
    ...Object.entries(diagnosis.facts).map(([k, v]) => `${k}: ${v}`),
    ...(diagnosis.issues.length ? ["", "== Known issues that matched ==", ...diagnosis.findings.filter((f) => f.confidence).map((f) => `${f.headline} (${f.confidence}): ${f.body ?? ""}`)] : []),
    "",
    "== Log excerpts ==",
    logs || "(none)"
  ].join("\n"));
}

/**
 * The person's side of the investigation so far, as the investigating agent
 * sees it: the brief folded into the first message, then each exchange.
 */
export function investigationMessages(messages: ThreadMessage[], startSeq: number, briefText: string): ThreadMessage[] {
  const slice = messages.filter((m) => m.seq >= startSeq && (m.block.type === "text" || m.block.type === "question"));
  const first = slice[0];
  if (!first || first.block.type !== "text") return slice;
  return [{ ...first, block: { ...first.block, text: `${briefText}\n\n== The person ==\n${first.block.text}` } }, ...slice.slice(1)];
}

/** The run's tools, cut down to the investigation's own. */
export function scopedTools(io: TurnIO): TurnIO["tools"] {
  return {
    describe: () => io.tools.describe().filter((t) => INVESTIGATION_TOOLS.has(t.name)),
    execute: (name, args) => (INVESTIGATION_TOOLS.has(name) ? io.tools.execute(name, args) : Promise.reject(new Error(`${name} is not available while troubleshooting — read, look up, ask and conclude only`)))
  };
}

export function conclusionCard(conclusion: Conclusion, actions: CardAction[]): FindingCard {
  return { tone: conclusion.confidence === "high" ? "fail" : "warn", headline: conclusion.headline, ...(conclusion.explanation ? { body: conclusion.explanation } : {}), confidence: conclusion.confidence, actions };
}
