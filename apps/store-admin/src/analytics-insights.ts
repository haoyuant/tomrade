import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { PARTS, windowStart, type DashboardData, type Filters, type Part } from "./analytics-data.js";

/** What the analyst returns: the shape `claude -p --json-schema` is held to. */
export interface Insights {
  summary: string;
  highlights: { title: string; detail: string; tone: "good" | "bad" | "neutral" }[];
  anomalies: { title: string; detail: string }[];
  suggestions: { title: string; detail: string; priority: "high" | "medium" | "low" }[];
}
export interface InsightsEntry {
  region: Filters["region"]; days: number; lang: Filters["lang"]; from: string; to: string;
  generated_at: string; cost_usd: number | null; insights: Insights;
  /** The aggregates the analyst read, kept so the analysis can be sent on with its data; absent in older files. */
  input?: unknown;
}
/** What the page shows: the analysis for this view (or the newest one), the last failure, and whether one is running. */
export interface InsightsState {
  entry: InsightsEntry | null;
  error: { at: string; kind: "failed" | "unavailable" } | null;
  running: boolean;
}
export interface InsightsService {
  read(f: Filters): Promise<InsightsState>;
  generate(f: Filters): Promise<void>;
}
export type Analyst = (system: string, prompt: string) => Promise<{ insights: Insights; cost_usd: number | null }>;
export class AnalystUnavailable extends Error {}

const item = (extra: Record<string, unknown>) => ({
  type: "object", additionalProperties: false,
  properties: { title: { type: "string" }, detail: { type: "string" }, ...extra },
  required: ["title", "detail", ...Object.keys(extra)]
});
export const INSIGHTS_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string" },
    highlights: { type: "array", items: item({ tone: { type: "string", enum: ["good", "bad", "neutral"] } }) },
    anomalies: { type: "array", items: item({}) },
    suggestions: { type: "array", items: item({ priority: { type: "string", enum: ["high", "medium", "low"] } }) }
  },
  required: ["summary", "highlights", "anomalies", "suggestions"]
};

const minutes = (ms: number) => Math.round(ms / 6000) / 10;
const searchCounts = (r: { clicks: number; impressions: number; position_sum: number }) =>
  ({ clicks: r.clicks, impressions: r.impressions, average_position: r.impressions ? Math.round(r.position_sum / r.impressions * 10) / 10 : null });
/** The numbers the analyst reads: aggregates only, never an ID (the RPCs return none). */
export function insightsInput(f: Filters, current: DashboardData, previous: DashboardData) {
  const summary = (d: DashboardData, detailed: boolean) => ({
    totals: { active_ids: d.report.totals.aai, active_minutes: minutes(d.report.totals.duration_ms), uses: d.report.totals.uses },
    ...(detailed ? { daily: d.report.daily.map((r) => ({ day: r.day, active_ids: r.aai, active_minutes: minutes(r.duration_ms), uses: r.uses })) } : {}),
    features: [...d.report.features].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, detailed ? 30 : 15)
      .map((r) => ({ feature: r.feature_id, active_minutes: minutes(r.duration_ms), uses: r.uses, active_ids: r.aai })),
    ...(detailed ? { next_day_retention: d.report.retention.map((r) => ({ cohort_day: r.day, first_seen: r.cohort, returned_next_day: r.d1 })) } : {}),
    activation: d.activation,
    site: d.site ? { totals: d.site.totals, platforms: d.site.platforms, ...(detailed ? { daily: d.site.daily } : {}) } : null,
    accounts: d.accounts ? { total_at_end: d.accounts.total, confirmed_at_end: d.accounts.confirmed, new_in_period: d.accounts.new } : null,
    usage_by_platform: d.platforms.map((p) => ({ platform: p.platform, active_ids: p.aai, active_minutes: minutes(p.duration_ms) })),
    search: d.search ? {
      totals: searchCounts(d.search.totals),
      ...(detailed ? { daily: d.search.daily.map((r) => ({ day: r.day, ...searchCounts(r) })) } : {}),
      top_queries: d.search.queries.slice(0, detailed ? 15 : 5).map((r) => ({ query: r.key, ...searchCounts(r) })),
      top_pages: d.search.pages.slice(0, detailed ? 10 : 5).map((r) => ({ page: r.key, ...searchCounts(r) }))
    } : null,
    github: d.github ? {
      views: d.github.totals.views, clones: d.github.totals.clones,
      stars_at_start: d.github.first?.stars ?? null, stars_at_end: d.github.last?.stars ?? null, forks: d.github.last?.forks ?? null,
      ...(detailed ? {
        daily: d.github.daily.map(({ day, views, view_uniques, clones }) => ({ day, views, unique_visitors: view_uniques, clones })),
        last_14_days: d.github.last ? { as_of: d.github.last.day, referrers: d.github.last.referrers, popular_paths: d.github.last.paths.map(({ path, count, uniques }) => ({ path, count, uniques })) } : null
      } : {})
    } : null
  });
  const prevTo = new Date(Date.parse(f.from) - 86400000).toISOString().slice(0, 10);
  return {
    period: { from: f.from, to: f.to, days: f.days, region: f.region, last_day_incomplete: true },
    previous_period: { from: windowStart(prevTo, f.days), to: prevTo },
    current: summary(current, true),
    previous: summary(previous, false)
  };
}

