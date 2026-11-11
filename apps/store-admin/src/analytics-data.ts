export const regions = ["all", "cn", "apac", "eu", "na", "other"] as const;
/** The windows a view or one of its cards can cover, in UTC days ending today. */
export const WINDOWS = [7, 30, 90, 180, 365] as const;
export type WindowDays = typeof WINDOWS[number];
/** The cards that take a window of their own (URL `w_<card>`); the rest follow the page's. */
export const CARDS = ["overview", "ranking", "detail", "retention", "growth", "activation", "seo", "github", "features", "platforms"] as const;
export type Card = typeof CARDS[number];
/** One aggregate query each; a window loads only the parts its cards draw. */
export const PARTS = ["report", "days", "activation", "site", "accounts", "platforms", "search", "github"] as const;
export type Part = typeof PARTS[number];
export const CARD_PARTS: Record<Card, Part[]> = {
  overview: ["report"], ranking: ["report"], detail: ["report", "days"], retention: ["report"],
  growth: ["site", "accounts"], activation: ["activation", "site"], seo: ["search"], github: ["github"], features: ["report"], platforms: ["platforms"]
};
export interface Filters {
  days: WindowDays;
  region: typeof regions[number];
  metric: "duration_ms" | "uses";
  feature: string;
  lang: "en" | "zh";
  /** The maintainer's own installs (any non-release build): left out unless the URL says `internal=include`. */
  internal: "exclude" | "include";
  from: string;
  to: string;
  /** Cards whose window differs from `days`. */
  windows: Partial<Record<Card, WindowDays>>;
}
const isWindow = (n: number): n is WindowDays => WINDOWS.some((w) => w === n);
/** The first day of a window of `days` UTC days that ends on `to`. */
export const windowStart = (to: string, days: number) => new Date(Date.parse(to) - (days - 1) * 86400000).toISOString().slice(0, 10);
export function filters(params: URLSearchParams, now = new Date()): Filters {
  const days = Number(params.get("days") ?? 30);
  const region = params.get("region") ?? "all";
  const metric = params.get("metric") ?? "duration_ms";
  const lang = params.get("lang") ?? "zh";
  const internal = params.get("internal") ?? "exclude";
  if (!isWindow(days) || !regions.some((r) => r === region) || !["duration_ms", "uses"].includes(metric) || !["en", "zh"].includes(lang) || !["exclude", "include"].includes(internal)) throw new Error("filters");
  const windows: Filters["windows"] = {};
  for (const card of CARDS) {
    const raw = params.get(`w_${card}`);
    if (raw === null) continue;
    const w = Number(raw);
    if (!isWindow(w)) throw new Error("filters");
    if (w !== days) windows[card] = w;
  }
  const to = now.toISOString().slice(0, 10);
  return { days, region, metric, lang, internal, feature: params.get("feature") ?? "", from: windowStart(to, days), to, windows } as Filters;
}
export const windowOf = (f: Filters, card: Card): WindowDays => f.windows[card] ?? f.days;
/** The windows a view needs and the parts each one loads: the page's own always has the report (headline and daily tables). */
export function plan(f: Filters): Map<WindowDays, Set<Part>> {
  const result = new Map<WindowDays, Set<Part>>([[f.days, new Set<Part>(["report"])]]);
  for (const card of CARDS) {
    const w = windowOf(f, card);
    const parts = result.get(w) ?? result.set(w, new Set()).get(w)!;
    for (const part of CARD_PARTS[card]) parts.add(part);
  }
  return result;
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
/** tomrade_site_report: the copy of Cloudflare's numbers that tomrade-site's sync job writes. */
export interface SiteCounts { installs: number; updates: number; pageviews: number; visits: number }
export interface SiteReport {
  totals: SiteCounts;
  daily: (SiteCounts & { day: string })[];
  platforms: { platform: string; installs: number; updates: number }[];
  synced_at: string | null;
}
/** tomrade_accounts_report: registered accounts; they carry no region. */
export interface Accounts { total: number; confirmed: number; new: number; daily: { day: string; new: number }[] }
/** tomrade_analytics_platforms: active IDs and active time per operating system. */
export interface PlatformUse { platform: string; aai: number; duration_ms: number }
/** tomrade_search_report: Search Console for tomrade.com (no region). position_sum is position × impressions. */
export interface SearchCounts { clicks: number; impressions: number; position_sum: number }
export interface SearchReport {
  totals: SearchCounts;
  daily: (SearchCounts & { day: string })[];
  queries: (SearchCounts & { key: string })[];
  pages: (SearchCounts & { key: string })[];
  synced_at: string | null;
}
/** tomrade_github_report: the app repository's traffic per day, and its snapshots (no region). */
export interface GithubDay { day: string; views: number; view_uniques: number; clones: number; clone_uniques: number }
export interface GithubSnapshot {
  day: string; repo: string; stars: number; forks: number; watchers: number;
  views_14d: number; view_uniques_14d: number; clones_14d: number; clone_uniques_14d: number;
  referrers: { referrer: string; count: number; uniques: number }[];
  paths: { path: string; title: string; count: number; uniques: number }[];
}
export interface GithubReport {
  totals: { views: number; clones: number };
  daily: GithubDay[];
  /** The snapshot the range starts from (the last before it, else its first) and the latest one by its end. */
  first: GithubSnapshot | null; last: GithubSnapshot | null;
  synced_at: string | null;
}
export interface DashboardData {
  report: Report; days: FeatureDay[]; activation: Activation;
  /** Null where a deployment has not applied the migration (or the sync never ran there). */
  site: SiteReport | null; accounts: Accounts | null; platforms: PlatformUse[];
  search: SearchReport | null; github: GithubReport | null;
}
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
/** Every window a view's cards use, each loaded with only the parts its cards draw. */
export type View = Map<WindowDays, DashboardData>;
export async function loadView(sources: Endpoint[], f: Filters, request: typeof fetch = fetch): Promise<View> {
  const windows = [...plan(f)];
  const loaded = await Promise.all(windows.map(([days, parts]) => loadDashboard(sources, { region: f.region, internal: f.internal, from: windowStart(f.to, days), to: f.to }, request, parts)));
  return new Map(windows.map(([days], i) => [days, loaded[i]!]));
}
export async function loadDashboard(sources: Endpoint[], f: Pick<Filters, "from" | "to" | "region" | "internal">, request: typeof fetch = fetch, parts: ReadonlySet<Part> = new Set(PARTS)): Promise<DashboardData> {
  const range = { p_from: f.from, p_to: f.to };
  // Accounts, search and GitHub carry no anonymous ids, so only the regional RPCs take the internal switch.
  const regional = { ...range, p_region: f.region === "all" ? null : f.region, p_exclude_internal: f.internal === "exclude" };
  const call = (source: Endpoint, name: string, body: object) => request(`${source.url}/rest/v1/rpc/${name}`, {
    method: "POST", headers: { apikey: source.key, Authorization: `Bearer ${source.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  const rpc = async <T>(source: Endpoint, name: string, body: object = regional): Promise<T> => {
    const response = await call(source, name, body);
    if (!response.ok) throw new Error("analytics query failed");
    return response.json() as Promise<T>;
  };
  // A function this deployment does not have yet (404) leaves its section empty instead of the whole view.
  const optional = async <T>(source: Endpoint, name: string, body: object = regional): Promise<T | null> => {
    const response = await call(source, name, body);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("analytics query failed");
    return response.json() as Promise<T>;
  };
  const rows = await Promise.all(sources.map(async (source) => {
    // A part this window does not draw is left at its empty value, without a query.
    const when = <T>(part: Part, query: () => Promise<T>, empty: T) => (parts.has(part) ? query() : Promise.resolve(empty));
    const [report, series, activation, site, accounts, platforms, search, github] = await Promise.all([
      when("report", () => rpc<Report>(source, "tomrade_analytics_report"), emptyReport()),
      when("days", () => rpc<{ days: FeatureDay[] }>(source, "tomrade_analytics_feature_days"), { days: [] }),
      when("activation", () => rpc<Activation>(source, "tomrade_analytics_activation"), emptyActivation()),
      when("site", () => optional<SiteReport>(source, "tomrade_site_report"), null),
      when("accounts", () => optional<Accounts>(source, "tomrade_accounts_report", range), null),
      when("platforms", () => optional<{ platforms: PlatformUse[] }>(source, "tomrade_analytics_platforms"), null),
      when("search", () => optional<SearchReport>(source, "tomrade_search_report", range), null),
      when("github", () => optional<GithubReport>(source, "tomrade_github_report", range), null)
    ]);
    return { report, days: series.days, activation, site, accounts, platforms: platforms?.platforms ?? [], search, github };
  }));
  return mergeReports(rows);
}
const emptyReport = (): Report => ({ totals: { duration_ms: 0, uses: 0, aai: 0 }, daily: [], features: [], retention: [], latest: null });
const emptyActivation = (): Activation => ({
  funnel: { installs: 0, setup_done: 0, start: 0, open_pr: 0, merge: 0 },
  first_start: { median_ms: null, n: 0 },
  merged_7d: { cohort: 0, merged: 0 },
  week_return: { cohort: 0, returned: 0 }
});
export function mergeReports(rows: DashboardData[]): DashboardData {
  const report = emptyReport();
  const daily = new Map<string, Report["daily"][number]>();
  const features = new Map<string, Report["features"][number]>();
  const retention = new Map<string, Report["retention"][number]>();
  const days = new Map<string, FeatureDay>();
  const activation = emptyActivation();
  let site: SiteReport | null = null;
  let accounts: Accounts | null = null;
  const siteDays = new Map<string, SiteReport["daily"][number]>();
  const sitePlatforms = new Map<string, SiteReport["platforms"][number]>();
  const accountDays = new Map<string, number>();
  const platforms = new Map<string, PlatformUse>();
  const addSite = (a: SiteCounts, b: SiteCounts) => { a.installs += b.installs; a.updates += b.updates; a.pageviews += b.pageviews; a.visits += b.visits; };
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
    if (row.site) {
      site ??= { totals: { installs: 0, updates: 0, pageviews: 0, visits: 0 }, daily: [], platforms: [], synced_at: null };
      addSite(site.totals, row.site.totals);
      for (const d of row.site.daily) {
        const target = siteDays.get(d.day) ?? { day: d.day, installs: 0, updates: 0, pageviews: 0, visits: 0 };
        addSite(target, d); siteDays.set(d.day, target);
      }
      for (const d of row.site.platforms) {
        const target = sitePlatforms.get(d.platform) ?? { platform: d.platform, installs: 0, updates: 0 };
        target.installs += d.installs; target.updates += d.updates; sitePlatforms.set(d.platform, target);
      }
      if (row.site.synced_at && (!site.synced_at || row.site.synced_at > site.synced_at)) site.synced_at = row.site.synced_at;
    }
    if (row.accounts) {
      accounts ??= { total: 0, confirmed: 0, new: 0, daily: [] };
      accounts.total += row.accounts.total; accounts.confirmed += row.accounts.confirmed; accounts.new += row.accounts.new;
      for (const d of row.accounts.daily) accountDays.set(d.day, (accountDays.get(d.day) ?? 0) + d.new);
    }
    for (const d of row.platforms) {
      const target = platforms.get(d.platform) ?? { platform: d.platform, aai: 0, duration_ms: 0 };
      target.aai += d.aai; target.duration_ms += d.duration_ms; platforms.set(d.platform, target);
    }
    if (row.report.latest && (!report.latest || row.report.latest > report.latest)) report.latest = row.report.latest;
  }
  report.daily = [...daily.values()].sort((a, b) => a.day.localeCompare(b.day));
  report.features = [...features.values()];
  report.retention = [...retention.values()].sort((a, b) => a.day.localeCompare(b.day));
  if (activation.first_start.n) activation.first_start.median_ms = Math.round(startWeighted / activation.first_start.n);
  if (site) {
    site.daily = [...siteDays.values()].sort((a, b) => a.day.localeCompare(b.day));
    site.platforms = [...sitePlatforms.values()].sort((a, b) => b.installs - a.installs || a.platform.localeCompare(b.platform));
  }
  if (accounts) accounts.daily = [...accountDays].map(([day, n]) => ({ day, new: n })).sort((a, b) => a.day.localeCompare(b.day));
  return {
    report, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), activation, site, accounts,
    platforms: [...platforms.values()].sort((a, b) => b.aai - a.aai || a.platform.localeCompare(b.platform)),
    search: mergeSearch(rows.map((r) => r.search)), github: mergeGithub(rows.map((r) => r.github))
  };
}
const byDay = (a: { day: string }, b: { day: string }) => a.day.localeCompare(b.day);
const newest = (times: (string | null)[]) => times.reduce<string | null>((max, t) => (t && (!max || t > max) ? t : max), null);
/** Sums counts by key; positions stay weighted by impressions, so they add too. */
function mergeSearch(reports: (SearchReport | null)[]): SearchReport | null {
  const present = reports.filter((r): r is SearchReport => r !== null);
  if (!present.length) return null;
  const add = (a: SearchCounts, b: SearchCounts) => { a.clicks += b.clicks; a.impressions += b.impressions; a.position_sum += b.position_sum; };
  const sum = <K extends string>(rows: (SearchCounts & Record<K, string>)[], key: K) => {
    const map = new Map<string, SearchCounts & Record<K, string>>();
    for (const r of rows) { const t = map.get(r[key]) ?? map.set(r[key], { [key]: r[key], clicks: 0, impressions: 0, position_sum: 0 } as SearchCounts & Record<K, string>).get(r[key])!; add(t, r); }
    return [...map.values()];
  };
  const top = (rows: (SearchCounts & { key: string })[]) => rows.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.key.localeCompare(b.key)).slice(0, 25);
  const totals = { clicks: 0, impressions: 0, position_sum: 0 };
  for (const r of present) add(totals, r.totals);
  return {
    totals, daily: sum(present.flatMap((r) => r.daily), "day").sort(byDay),
    queries: top(sum(present.flatMap((r) => r.queries), "key")), pages: top(sum(present.flatMap((r) => r.pages), "key")),
    synced_at: newest(present.map((r) => r.synced_at))
  };
}
/** One repository: daily counts add, and the snapshots are the earliest start and the latest end any deployment has. */
function mergeGithub(reports: (GithubReport | null)[]): GithubReport | null {
  const present = reports.filter((r): r is GithubReport => r !== null);
  if (!present.length) return null;
  const days = new Map<string, GithubDay>();
  for (const d of present.flatMap((r) => r.daily)) {
    const t = days.get(d.day) ?? days.set(d.day, { day: d.day, views: 0, view_uniques: 0, clones: 0, clone_uniques: 0 }).get(d.day)!;
    t.views += d.views; t.view_uniques += d.view_uniques; t.clones += d.clones; t.clone_uniques += d.clone_uniques;
  }
  const snapshots = (pick: "first" | "last") => present.map((r) => r[pick]).filter((s): s is GithubSnapshot => s !== null).sort(byDay);
  return {
    totals: { views: present.reduce((n, r) => n + r.totals.views, 0), clones: present.reduce((n, r) => n + r.totals.clones, 0) },
    daily: [...days.values()].sort(byDay),
    first: snapshots("first")[0] ?? null, last: snapshots("last").at(-1) ?? null,
    synced_at: newest(present.map((r) => r.synced_at))
  };
}
