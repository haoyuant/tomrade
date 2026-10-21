import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { CardAction, ChecklistCard, Engine, FindingCard, ThreadSummary, TurnInput, TurnIO, TurnResult } from "@tomradex/agent";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/llm";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/settings";
import { BUNDLED, KnownIssue, before, matches, said, type Evidence } from "./issues.js";
import { errorLines, newestFiles, scrub, tail } from "./evidence.js";
import { languageTag, type LanguageTag } from "@tomradex/domain";
import { DOCTOR_WORDS, type Words } from "./words.js";
import { CATALOG_MAX_AGE_MS, fetchCatalog, readCache } from "./catalog.js";
import { CONCLUSION, brief, conclusionCard, investigationMessages, investigationTools, logSources, scopedTools, type Conclusion } from "./investigate.js";
import type {} from "@tomradex/tools";
import { bestEffort, type Check as ContractCheck, type CheckResult as ContractCheckResult, contract, type DoctorChecks, errorMessage, readJsonOr } from "@tomradex/contracts";

/** What a troubleshooting thread is about: a failed turn, or nothing in particular. */
export const Topic = z.object({
  /** The thread whose turn failed, and that turn's run. */
  threadId: z.string().optional(),
  runId: z.string().optional(),
  engineId: z.string().optional(),
  error: z.string().optional(),
  details: z.string().optional()
});
export type Topic = z.infer<typeof Topic>;

export const DoctorOptions = z.object({
  topic: Topic.optional(),
  /** The agent the person asked to look into it; until then each turn checks again. */
  investigator: z.string().optional()
});

export type CheckResult = ContractCheckResult<CardAction>;

/** One thing the troubleshooter looks at. Plugins add their own. */
export type Check = ContractCheck<Words, Topic, CardAction>;

/** Everything one round of checks found, kept for the report. */
export interface Diagnosis {
  topic: Topic;
  at: number;
  version: string;
  rows: { id: string; title: string; state: ChecklistCard["rows"][number]["state"]; line: string; evidence?: string }[];
  facts: Record<string, string>;
  issues: string[];
  findings: FindingCard[];
  logs: { source: string; text: string }[];
  /** The agent that looked into it, once one did. */
  investigator?: string;
}

export interface ReportInclude {
  environment: boolean;
  checks: boolean;
  error: boolean;
  logs: boolean;
  /** The failed conversation itself: off unless the person ticks it. */
  conversation: boolean;
}

export const DEFAULT_INCLUDE: ReportInclude = { environment: true, checks: true, error: true, logs: true, conversation: false };