export function insightsSystem(lang: Filters["lang"]): string {
  return [
    "You are the product analyst for Tomrade, an open-source desktop app where a developer keeps a backlog of tickets and hands them to AI coding agents (Claude Code and others) that branch, open pull requests and merge.",
    "You receive the internal usage dashboard's aggregates for one period and the period of equal length before it, as JSON. Definitions:",
    "- active_ids: anonymous installation IDs active in the period (installations, not people; IDs from two deployments are summed, not joined).",
    "- active_minutes: foreground active time; uses: counted feature uses. Features are named like area.feature.",
    "- activation: installations first seen in the period, followed to now; each funnel step counts those that also reached every step before it (installs → setup_done → start = first ticket started in Tomrade or claimed from a terminal → open_pr → merge). first_start is the median time to the first ticket start or claim; merged_7d and week_return only count installations old enough.",
    "- next_day_retention: of IDs first seen on a day, how many came back the next day; the last day or two are not yet observable.",
    "- site: tomrade.com installer downloads (installs), updater downloads (updates), page views and visits, copied daily from Cloudflare up to yesterday. accounts: registered accounts (no region).",
    "- search: Google Search Console for tomrade.com (clicks, impressions, average position, lower is better; top queries and landing pages); the last few days are still revised. github: the app repository's views, clones and stars; GitHub keeps traffic for 14 days, so earlier days may be missing. Neither has a region, and either may be null when not set up.",
    "- The period's last day is still in progress. A day missing from a series is a gap, not a zero. Small numbers are noisy: say so instead of over-reading them.",
    "Write for the founder, who runs the product alone. Be concrete: cite the numbers and the change against the previous period. highlights: 3 to 6 key observations. anomalies: only real outliers, drops or data problems (empty when there are none). suggestions: 3 to 6 actions worth doing next, each tied to the numbers, most valuable first.",
    "Keep summary to two or three sentences. Do not invent data that is not in the input.",
    lang === "zh" ? "Write every string in Simplified Chinese; keep feature names and metric names as they appear." : "Write every string in English."
  ].join("\n");
}

/** The local Claude Code CLI as the analyst: no tools, no MCP servers, no settings, a system prompt of our own, structured output. */
export function claudeAnalyst(options: { command?: string; model?: string; timeoutMs?: number } = {}): Analyst {
  const command = options.command ?? process.env.TOMRADE_ANALYTICS_CLAUDE ?? "claude";
  const model = options.model ?? process.env.TOMRADE_ANALYTICS_MODEL;
  return (system, prompt) => new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "",
      "--system-prompt", system, "--json-schema", JSON.stringify(INSIGHTS_SCHEMA), ...(model ? ["--model", model] : [])];
    // The dashboard's service-role keys stay with the dashboard.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SUPABASE_")));
    const child = spawn(command, args, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 240000);
    child.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); reject(error.code === "ENOENT" ? new AnalystUnavailable(command) : error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(out) as { is_error?: boolean; structured_output?: unknown; total_cost_usd?: number };
        if (code !== 0 || result.is_error) throw new Error("analyst failed");
        resolve({ insights: checked(result.structured_output), cost_usd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null });
      } catch (error) { reject(error); }
    });
    child.stdin.end(prompt);
  });
}

