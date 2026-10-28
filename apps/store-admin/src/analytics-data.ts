export const regions = ["all", "cn", "apac", "eu", "na", "other"] as const;
export interface Filters {
  days: 7 | 30 | 90;
  region: typeof regions[number];
  metric: "duration_ms" | "uses";
  feature: string;
  lang: "en" | "zh";
  from: string;
  to: string;
}
export function filters(params: URLSearchParams, now = new Date()): Filters {
  const days = Number(params.get("days") ?? 30);
  const region = params.get("region") ?? "all";
  const metric = params.get("metric") ?? "duration_ms";
  const lang = params.get("lang") ?? "zh";
  if (![7, 30, 90].includes(days) || !regions.some((r) => r === region) || !["duration_ms", "uses"].includes(metric) || !["en", "zh"].includes(lang)) throw new Error("filters");
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(to) - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { days, region, metric, lang, feature: params.get("feature") ?? "", from, to } as Filters;
}
export interface Metrics { duration_ms: number; uses: number; aai: number }
export interface Report {
  totals: Metrics;
  daily: (Metrics & { day: string })[];
  features: (Metrics & { feature_id: string })[];
  retention: { day: string; cohort: number; d1: number }[];
  latest: string | null;
}
export interface FeatureDay { day: string; feature_id: string; region: string; duration_ms: number; uses: number }
/** tomrade_analytics_activation: the installs first seen in the range, followed up to now. */
export interface Activation {
  funnel: { installs: number; setup_done: number; start: number; open_pr: number; merge: number };
  first_start: { median_ms: number | null; n: number };
  merged_7d: { cohort: number; merged: number };
  week_return: { cohort: number; returned: number };
}
export const FUNNEL_STEPS = ["installs", "setup_done", "start", "open_pr", "merge"] as const;
export interface DashboardData { report: Report; days: FeatureDay[]; activation: Activation }
export interface Endpoint { url: string; key: string }
export function endpoints(env: NodeJS.ProcessEnv): Endpoint[] {
  const result: Endpoint[] = [];
  for (const suffix of ["", "_CN"]) {
    const url = env[`SUPABASE_URL${suffix}`];
    const key = env[`SUPABASE_SERVICE_ROLE_KEY${suffix}`];
    if (!url && !key) continue;
    if (!url || !key) throw new Error(`Configure SUPABASE_URL${suffix} and SUPABASE_SERVICE_ROLE_KEY${suffix}`);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) throw new Error("Use HTTPS for analytics endpoints");
    if (result.some((e) => e.url === parsed.origin)) throw new Error("Analytics endpoints must be distinct");
    result.push({ url: parsed.origin, key });
  }
  if (!result.length) throw new Error("Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return result;
}
export async function loadDashboard(sources: Endpoint[], f: Filters, request: typeof fetch = fetch): Promise<DashboardData> {
  const rpc = async <T>(source: Endpoint, name: string): Promise<T> => {
    const response = await request(`${source.url}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { apikey: source.key, Authorization: `Bearer ${source.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_from: f.from, p_to: f.to, p_region: f.region === "all" ? null : f.region }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error("analytics query failed");
    return response.json() as Promise<T>;
  };
  const rows = await Promise.all(sources.map(async (source) => {
    const [report, series, activation] = await Promise.all([
      rpc<Report>(source, "tomrade_analytics_report"),
      rpc<{ days: FeatureDay[] }>(source, "tomrade_analytics_feature_days"),
      rpc<Activation>(source, "tomrade_analytics_activation")
    ]);
    return { report, days: series.days, activation };
  }));
  return mergeReports(rows);
}
export function mergeReports(rows: DashboardData[]): DashboardData {
  const report: Report = { totals: { duration_ms: 0, uses: 0, aai: 0 }, daily: [], features: [], retention: [], latest: null };
  const daily = new Map<string, Report["daily"][number]>();
  const features = new Map<string, Report["features"][number]>();
  const retention = new Map<string, Report["retention"][number]>();
  const days = new Map<string, FeatureDay>();
  const activation: Activation = {
    funnel: { installs: 0, setup_done: 0, start: 0, open_pr: 0, merge: 0 },
    first_start: { median_ms: null, n: 0 },
    merged_7d: { cohort: 0, merged: 0 },
    week_return: { cohort: 0, returned: 0 }
  };
  // Medians do not add: across deployments, each one's median weighted by how many it covers.
  let startWeighted = 0;
  const add = (a: Metrics, b: Metrics) => { a.duration_ms += b.duration_ms; a.uses += b.uses; a.aai += b.aai; };
  for (const row of rows) {
    add(report.totals, row.report.totals);
    for (const d of row.report.daily) {
      const target = daily.get(d.day) ?? { day: d.day, duration_ms: 0, uses: 0, aai: 0 };
      add(target, d); daily.set(d.day, target);
    }
    for (const d of row.report.features) {
      const target = features.get(d.feature_id) ?? { feature_id: d.feature_id, duration_ms: 0, uses: 0, aai: 0 };
      add(target, d); features.set(d.feature_id, target);
    }
    for (const d of row.report.retention) {
      const target = retention.get(d.day) ?? { day: d.day, cohort: 0, d1: 0 };
      target.cohort += d.cohort; target.d1 += d.d1; retention.set(d.day, target);
    }
    for (const d of row.days) {
      const key = `${d.day}/${d.feature_id}`;
      const target = days.get(key) ?? { ...d, region: "all", duration_ms: 0, uses: 0 };
      target.duration_ms += d.duration_ms; target.uses += d.uses; days.set(key, target);
    }
    for (const step of FUNNEL_STEPS) activation.funnel[step] += row.activation.funnel[step];
    if (row.activation.first_start.median_ms !== null && row.activation.first_start.n) {
      startWeighted += row.activation.first_start.median_ms * row.activation.first_start.n;
      activation.first_start.n += row.activation.first_start.n;
    }
    activation.merged_7d.cohort += row.activation.merged_7d.cohort; activation.merged_7d.merged += row.activation.merged_7d.merged;
    activation.week_return.cohort += row.activation.week_return.cohort; activation.week_return.returned += row.activation.week_return.returned;
    if (row.report.latest && (!report.latest || row.report.latest > report.latest)) report.latest = row.report.latest;
  }
  report.daily = [...daily.values()].sort((a, b) => a.day.localeCompare(b.day));
  report.features = [...features.values()];
  report.retention = [...retention.values()].sort((a, b) => a.day.localeCompare(b.day));
  if (activation.first_start.n) activation.first_start.median_ms = Math.round(startWeighted / activation.first_start.n);
  return { report, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), activation };
}