/** A troubleshooting report is a bug; the person may also write in with feedback or an idea. */
export const REPORT_KINDS = ["bug", "feedback", "idea"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** What reaches Tomrade's developer: the person saw this text, section by section, before it went. */
export interface Report {
  code: string;
  /** Absent: a troubleshooting report, which is a bug. */
  kind?: ReportKind;
  createdAt: string;
  fingerprint: string;
  summary: string;
  engine: string | null;
  app: { version: string; os: string; arch: string; locale: string };
  sections: { id: keyof ReportInclude | "note"; title: string; text: string }[];
}

export interface SendResult {
  code: string;
  state: "sent" | "queued";
  /** Why it waits, when it does. */
  reason?: string;
}

/** Puts a report in Tomrade's backend; the default goes through the signed-in account. */
export type Transport = (report: Report) => Promise<void>;

/** A sent report as the backend holds it: the developer sets its status, reply and fix. */
export interface RemoteReport {
  code: string;
  created_at: string;
  summary: string;
  engine: string | null;
  status: string;
  reply: string | null;
  replied_at: string | null;
  fixed_in: string | null;
}

export interface ReportView {
  code: string;
  kind?: ReportKind;
  createdAt: string;
  summary: string;
  engine: string | null;
  /** queued: still on this machine; sent: gone, its status not read yet; else as the developer set it. */
  status: "queued" | "sent" | "new" | "triaged" | "fixed" | "wontfix" | "duplicate";
  reply?: string;
  repliedAt?: string;
  fixedIn?: string;
  /** Fixed in a release this machine already runs. */
  fixedHere?: boolean;
  /** A reply or a decision the person has not seen yet. */
  unread: boolean;
}

export interface ReportsView {
  signedIn: boolean;
  reports: ReportView[];
  unread: number;
}

export const DoctorConfig = z.object({
  /** Where diagnoses and the outbox live. */
  dataDir: z.string(),
  /** Tomrade's own log folder, as the desktop writes it. */
  logDir: z.string().optional(),
  version: z.string().default("dev"),
  /** Known issues found since this release; data only, refreshed every few hours. Empty: bundled only. */
  catalogUrl: z.string().default("https://tomrade.com/known-issues.json")
});
export type DoctorConfig = z.infer<typeof DoctorConfig>;

declare module "cordis" {
  interface Context {
    doctor: Doctor;
  }
  interface Events {
    /** A report reached the backend, or waits to. */
    "doctor/report"(result: SendResult): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "doctor.start": (projectId: string, from?: { threadId?: string; runId?: string; engineId?: string; error?: string } | null) => { threadId: string };
    "doctor.preview": (projectId: string, threadId: string, include?: Partial<ReportInclude>, note?: string) => Report;
    "doctor.send": (projectId: string, threadId: string, include?: Partial<ReportInclude>, note?: string) => SendResult;
    "doctor.investigate": (projectId: string, threadId: string, engineId: string) => void;
    "doctor.reports": () => ReportsView;
    "doctor.markRead": () => void;
    "doctor.deleteReport": (code: string) => void;
    "doctor.flush": () => number;
    "doctor.feedbackPreview": (kind: ReportKind, text: string) => Report;
    "doctor.sendFeedback": (kind: ReportKind, text: string) => SendResult;
  }
}

const ENGINE_ID = "doctor";
const RETRY_MS = 10 * 60_000;
const ASKED_MAX = 4_000;

const osLine = (): string => {
  const system = (process as { getSystemVersion?: () => string }).getSystemVersion?.();
  const name = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : os.type();
  return `${name} ${system ?? os.release()} ${process.arch}`;
};

/** Digits, hex runs and paths vary between two people hitting the same thing; the rest says what it is. */
export function fingerprint(engine: string | null | undefined, error: string | undefined, issue?: string): string {
  if (issue) return `issue:${issue}`;
  const normal = (error ?? "").toLowerCase().replace(/\/[^\s"']+/g, "/p").replace(/\b[0-9a-f]{8,}\b/g, "x").replace(/\d+/g, "#").slice(0, 300);
  return createHash("sha1").update(`${engine ?? "-"}|${normal}`).digest("hex").slice(0, 12);
}

const newCode = (): string => {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return `R-${[...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join("")}`;
};

export class Doctor extends Service implements DoctorChecks {
  static provide = "doctor";
  static inject = ["agent", "settings"];
  static Config = DoctorConfig;

  private checks = new Map<string, Check>();
  private catalog = new Map<string, KnownIssue>();
  private retryTimer: NodeJS.Timeout | null = null;
  /** Swapped in tests; otherwise the account's backend. */
  transport: Transport | null = null;
  /** Swapped in tests; otherwise the signed-in account's own reports. */
  fetchReports: (() => Promise<RemoteReport[] | null>) | null = null;
  private remote = new Map<string, KnownIssue>();
  private unread = 0;

  constructor(ctx: Context, public config: DoctorConfig) {
    super(ctx, "doctor");
    for (const issue of BUNDLED) this.catalog.set(issue.id, issue);
    for (const check of this.builtInChecks()) this.checks.set(check.id, check);
    fs.mkdirSync(path.join(config.dataDir, "outbox"), { recursive: true });
  }

  [Service.init]() {
    const ctx = this.ctx;
    ctx.agent.engine(this.engine());
    ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("doctor.start", (projectId, from) => ({ threadId: this.start(projectId, from ?? null).id }));
      ctx.ipc.handle("doctor.preview", (projectId, threadId, include, note) => this.report(projectId, threadId, include, note));
      ctx.ipc.handle("doctor.send", (projectId, threadId, include, note) => this.send(projectId, threadId, include, note));
      ctx.ipc.handle("doctor.investigate", (projectId, threadId, engineId) => this.investigate(projectId, threadId, engineId));
      ctx.ipc.handle("doctor.reports", () => this.reports());
      ctx.ipc.handle("doctor.markRead", () => this.markRead());
      ctx.ipc.handle("doctor.deleteReport", (code) => this.deleteReport(code));
      ctx.ipc.handle("doctor.flush", () => this.flush());
      ctx.ipc.handle("doctor.feedbackPreview", (kind, text) => this.feedbackReport(kind, text));
      ctx.ipc.handle("doctor.sendFeedback", (kind, text) => this.sendFeedback(kind, text));
    });
    ctx.inject(["tools"], (ctx) => {
      const host = { ctx: this.ctx, sources: (engineId?: string) => this.sources(engineId), latest: (threadId: string) => this.latest(threadId), recheck: (projectId: string, threadId: string, runId: string) => this.recheck(projectId, threadId, runId) };
      for (const tool of investigationTools(host)) ctx.tools.register(tool);
    });
    ctx.inject(["contributions"], (ctx) => {
      ctx.contributions.command({ id: "doctor.troubleshoot", title: () => this.words()("command"), group: () => this.words()("commandGroup"), run: (scope) => this.troubleshoot(scope.projectId) });
      // On the right, with a bug: diagnostics, not an ordinary setting.
      ctx.contributions.statusItem({ id: "doctor", text: () => this.words()("statusItem"), title: () => this.words()("statusTitle"), command: "doctor.troubleshoot", icon: "i-bug", align: "end" });
      // The developer answered, or decided: said where the person already looks, until they read it.
      ctx.contributions.command({ id: "doctor.reports", title: () => this.words()("reportsCommand"), group: () => this.words()("commandGroup"), run: () => ({ settingsPane: "about" }) });
      ctx.contributions.statusItem({ id: "doctor-replies", text: () => (this.unread ? (this.unread === 1 ? this.words()("statusReply") : this.words()("statusReplies", { n: this.unread })) : null), command: "doctor.reports" });
    });
    // Reports that could not go out try again while the app runs; replies and newer known issues are looked for too.
    for (const issue of readCache(this.catalogFile())?.issues ?? []) this.remote.set(issue.id, issue);
    const first = setTimeout(() => void this.flush().then(() => this.refreshReports()), 30_000);
    first.unref?.();
    const catalog = setTimeout(() => void this.refreshCatalog(), 20_000);
    catalog.unref?.();
    this.retryTimer = setInterval(() => void this.flush().then(() => this.refreshReports()), RETRY_MS);
    this.retryTimer.unref?.();
    const catalogTimer = setInterval(() => void this.refreshCatalog(), CATALOG_MAX_AGE_MS);
    catalogTimer.unref?.();
    ctx.effect(() => () => { clearTimeout(first); clearTimeout(catalog); clearInterval(catalogTimer); if (this.retryTimer) clearInterval(this.retryTimer); });
  }

  locale(): LanguageTag {
    return languageTag(this.ctx.settings.locale());
  }

  words(): Words {
    return DOCTOR_WORDS(this.locale());
  }

  /** A check of a plugin's own — sync, a provider, a service. */
  check(check: Check): () => void {
    this.checks.set(check.id, check);
    return this.ctx.effect(() => () => this.checks.delete(check.id));
  }

  /** A known problem, from a plugin or a newer catalog; a later one with the same id replaces it. */
  issue(issue: KnownIssue): () => void {
    const parsed = KnownIssue.parse(issue);
    const before = this.catalog.get(parsed.id);
    this.catalog.set(parsed.id, parsed);
    return this.ctx.effect(() => () => { if (before) this.catalog.set(parsed.id, before); else this.catalog.delete(parsed.id); });
  }

  /** Bundled and plugin issues, with the fetched catalog's newer word on the same id. */
  issues(): KnownIssue[] {
    const merged = new Map(this.catalog);
    for (const [id, issue] of this.remote) merged.set(id, issue);
    return [...merged.values()];
  }

  private catalogFile(): string {
    return path.join(this.config.dataDir, "catalog.json");
  }

  /** The catalog from tomrade.com, at most every few hours; a failed read keeps what was cached. */
  async refreshCatalog(force = false, fetcher?: typeof fetch): Promise<number> {
    if (!this.config.catalogUrl) return this.remote.size;
    const cached = readCache(this.catalogFile());
    if (!force && cached && Date.now() - cached.fetchedAt < CATALOG_MAX_AGE_MS) return this.remote.size;
    const fetched = await fetchCatalog(this.config.catalogUrl, fetcher);
    if (!fetched) return this.remote.size;
    fs.writeFileSync(this.catalogFile(), JSON.stringify({ fetchedAt: Date.now(), catalog: fetched.raw }));
    this.remote = new Map(fetched.issues.map((issue) => [issue.id, issue]));
    return this.remote.size;
  }

  // ── starting ─────────────────────────────────────────────────────────

  /** A troubleshooting thread: about a failed turn, an engine setup hands over, or nothing in particular — already checking. */
  start(projectId: string, from: { threadId?: string; runId?: string; engineId?: string; error?: string } | null): ThreadSummary {
    const topic: Topic = from?.threadId
      ? this.topicOf(projectId, from.threadId, from.runId)
      : from
        ? { ...(from.engineId ? { engineId: from.engineId } : {}), ...(from.error ? { error: from.error } : {}) }
        : {};
    const words = this.words();
    const engine = topic.engineId ? this.ctx.agent.engineOf(topic.engineId) : undefined;
    const what = engine?.title ?? topic.engineId;
    const thread = this.ctx.agent.newThread(projectId, ENGINE_ID, null, { surface: "doctor", title: words("threadTitle", { what: what ?? words("general") }), options: { topic } });
    this.ctx.agent.send(projectId, thread.id, { kind: "text", text: what ? words("askFailure", { engine: what }) : words("askGeneral") });
    return thread;
  }

  private async troubleshoot(projectId?: string): Promise<{ showThread: string; projectId: string }> {
    const target = projectId ?? this.ctx.get("projects")?.list().filter((p) => !p.archived).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
    if (!target) throw new Error(this.words()("noProject"));
    return { showThread: this.start(target, null).id, projectId: target };
  }

  /** The failed turn: its engine, its error line and details. */
  topicOf(projectId: string, threadId: string, runId?: string): Topic {
    const messages = this.ctx.agent.store.messages(projectId, threadId);
    const failed = [...messages].reverse().find((m) => m.block.type === "error" && (!runId || m.runId === runId));
    const run = failed?.runId ? this.ctx.agent.store.run(projectId, failed.runId) : runId ? this.ctx.agent.store.run(projectId, runId) : null;
    const block = failed?.block.type === "error" ? failed.block : null;
    return {
      threadId,
      ...(run ? { runId: run.id, engineId: run.engine } : {}),
      ...(block ? { error: block.text, ...(block.details ? { details: block.details } : {}) } : run?.error ? { error: run.error } : {})
    };
  }

  // ── the engine ───────────────────────────────────────────────────────

  /**
   * The troubleshooter as an engine: it conducts only the threads it opens
   * (no capabilities, so no picker offers it), and each turn checks again —
   * a checklist that fills in as it goes, then what was found.
   */
  engine(): Engine {
    const doctor = this;
    return {
      id: ENGINE_ID,
      get title() { return doctor.words()("engineTitle"); },
      author: "ai:doctor",
      capabilities: [],
      terminal: { mode: "none" },
      options: DoctorOptions,
      available: async () => ({ ok: true }),
      async turn(input, io) {
        const { topic = {}, investigator } = DoctorOptions.parse(input.options ?? {});
        const said = input.input.kind === "text" ? input.input.text.trim() : "";
        // Once an agent looks into it, the person talks to that agent; "check again" still checks.
        if (investigator && said !== doctor.words()("recheckSay") && doctor.latest(input.threadId)) return doctor.delegate(input, io, investigator);
        const diagnosis = await doctor.runChecks(input.projectId, input.threadId, io.run.id, topic, io.signal);
        if (io.signal.aborted) return { stop: "cancelled" };
        diagnosis.findings.forEach((finding, i) => io.emit({ type: "card", id: `finding-${io.run.id}-${i}`, schema: "finding", title: finding.headline, data: finding }));
        return { stop: "end" };
      }
    };
  }

  // ── checking ─────────────────────────────────────────────────────────

  /** One round of checks inside a run: the checklist card fills in, the diagnosis is kept for the report. */
  async runChecks(projectId: string, threadId: string, runId: string, topic: Topic, signal?: AbortSignal, cardId = `checks-${runId}`): Promise<Diagnosis> {
    const card = (rows: ChecklistCard["rows"]) => this.ctx.agent.setCard(runId, { id: cardId, schema: "checklist", title: this.words()("checksTitle"), data: { rows } satisfies ChecklistCard });
    const diagnosis = await this.diagnose(projectId, topic, card, signal);
    if (!signal?.aborted) this.save(threadId, diagnosis);
    return diagnosis;
  }

  async recheck(projectId: string, threadId: string, runId: string): Promise<Diagnosis> {
    const topic = this.latest(threadId)?.topic ?? {};
    return this.runChecks(projectId, threadId, runId, topic, undefined, `checks-${runId}-${Date.now()}`);
  }

  async sources(engineId?: string) {
    return logSources(this.ctx, this.config.logDir, engineId);
  }

  // ── investigating ────────────────────────────────────────────────────

  /** Agents that could look into it: ready, able to hold a conversation, and not the one that failed. */
  async investigators(topic: Topic): Promise<string[]> {
    const engines = this.ctx.agent.allEngines().filter((e) => e.id !== ENGINE_ID && e.id !== (topic.engineId && this.ctx.agent.answering(topic.engineId)) && e.terminal?.mode !== "only" && (e.capabilities ?? ["backlog"]).includes("backlog"));
    const states = await Promise.all(engines.map(async (e) => ({ id: e.id, ok: (await e.available().catch(() => null))?.ok === true })));
    return states.filter((s) => s.ok).map((s) => s.id);
  }

  /** The person picked an agent to look into it: the thread remembers it, and the agent starts. */
  investigate(projectId: string, threadId: string, engineId: string): void {
    const thread = this.ctx.agent.store.thread(projectId, threadId);
    if (thread?.surface !== "doctor") throw new Error("Not a troubleshooting conversation");
    const engine = this.ctx.agent.engineOf(engineId);
    if (!engine || engineId === ENGINE_ID) throw new Error(`No agent "${engineId}"`);
    const options = DoctorOptions.parse(thread.options ?? {});
    this.ctx.agent.setOptions(projectId, threadId, { ...options, investigator: engineId });
    this.ctx.agent.send(projectId, threadId, { kind: "text", text: this.words()("investigateAsk", { title: engine.title }) });
  }

  private stateFile(threadId: string): string {
    return path.join(this.config.dataDir, `${threadId.replace(/[^\w-]/g, "")}.investigation.json`);
  }

  /** Hands the turn to the investigating agent: its own turn, held to the investigation's tools. */
  async delegate(input: TurnInput, io: TurnIO, engineId: string): Promise<TurnResult> {
    const words = this.words();
    const engine = this.ctx.agent.engineOf(engineId);
    const diagnosis = this.latest(input.threadId);
    if (!engine || !diagnosis) return { stop: "error", error: words("noInvestigator") };
    const state = await engine.available().catch(() => null);
    if (!state?.ok) return { stop: "error", error: `${words("noInvestigator")} ${state?.reason ?? ""}`.trim() };
    let saved: { engineId: string; startSeq: number; resume?: string } | null = null;
    try { saved = JSON.parse(fs.readFileSync(this.stateFile(input.threadId), "utf8")); } catch {}
    const trigger = input.messages.at(-1)?.seq ?? 0;
    const session = saved && saved.engineId === engineId ? saved : { engineId, startSeq: trigger };
    const failing = diagnosis.topic.engineId ? this.engineTitle(diagnosis.topic.engineId) : null;
    const text = brief(diagnosis, failing, this.locale());
    const messages = investigationMessages(input.messages, session.startSeq, text);
    const first = !session.resume && messages.length <= 1;
    const raw = this.ctx.agent.optionsOf({ options: null }, engineId);
    const result = await engine.turn(
      {
        ...input,
        purpose: "backlog",
        permissionMode: undefined,
        options: engine.options ? engine.options.parse(raw) : raw,
        messages,
        cards: [],
        input: first && input.input.kind === "text" ? { ...input.input, text: `${text}\n\n== The person ==\n${input.input.text}` } : input.input
      },
      { ...io, tools: scopedTools(io), ...(session.resume ? { resume: session.resume } : { resume: undefined }) }
    );
    fs.writeFileSync(this.stateFile(input.threadId), JSON.stringify({ ...session, ...(result.resume ? { resume: result.resume } : {}) }));
    const conclusion = io.run.scratch.get(CONCLUSION) as Conclusion | undefined;
    if (conclusion) {
      const card = conclusionCard(conclusion, [...this.actionsFor(diagnosis.topic, conclusion.offer), { kind: "report", label: words("actionReport") }]);
      io.emit({ type: "card", id: `finding-${io.run.id}-conclusion`, schema: "finding", title: card.headline, data: card });
      this.save(input.threadId, { ...diagnosis, findings: [...diagnosis.findings, card], investigator: engineId });
    }
    const { resume: _resume, ...rest } = result;
    return rest;
  }

  /** What a known issue or a conclusion offers, as buttons about this topic. */
  private actionsFor(topic: Topic, offer: KnownIssue["offer"]): CardAction[] {
    const words = this.words();
    const engine = topic.engineId ? this.engineTitle(topic.engineId) : null;
    const retryWith: CardAction | null = topic.threadId ? { kind: "retry-with", threadId: topic.threadId, ...(topic.engineId ? { exclude: topic.engineId } : {}), label: words("actionRetryWith") } : null;
    return offer.flatMap((o): CardAction[] => {
      if (o === "retry-with") return retryWith ? [retryWith] : [];
      if (o === "recheck") return [{ kind: "say", text: words("recheckSay"), label: words("actionRecheck") }];
      if (!topic.engineId) return o === "settings" ? [{ kind: "settings", label: words("actionModelSettings") }] : [];
      if (o === "sign-in") return [{ kind: "sign-in", engineId: topic.engineId, label: words("actionSignIn", { engine: engine! }) }];
      if (o === "install") return [{ kind: "install", engineId: topic.engineId, label: words("actionInstall", { engine: engine! }) }];
      return [{ kind: "settings", engineId: topic.engineId, label: words("actionSettings", { engine: engine! }) }];
    });
  }

  async diagnose(projectId: string, topic: Topic, show: (rows: ChecklistCard["rows"]) => void = () => {}, signal: AbortSignal = new AbortController().signal): Promise<Diagnosis> {
    const words = this.words();
    const applicable = await this.checksFor(topic);
    // A test turn is the slow one: it goes last, after everything quick has said its piece.
    const probe = topic.engineId ? { id: "probe", title: () => words("checkProbe", { title: this.engineTitle(topic.engineId!) }) } : null;
    const rows: ChecklistCard["rows"] = [...applicable, ...(probe ? [probe] : [])].map((c) => ({ id: c.id, title: c.title(words), state: "pending" }));
    const evidence: Record<string, string | undefined> = {};
    const facts: Record<string, string> = { version: this.config.version, os: osLine(), locale: this.locale() };
    const actions = new Map<string, CardAction[]>();
    const set = (id: string, result: { state: ChecklistCard["rows"][number]["state"]; line?: string }) => {
      const row = rows.find((r) => r.id === id)!;
      row.state = result.state;
      if (result.line !== undefined) row.line = result.line;
      show(rows.map((r) => ({ ...r })));
    };
    show(rows.map((r) => ({ ...r })));
    for (const check of applicable) {
      if (signal.aborted) break;
      set(check.id, { state: "running" });
      let result: CheckResult;
      try {
        result = await check.run(topic, signal);
      } catch (error) {
        result = { state: "warn", line: errorMessage(error) };
      }
      set(check.id, result);
      Object.assign(facts, result.facts ?? {});
      if (result.evidence) evidence[check.id] = scrub(result.evidence);
      if (result.actions?.length) actions.set(check.id, result.actions);
    }
    let probeResult: Awaited<ReturnType<Doctor["probe"]>> | null = null;
    if (probe && !signal.aborted) {
      // An agent that is not set up, or a model that does not answer, fails the same way again: no turn needed to see it.
      const ready = !rows.some((r) => (r.id === `engine:${topic.engineId}` || r.id === "models") && r.state === "fail");
      if (!ready) set("probe", { state: "skip", line: words("probeSkipped") });
      else {
        set("probe", { state: "running" });
        probeResult = await this.probe(projectId, topic.engineId!, signal);
        set("probe", probeResult.ok ? { state: "ok", line: words("probeOk", { seconds: (probeResult.ms / 1000).toFixed(1) }) } : { state: "fail", line: words("probeFailed", { error: probeResult.error ?? "" }) });
        if (!probeResult.ok) evidence.probe = scrub([probeResult.error, probeResult.details].filter(Boolean).join("\n\n"));
      }
    }
    const engineFacts = topic.engineId ? await this.engineFacts(topic.engineId) : {};
    Object.assign(facts, engineFacts);
    const texts = [topic.error, topic.details, probeResult?.error, probeResult?.details].filter((t): t is string => !!t);
    const known: Evidence = { engineId: topic.engineId, texts, facts, version: this.config.version };
    const issues = this.issues().filter((issue) => matches(issue, known));
    const findings = this.findings(topic, rows, actions, issues, probeResult, await this.investigators(topic));
    return {
      topic,
      at: Date.now(),
      version: this.config.version,
      rows: rows.map((r) => ({ id: r.id, title: r.title, state: r.state, line: r.line ?? "", ...(evidence[r.id] ? { evidence: evidence[r.id] } : {}) })),
      // A plugin's check may hand back a non-string fact.
      facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, scrub(String(v))])),
      issues: issues.map((i) => i.id),
      findings,
      logs: await this.logs(topic.engineId)
    };
  }

  private engineTitle(id: string): string {
    return this.ctx.agent.engineOf(id)?.title ?? id;
  }

  private async engineFacts(engineId: string): Promise<Record<string, string>> {
    try {
      const facts = await this.ctx.agent.engineOf(engineId)?.local?.diagnostics?.facts?.();
      return Object.fromEntries(Object.entries(facts ?? {}).map(([k, v]) => [`${engineId}.${k}`, String(v)]).concat(Object.entries(facts ?? {}).map(([k, v]) => [k, String(v)])));
    } catch {
      return {};
    }
  }

  /** Tails of Tomrade's newest log and the failing agent's own. */
  private async logs(engineId?: string): Promise<Diagnosis["logs"]> {
    const out: Diagnosis["logs"] = [];
    const sources = await this.sources(engineId);
    // Tomrade's newest log only, its errors first; each of the agent's own logs as it ends.
    for (const source of [...sources.filter((s) => s.id.startsWith("tomrade/")).slice(0, 1), ...sources.filter((s) => !s.id.startsWith("tomrade/"))]) {
      const text = tail(source.file);
      if (!text) continue;
      out.push({ source: source.id, text: source.id.startsWith("tomrade/") ? [...errorLines(text), "…", ...text.split("\n").slice(-40)].join("\n") : text });
    }
    return out;
  }

  /** One real turn on the engine: does it answer now? */
  async probe(projectId: string, engineId: string, signal: AbortSignal): Promise<{ ok: boolean; ms: number; error?: string; details?: string }> {
    const { ok, ms, error, details } = await this.ctx.agent.tryEngine(projectId, engineId, signal);
    return { ok, ms, ...(error ? { error } : {}), ...(details ? { details } : {}) };
  }

  private findings(topic: Topic, rows: ChecklistCard["rows"], actions: Map<string, CardAction[]>, issues: KnownIssue[], probe: { ok: boolean } | null, investigators: string[] = []): FindingCard[] {
    const words = this.words();
    const locale = this.locale();
    const engine = topic.engineId ? this.engineTitle(topic.engineId) : null;
    const retryWith: CardAction | null = topic.threadId ? { kind: "retry-with", threadId: topic.threadId, ...(topic.engineId ? { exclude: topic.engineId } : {}), label: words("actionRetryWith") } : null;
    const out: FindingCard[] = issues.map((issue) => ({ tone: "fail", headline: said(issue.title, locale), body: said(issue.explain, locale), confidence: issue.confidence, actions: this.actionsFor(topic, issue.offer) }));
    for (const row of rows) {
      if ((row.state !== "fail" && row.state !== "warn") || row.id === "probe") continue;
      out.push({ tone: row.state, headline: `${row.title}: ${row.line ?? ""}`, actions: actions.get(row.id) ?? [] });
    }
    if (probe && !probe.ok && !issues.length) out.push({ tone: "fail", headline: words("stillFailing", { engine: engine! }), body: rows.find((r) => r.id === "probe")?.line, actions: retryWith ? [retryWith] : [] });
    if (!out.length && probe?.ok && topic.error) out.push({ tone: "ok", headline: words("recovered", { engine: engine! }), body: words("recoveredBody"), actions: topic.threadId && topic.engineId ? [{ kind: "retry-with", threadId: topic.threadId, label: words("actionRetryWith") }] : [] });
    if (!out.length) out.push({ tone: "ok", headline: words("nothingFound"), body: words("nothingFoundBody"), actions: [] });
    // Whatever was found, the last card says how to look again and how to tell the developer.
    const last = out[out.length - 1]!;
    if (topic.engineId && !issues.length && out.some((f) => f.tone !== "ok") && retryWith && !last.actions.some((a) => a.kind === "retry-with")) last.actions.push(retryWith);
    // Something left to explain, and another agent to explain it: it may look, once the person says so.
    if (investigators.length && out.some((f) => f.tone !== "ok")) last.actions.push({ kind: "investigate", engineIds: investigators, note: words("investigateNote"), label: words("actionInvestigate") });
    last.actions.push({ kind: "say", text: words("recheckSay"), label: words("actionRecheck") }, { kind: "report", label: words("actionReport") });
    return out;
  }

  /** Tomrade itself first, then the agents in question, then everything else that applies. */
  private async checksFor(topic: Topic): Promise<Check[]> {
    const applicable = [...this.checks.values()].filter((c) => c.applies?.(topic) ?? true);
    const engines = (await this.engineIdsFor(topic)).map((id) => this.engineCheck(id));
    return [...applicable.filter((c) => c.id === "app"), ...engines, ...applicable.filter((c) => c.id !== "app")];
  }

  /** The failing engine; with no topic, every agent the person has installed — a missing one is not a problem. */
  private async engineIdsFor(topic: Topic): Promise<string[]> {
    const engines = this.ctx.agent.allEngines().filter((e) => !e.usesModels && e.terminal?.mode !== "only" && (e.capabilities ?? ["backlog"]).length > 0);
    if (topic.engineId) return engines.some((e) => e.id === topic.engineId) ? [topic.engineId] : [];
    const states = await Promise.all(engines.map(async (e) => ({ e, state: await e.available().catch(() => null) })));
    return states.filter(({ state }) => state && (state.ok || (state.cli && state.cli.state !== "missing"))).map(({ e }) => e.id);
  }

  private engineCheck(id: string): Check {
    const doctor = this;
    return {
      id: `engine:${id}`,
      title: () => doctor.engineTitle(id),
      async run() {
        const words = doctor.words();
        const engine = doctor.ctx.agent.engineOf(id);
        if (!engine) return { state: "fail", line: id };
        const state = await engine.available({ fresh: true });
        const cli = state.cli;
        const facts: Record<string, string> = {
          [`${id}.ready`]: String(state.ok),
          ...(cli?.path ? { [`${id}.cli`]: cli.path } : {}),
          ...(cli?.version ? { [`${id}.version`]: cli.version } : {}),
          ...(cli?.source ? { [`${id}.source`]: cli.source } : {})
        };
        if (state.ok) {
          const found = cli?.path ? `${words("engineReady")} · ${(cli.version ? words("cliFoundVersion", { path: cli.path, version: cli.version }) : words("cliFound", { path: cli.path }))}` : words("engineReady");
          // Found and signed in is not yet working: the remembered test message settles it (TOM-503).
          const tried = doctor.ctx.agent.triedWith(id);
          if (tried && !tried.ok) {
            return {
              state: "warn",
              line: words("engineTriedFailed", { detail: (tried.error ?? "").slice(0, 160) }),
              facts: { ...facts, [`${id}.tried`]: "failed" },
              actions: [{ kind: "settings", engineId: id, label: words("actionSettings", { engine: engine.title }) }],
              ...(tried.error ? { evidence: tried.error } : {})
            };
          }
          return { state: "ok", line: tried?.ok ? `${found} · ${words("engineAnswered")}` : found, facts: { ...facts, ...(tried?.ok ? { [`${id}.tried`]: "ok" } : {}) } };
        }
        const actions: CardAction[] =
          state.need === "install" && (state.setup ?? engine.local?.setup)?.install.length ? [{ kind: "install", engineId: id, label: words("actionInstall", { engine: engine.title }) }]
          : state.need === "sign-in" && engine.local?.setup?.signIn ? [{ kind: "sign-in", engineId: id, label: words("actionSignIn", { engine: engine.title }) }]
          : state.need === "model" ? [{ kind: "settings", label: words("actionModelSettings") }]
          : [{ kind: "settings", engineId: id, label: words("actionSettings", { engine: engine.title }) }];
        const tried = cli?.attempts?.map((a) => `${a.path} (${a.source}): ${a.ok ? "ok" : "failed"} — ${a.detail}`).join("\n");
        return { state: "fail", line: state.reason ?? id, facts, actions, ...(tried ? { evidence: tried } : {}) };
      }
    };
  }

  private builtInChecks(): Check[] {
    const doctor = this;
    const usesModels = (topic: Topic) => !topic.engineId || !!doctor.ctx.agent.engineOf(topic.engineId)?.usesModels;
    return [
      {
        id: "app",
        title: (w) => w("checkApp"),
        async run() {
          const proxy = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"].filter((k) => process.env[k]).join(",");
          return { state: "ok", line: doctor.words()("appLine", { version: doctor.config.version, os: osLine() }), facts: { proxy: proxy || "none", arch: process.arch } };
        }
      },
      {
        id: "models",
        title: (w) => w("checkModels"),
        applies: usesModels,
        async run(): Promise<CheckResult> {
          const words = doctor.words();
          const llm = doctor.ctx.get("llm");
          const profiles = ((doctor.ctx.settings.get().models as { profiles?: { id: string; title?: string; model: string }[] } | undefined)?.profiles ?? []).slice(0, 3);
          if (!llm || !profiles.length) return { state: "warn", line: words("noProfiles"), actions: [{ kind: "settings", label: words("actionModelSettings") }] };
          const tests = await Promise.all(profiles.map(async (p) => ({ p, test: await llm.test(p as Parameters<typeof llm.test>[0]) })));
          const failed = tests.flatMap((t) => (t.test.ok ? [] : [{ p: t.p, kind: t.test.kind, detail: t.test.detail }]));
          const models = profiles.map((p) => p.model).join(",");
          if (!failed.length) return { state: "ok", line: (profiles.length === 1 ? words("modelOk") : words("modelsOk", { n: profiles.length })), facts: { models } };
          const first = failed[0]!;
          return {
            state: failed.length === tests.length ? "fail" : "warn",
            line: words("modelFails", { title: first.p.title || first.p.model, detail: first.detail.slice(0, 160) }),
            facts: { models, modelError: first.kind },
            actions: [{ kind: "settings", label: words("actionModelSettings") }],
            evidence: failed.map((f) => `${f.p.title || f.p.model}: ${f.detail}`).join("\n")
          };
        }
      },
      {
        id: "mcp",
        title: (w) => w("checkMcp"),
        applies: (topic) => !topic.engineId || !usesModels(topic),
        async run() {
          const words = doctor.words();
          const url = contract(doctor.ctx, "mcp")?.url;
          return url ? { state: "ok", line: words("mcpOn", { url }) } : { state: "fail", line: words("mcpOff") };
        }
      },
      {
        id: "sync",
        title: (w) => w("checkSync"),
        applies: (topic) => !topic.engineId,
        async run() {
          const words = doctor.words();
          const hub = contract(doctor.ctx, "cloudHub");
          if (!hub) return { state: "skip", line: words("syncOff") };
          const info = hub.info();
          if (!info.user) return { state: "warn", line: words("syncOff") };
          const { state, detail } = info.status;
          const status = detail ? `${state} (${detail})` : state;
          return { state: /error|unavailable|diverged/.test(state) ? "warn" : "ok", line: (info.pending ? words("syncStatePending", { status, pending: info.pending }) : words("syncState", { status })), facts: { sync: state } };
        }
      }
    ];
  }

  // ── the report ───────────────────────────────────────────────────────

  private file(threadId: string): string {
    return path.join(this.config.dataDir, `${threadId.replace(/[^\w-]/g, "")}.json`);
  }

  private save(threadId: string, diagnosis: Diagnosis): void {
    fs.writeFileSync(this.file(threadId), JSON.stringify(diagnosis));
  }

  latest(threadId: string): Diagnosis | null {
    try { return JSON.parse(fs.readFileSync(this.file(threadId), "utf8")) as Diagnosis; } catch { return null; }
  }

  /** The report about a troubleshooting thread, exactly as it would be sent. */
  report(projectId: string, threadId: string, include: Partial<ReportInclude> = {}, note = ""): Report {
    const wanted = { ...DEFAULT_INCLUDE, ...include };
    const diagnosis = this.latest(threadId);
    const topic = diagnosis?.topic ?? {};
    const words = this.words();
    const sections: Report["sections"] = [];
    const add = (id: Report["sections"][number]["id"], title: string, text: string) => { if (text.trim()) sections.push({ id, title, text: scrub(text) }); };
    if (note.trim()) add("note", words("sectionNote"), note.trim());
    if (wanted.error && (topic.error || topic.details)) add("error", words("sectionError"), [topic.engineId ? `engine: ${topic.engineId}` : "", topic.error ?? "", topic.details ?? ""].filter(Boolean).join("\n\n"));
    if (wanted.checks && diagnosis) {
      add("checks", words("sectionChecks"), [
        ...diagnosis.rows.map((r) => `[${r.state}] ${r.title}: ${r.line}${r.evidence ? `\n    ${r.evidence.split("\n").join("\n    ")}` : ""}`),
        ...(diagnosis.issues.length ? ["", `known issues: ${diagnosis.issues.join(", ")}`] : []),
        "",
        ...diagnosis.findings.map((f) => `${f.tone.toUpperCase()} ${f.headline}${f.confidence ? ` (${f.confidence})` : ""}`)
      ].join("\n"));
    }
    if (wanted.environment && diagnosis) add("environment", words("sectionEnvironment"), Object.entries(diagnosis.facts).map(([k, v]) => `${k}: ${v}`).join("\n"));
    if (wanted.logs && diagnosis?.logs.length) add("logs", words("sectionLogs"), diagnosis.logs.map((l) => `── ${l.source} ──\n${l.text}`).join("\n\n"));
    if (wanted.conversation) {
      const conversation = [
        ...(topic.threadId ? this.transcript(projectId, topic.threadId) : []),
        ...(topic.threadId ? ["", "── troubleshooting ──"] : []),
        ...this.transcript(projectId, threadId)
      ].join("\n");
      add("conversation", words("sectionConversation"), conversation);
    }
    const issue = diagnosis?.issues[0];
    return {
      code: newCode(),
      createdAt: new Date().toISOString(),
      fingerprint: fingerprint(topic.engineId, topic.error, issue),
      summary: (diagnosis?.findings[0]?.headline ?? topic.error ?? note.trim() ?? "").slice(0, 200),
      engine: topic.engineId ?? null,
      app: { version: this.config.version, os: osLine(), arch: process.arch, locale: this.locale() },
      sections
    };
  }

  private transcript(projectId: string, threadId: string): string[] {
    return this.ctx.agent.store.messages(projectId, threadId).slice(-30).flatMap((m) => {
      const b = m.block;
      const text = b.type === "text" || b.type === "note" || b.type === "status" ? b.text : b.type === "error" ? `ERROR ${b.text}` : b.type === "card" ? `[${b.schema}] ${b.title}` : b.type === "trace" ? `(tool ${b.tool}: ${b.ok ? "ok" : "failed"})` : null;
      return text ? [`${m.role}: ${text.slice(0, ASKED_MAX)}`] : [];
    });
  }

  /** What the person wrote in, with nothing else read from this machine but the app's version and system. */
  feedbackReport(kind: ReportKind, text: string): Report {
    if (!(REPORT_KINDS as readonly string[]).includes(kind)) throw new Error(`Not a kind of report: ${String(kind)}`);
    const body = scrub(text.trim());
    if (!body) throw new Error(this.words()("writeSomething"));
    const words = this.words();
    return {
      code: newCode(),
      kind,
      createdAt: new Date().toISOString(),
      // each one is its own: two people's ideas are not one failure
      fingerprint: `${kind}:${createHash("sha1").update(body).digest("hex").slice(0, 12)}`,
      summary: body.split("\n")[0]!.slice(0, 200),
      engine: null,
      app: { version: this.config.version, os: osLine(), arch: process.arch, locale: this.locale() },
      sections: [{ id: "note", title: words("sectionNote"), text: body }]
    };
  }

  /** Feedback goes the way reports go: kept in the outbox until the backend has it, then answered under My reports. */
  sendFeedback(kind: ReportKind, text: string): Promise<SendResult> {
    return this.dispatch(this.feedbackReport(kind, text));
  }

  /** Saved first, then sent: a report the backend can't take yet waits in the outbox and goes later. */
  async send(projectId: string, threadId: string, include: Partial<ReportInclude> = {}, note = ""): Promise<SendResult> {
    return this.dispatch(this.report(projectId, threadId, include, note));
  }

  private async dispatch(report: Report): Promise<SendResult> {
    const file = path.join(this.config.dataDir, "outbox", `${report.code}.json`);
    fs.writeFileSync(file, JSON.stringify(report));
    const result = await this.deliver(report, file);
    this.ctx.emit("doctor/report", result);
    return result;
  }

  private async deliver(report: Report, file: string): Promise<SendResult> {
    try {
      await (this.transport ?? this.backend())(report);
      fs.rmSync(file, { force: true });
      this.remember(report);
      return { code: report.code, state: "sent" };
    } catch (error) {
      return { code: report.code, state: "queued", reason: errorMessage(error) };
    }
  }

  /** Whatever waits in the outbox, oldest first. */
  async flush(): Promise<number> {
    const dir = path.join(this.config.dataDir, "outbox");
    let sent = 0;
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
      const file = path.join(dir, name);
      let report: Report;
      try { report = JSON.parse(fs.readFileSync(file, "utf8")) as Report; } catch { continue; }
      const result = await this.deliver(report, file);
      if (result.state !== "sent") break;
      sent++;
      this.ctx.emit("doctor/report", result);
    }
    return sent;
  }

  pending(): number {
    const dir = path.join(this.config.dataDir, "outbox");
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")).length : 0;
  }

  // ── my reports ───────────────────────────────────────────────────────

  private signedIn(): boolean {
    const hub = contract(this.ctx, "cloudHub");
    return !!this.fetchReports || !!hub?.info().user;
  }

  private async remoteReports(): Promise<RemoteReport[] | null> {
    if (this.fetchReports) return this.fetchReports();
    const hub = contract(this.ctx, "cloudHub");
    if (!hub?.info().user) return null;
    const { data, error } = await hub.client.from("tomrade_diagnostic_reports").select("code, created_at, summary, engine, status, reply, replied_at, fixed_in").order("created_at", { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []) as RemoteReport[];
  }

  private readJson<T>(name: string, fallback: T): T {
    return readJsonOr(path.join(this.config.dataDir, name), fallback);
  }

  /** What the person last saw of each report; a newer reply or decision reads as unread. */
  private stamp(r: RemoteReport): string | null {
    return r.reply || ["fixed", "wontfix", "duplicate"].includes(r.status) ? `${r.status}|${r.replied_at ?? ""}|${r.fixed_in ?? ""}` : null;
  }

  /** Every report this person sent from here or anywhere, newest first: waiting, sent, answered. */
  async reports(): Promise<ReportsView> {
    const outbox = path.join(this.config.dataDir, "outbox");
    const queued: ReportView[] = (fs.existsSync(outbox) ? fs.readdirSync(outbox) : []).flatMap((name) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(outbox, name), "utf8")) as Report;
        return [{ code: r.code, ...(r.kind ? { kind: r.kind } : {}), createdAt: r.createdAt, summary: r.summary, engine: r.engine, status: "queued" as const, unread: false }];
      } catch { return []; }
    });
    const sent = this.readJson<{ code: string; kind?: ReportKind; at: string; summary: string; engine: string | null }[]>("sent.json", []);
    const kindOf = new Map(sent.flatMap((s) => (s.kind ? [[s.code, s.kind] as const] : [])));
    let remote: RemoteReport[] | null = null;
    try { remote = await this.remoteReports(); } catch {}
    const seen = this.readJson<Record<string, string>>("seen.json", {});
    const byCode = new Map<string, ReportView>();
    for (const s of sent) byCode.set(s.code, { code: s.code, ...(s.kind ? { kind: s.kind } : {}), createdAt: s.at, summary: s.summary, engine: s.engine, status: "sent", unread: false });
    for (const r of remote ?? []) {
      const stamp = this.stamp(r);
      byCode.set(r.code, {
        code: r.code, ...(kindOf.has(r.code) ? { kind: kindOf.get(r.code)! } : {}), createdAt: r.created_at, summary: r.summary, engine: r.engine,
        status: (["new", "triaged", "fixed", "wontfix", "duplicate"].includes(r.status) ? r.status : "new") as ReportView["status"],
        ...(r.reply ? { reply: r.reply } : {}), ...(r.replied_at ? { repliedAt: r.replied_at } : {}),
        ...(r.fixed_in ? { fixedIn: r.fixed_in, fixedHere: !before(this.config.version, r.fixed_in) } : {}),
        unread: !!stamp && seen[r.code] !== stamp
      });
    }
    const reports = [...queued, ...byCode.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.setUnread(reports.filter((r) => r.unread).length);
    return { signedIn: this.signedIn(), reports, unread: this.unread };
  }

  async refreshReports(): Promise<void> {
    if (this.signedIn()) await bestEffort(this.reports(), this.ctx.logger, "refreshing my reports");
  }

  private setUnread(n: number): void {
    if (n === this.unread) return;
    this.unread = n;
    this.ctx.get("ipc")?.send("contributions.changed");
  }

  /** The person opened their reports: what is there now is seen. */
  async markRead(): Promise<void> {
    let remote: RemoteReport[] | null = null;
    try { remote = await this.remoteReports(); } catch {}
    const seen = this.readJson<Record<string, string>>("seen.json", {});
    for (const r of remote ?? []) {
      const stamp = this.stamp(r);
      if (stamp) seen[r.code] = stamp;
    }
    fs.writeFileSync(path.join(this.config.dataDir, "seen.json"), JSON.stringify(seen));
    this.setUnread(0);
  }

  /** Gone from this machine and, when signed in, from the backend too. */
  async deleteReport(code: string): Promise<void> {
    if (!/^R-[0-9A-Z]{6}$/.test(code)) throw new Error(`Not a report code: ${code}`);
    const hub = contract(this.ctx, "cloudHub");
    if (hub?.info().user) {
      const { error } = await hub.client.from("tomrade_diagnostic_reports").delete().eq("code", code);
      if (error) throw new Error(error.message);
    }
    fs.rmSync(path.join(this.config.dataDir, "outbox", `${code}.json`), { force: true });
    const sent = this.readJson<{ code: string }[]>("sent.json", []).filter((s) => s.code !== code);
    fs.writeFileSync(path.join(this.config.dataDir, "sent.json"), JSON.stringify(sent));
  }

  private remember(report: Report): void {
    const file = path.join(this.config.dataDir, "sent.json");
    let sent: { code: string; kind?: ReportKind; at: string; summary: string; engine: string | null }[] = [];
    try { sent = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    sent.unshift({ code: report.code, ...(report.kind ? { kind: report.kind } : {}), at: report.createdAt, summary: report.summary, engine: report.engine });
    fs.writeFileSync(file, JSON.stringify(sent.slice(0, 200)));
  }

  private backend(): Transport {
    return async (report) => {
      const hub = contract(this.ctx, "cloudHub");
      if (!hub) throw new Error("no account service");
      if (!hub.info().user) throw new Error("not signed in");
      const { error } = await hub.client.rpc("tomrade_submit_diagnostic_report", {
        p_code: report.code,
        p_fingerprint: report.fingerprint,
        p_summary: report.summary,
        p_engine: report.engine,
        p_app_version: report.app.version,
        p_platform: `${report.app.os}`,
        p_report: report,
        // only feedback names a kind, so troubleshooting reports still reach a backend from before kinds
        ...(report.kind ? { p_kind: report.kind } : {})
      });
      if (error) throw new Error(error.message);
    };
  }
}