/** The schema is enforced by the CLI; this keeps a malformed answer from reaching the page, and caps its size. */
export function checked(value: unknown): Insights {
  const text = (v: unknown) => { if (typeof v !== "string") throw new Error("insights shape"); return v.slice(0, 2000); };
  const list = <T>(v: unknown, map: (row: Record<string, unknown>) => T) => {
    if (!Array.isArray(v)) throw new Error("insights shape");
    return v.slice(0, 10).map((row) => map(row as Record<string, unknown>));
  };
  const one = <T extends string>(v: unknown, options: readonly T[]) => (options.includes(v as T) ? v as T : options.at(-1)!);
  const o = value as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("insights shape");
  return {
    summary: text(o.summary),
    highlights: list(o.highlights, (r) => ({ title: text(r.title), detail: text(r.detail), tone: one(r.tone, ["good", "bad", "neutral"] as const) })),
    anomalies: list(o.anomalies, (r) => ({ title: text(r.title), detail: text(r.detail) })),
    suggestions: list(o.suggestions, (r) => ({ title: text(r.title), detail: text(r.detail), priority: one(r.priority, ["high", "medium", "low"] as const) }))
  };
}

export const insightsFile = () => path.join(process.env.TOMRADE_ANALYTICS_STATE_DIR ?? path.join(homedir(), ".tomrade-store"), "analytics-insights.json");
const keyOf = (f: { region: string; days: number }) => `${f.region}/${f.days}`;

/**
 * Analyses kept per region and window in one local file, so the last one shows on the next start.
 * Generation runs only when asked; a second request for a view already being analysed waits for that run.
 */
export function insightsService(deps: {
  load: (f: Pick<Filters, "from" | "to" | "region">, parts: ReadonlySet<Part>) => Promise<DashboardData>;
  analyst: Analyst; file?: string; now?: () => Date;
}): InsightsService {
  const file = deps.file ?? insightsFile();
  const now = deps.now ?? (() => new Date());
  const running = new Map<string, Promise<void>>();
  const errors = new Map<string, InsightsState["error"]>();
  const readAll = async (): Promise<Record<string, InsightsEntry>> => {
    try { return (JSON.parse(await readFile(file, "utf8")) as { entries?: Record<string, InsightsEntry> }).entries ?? {}; }
    catch { return {}; }
  };
  const run = async (f: Filters) => {
    const key = keyOf(f);
    try {
      // Everything but the per-feature daily series, which is large and already summed in the features.
      const parts = new Set(PARTS.filter((p) => p !== "days"));
      const prevTo = new Date(Date.parse(f.from) - 86400000).toISOString().slice(0, 10);
      const [current, previous] = await Promise.all([
        deps.load(f, parts),
        deps.load({ region: f.region, from: windowStart(prevTo, f.days), to: prevTo }, parts)
      ]);
      const input = insightsInput(f, current, previous);
      const { insights, cost_usd } = await deps.analyst(insightsSystem(f.lang), JSON.stringify(input));
      const entries = await readAll();
      entries[key] = { region: f.region, days: f.days, lang: f.lang, from: f.from, to: f.to, generated_at: now().toISOString(), cost_usd, insights, input };
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, entries }, null, 2), { mode: 0o600 });
      await rename(temp, file);
      errors.delete(key);
    } catch (error) {
      errors.set(key, { at: now().toISOString(), kind: error instanceof AnalystUnavailable ? "unavailable" : "failed" });
    }
  };
  return {
    async read(f) {
      const entries = Object.values(await readAll());
      const exact = entries.find((e) => keyOf(e) === keyOf(f));
      const newest = entries.sort((a, b) => b.generated_at.localeCompare(a.generated_at))[0];
      const entry = exact ?? newest ?? null;
      const error = errors.get(keyOf(f)) ?? null;
      return { entry, error: error && (!exact || error.at > exact.generated_at) ? error : null, running: running.has(keyOf(f)) };
    },
    generate(f) {
      const key = keyOf(f);
      const existing = running.get(key);
      if (existing) return existing;
      const job = run(f).finally(() => running.delete(key));
      running.set(key, job);
      return job;
    }
  };
}
