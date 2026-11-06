import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { endpoints, filters, loadDashboard, loadView, mergeReports, plan, type DashboardData, type View } from "../src/analytics-data.js";
import { AnalystUnavailable, checked, claudeAnalyst, insightsInput, insightsService, type Insights, type InsightsService } from "../src/analytics-insights.js";
import { renderDashboard } from "../src/analytics-page.js";
import { dashboardServer } from "../src/analytics-server.js";

const sample = (uses = 3): DashboardData => ({
  report: {
    totals: { duration_ms: 60000, uses, aai: 2 },
    daily: [{ day: "2026-10-22", duration_ms: 60000, uses, aai: 2 }],
    features: [{ feature_id: "backlog.board", duration_ms: 60000, uses, aai: 2 }],
    retention: [{ day: "2026-10-20", cohort: 2, d1: 1 }], latest: "2026-10-22T12:00:00Z"
  },
  days: [{ day: "2026-10-22", feature_id: "backlog.board", region: "na", duration_ms: 60000, uses }],
  activation: {
    funnel: { installs: 10, setup_done: 8, start: 4, open_pr: 2, merge: 1 },
    first_start: { median_ms: 2 * 3600000, n: 4 },
    merged_7d: { cohort: 5, merged: 1 },
    week_return: { cohort: 4, returned: 2 }
  },
  site: {
    totals: { installs: 40, updates: 6, pageviews: 900, visits: 300 },
    daily: [{ day: "2026-10-22", installs: 40, updates: 6, pageviews: 900, visits: 300 }],
    platforms: [{ platform: "mac-arm64", installs: 30, updates: 6 }, { platform: "windows", installs: 10, updates: 0 }],
    synced_at: "2026-10-23T02:00:00Z"
  },
  accounts: { total: 120, confirmed: 100, new: 7, daily: [{ day: "2026-10-22", new: 7 }] },
  platforms: [{ platform: "macos", aai: 3, duration_ms: 90000 }, { platform: "linux", aai: 1, duration_ms: 30000 }]
});
const f = filters(new URLSearchParams("lang=en"), new Date("2026-10-23T10:00:00Z"));
const one = (data: DashboardData, days = 30): View => new Map([[days as 30, data]]);
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))); });
async function start(load: Parameters<typeof dashboardServer>[0]) {
  const server = dashboardServer(load); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
describe("internal analytics dashboard", () => {
  it("uses inclusive UTC ranges and rejects unsupported filters", () => {
    expect(f).toMatchObject({ from: "2026-09-24", to: "2026-10-23", days: 30 });
    for (const days of [7, 30, 90, 180, 365]) expect(filters(new URLSearchParams(`days=${days}`)).days).toBe(days);
    for (const query of ["days=400", "region=mars", "metric=aai", "lang=xx", "w_growth=12", "w_overview=400"]) expect(() => filters(new URLSearchParams(query))).toThrow();
    // A card's window is kept only where it differs from the page's; unknown cards are ignored.
    expect(filters(new URLSearchParams("days=30&w_growth=365&w_overview=30&w_nothing=7")).windows).toEqual({ growth: 365 });
  });
  it("adds aggregate metrics across deployments, grouping feature days without exporting IDs", () => {
    const result = mergeReports([sample(), sample(4)]);
    expect(result.report.totals).toEqual({ duration_ms: 120000, uses: 7, aai: 4 });
    expect(result.report.daily).toHaveLength(1);
    expect(result.days).toHaveLength(1);
    expect(result.days[0]).toMatchObject({ uses: 7, duration_ms: 120000 });
    expect(result.report.retention[0]).toMatchObject({ cohort: 4, d1: 2 });
    expect(result.activation.funnel).toEqual({ installs: 20, setup_done: 16, start: 8, open_pr: 4, merge: 2 });
    expect(result.activation.merged_7d).toEqual({ cohort: 10, merged: 2 });
    expect(result.activation.week_return).toEqual({ cohort: 8, returned: 4 });
    expect(result.site?.totals).toEqual({ installs: 80, updates: 12, pageviews: 1800, visits: 600 });
    expect(result.site?.platforms[0]).toEqual({ platform: "mac-arm64", installs: 60, updates: 12 });
    expect(result.accounts).toMatchObject({ total: 240, confirmed: 200, new: 14, daily: [{ day: "2026-10-22", new: 14 }] });
    expect(result.platforms).toEqual([{ platform: "macos", aai: 6, duration_ms: 180000 }, { platform: "linux", aai: 2, duration_ms: 60000 }]);
  });
  it("leaves the site and accounts empty where no deployment has them, and keeps the newest copy time", () => {
    const old = { ...sample(), site: null, accounts: null, platforms: [] };
    expect(mergeReports([old])).toMatchObject({ site: null, accounts: null, platforms: [] });
    const later = sample(); later.site!.synced_at = "2026-10-23T05:00:00Z";
    expect(mergeReports([old, sample(), later]).site?.synced_at).toBe("2026-10-23T05:00:00Z");
  });
  it("weighs each deployment's median by how many it covers, and leaves none when no one started", () => {
    const cn = sample(); cn.activation.first_start = { median_ms: 6 * 3600000, n: 12 };
    expect(mergeReports([sample(), cn]).activation.first_start).toEqual({ median_ms: 5 * 3600000, n: 16 });
    const idle = sample(); idle.activation.first_start = { median_ms: null, n: 0 };
    expect(mergeReports([idle]).activation.first_start).toEqual({ median_ms: null, n: 0 });
    expect(mergeReports([idle, sample()]).activation.first_start).toEqual({ median_ms: 2 * 3600000, n: 4 });
  });
  it("reads only aggregate RPCs, passes the region, and fails the whole view when a source fails", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const request: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      const url = String(input);
      // The mainland deployment has not applied the site and accounts migrations.
      if (url.startsWith("https://cn.example") && /tomrade_(site|accounts)_/.test(url)) return new Response("", { status: 404 });
      const body = url.endsWith("feature_days") ? { days: sample().days } : url.endsWith("activation") ? sample().activation
        : url.endsWith("site_report") ? sample().site : url.endsWith("accounts_report") ? sample().accounts
        : url.endsWith("platforms") ? { platforms: sample().platforms } : sample().report;
      return Response.json(body);
    };
    const loaded = await loadDashboard([{ url: "https://global.example", key: "secret" }, { url: "https://cn.example", key: "secret-cn" }], { ...f, region: "cn" }, request);
    expect(calls).toHaveLength(12);
    expect(calls.filter((c) => c.url.endsWith("/rpc/tomrade_analytics_activation"))).toHaveLength(2);
    expect(loaded.activation.funnel.installs).toBe(20);
    expect(loaded.site?.totals.installs).toBe(40);
    expect(loaded.accounts?.total).toBe(120);
    expect(loaded.platforms[0]).toEqual({ platform: "macos", aai: 6, duration_ms: 180000 });
    const accounts = calls.filter((c) => c.url.endsWith("/rpc/tomrade_accounts_report"));
    expect(accounts.every((c) => !("p_region" in (c.body as object)))).toBe(true);
    expect(calls.filter((c) => !accounts.includes(c)).every((c) => /\/rest\/v1\/rpc\/tomrade_(analytics|site)_/.test(c.url) && (c.body as { p_region: string }).p_region === "cn")).toBe(true);
    await expect(loadDashboard([{ url: "https://example.org", key: "secret" }], f, async () => new Response("secret", { status: 403 }))).rejects.toThrow("analytics query failed");
    expect(() => endpoints({ SUPABASE_URL: "https://example.org" })).toThrow();
    expect(() => endpoints({ SUPABASE_URL: "https://example.org", SUPABASE_SERVICE_ROLE_KEY: "s", SUPABASE_URL_CN: "https://example.org/", SUPABASE_SERVICE_ROLE_KEY_CN: "s" })).toThrow();
  });
  it("renders both metrics, daily active IDs, selection, retention and translated empty states", () => {
    const html = renderDashboard(f, one(sample()));
    for (const text of ["Daily overview", "Active minutes", "Uses", "Next-day retention", "backlog.board", "2026-10-22", "50%", 'id="chart-overview"', "/assets/dashboard.js"]) expect(html).toContain(text);
    const payload = JSON.parse(/<script type="application\/json" id="dashboard-data">(.*?)<\/script>/s.exec(html)![1]!);
    expect(payload).toMatchObject({ from: { spark: "2026-09-24", overview: "2026-09-24", growth: "2026-09-24" }, to: "2026-10-23", feature: "backlog.board", retention: [{ day: "2026-10-20", mature: true }] });
    expect(payload.days[0]).not.toHaveProperty("region");
    expect(renderDashboard(f, one(mergeReports([])))).toContain("No usage data");
    expect(renderDashboard({ ...f, lang: "zh" }, undefined, "failed")).toContain("无法加载使用数据");
    const malicious = sample(); malicious.report.features[0]!.feature_id = '<script>alert("x")</script>';
    const escaped = renderDashboard(f, one(malicious));
    expect(escaped).not.toContain('<script>');
    expect(escaped).not.toContain("</script>alert");
    for (const text of ["Activation funnel", "First run done (setup_done)", "Merged (merge)", "80%", "2 h", "Median, 4 IDs", "20%", "Merged within 7 days", "First-week return"]) expect(html).toContain(text);
    const zh = renderDashboard({ ...f, lang: "zh" }, one(sample()));
    for (const text of ["激活漏斗", "首次开始工单耗时", "2 小时", "首周已过的 4 个 ID 中有 2 个回来"]) expect(zh).toContain(text);
    const quiet = sample(); quiet.activation = { funnel: { installs: 0, setup_done: 0, start: 0, open_pr: 0, merge: 0 }, first_start: { median_ms: null, n: 0 }, merged_7d: { cohort: 0, merged: 0 }, week_return: { cohort: 0, returned: 0 } };
    expect(renderDashboard(f, one(quiet))).toContain("Median, 0 IDs");
    const pending = sample(); pending.report.retention[0]!.day = "2026-10-22";
    expect(renderDashboard(f, one(pending))).toContain("Pending");
    for (const text of ["Accounts and site", "Registered accounts", "100 confirmed", "Installer downloads", "6 more fetched", "900", "300 visits", "macOS (Apple silicon)", "Usage by platform", "75%", 'id="chart-growth"', "2026-10-23 02:00"]) expect(html).toContain(text);
    // The funnel starts at the site's downloads: 10 installs of 40 downloads.
    expect(html).toContain("Installer downloads (site)");
    expect(html).toContain("25%");
    expect(payload.growth).toEqual([{ day: "2026-10-22", accounts: 7, installs: 40, updates: 6, pageviews: 900 }]);
    for (const text of ["账户与官网", "注册用户", "各平台使用占比", "官网安装包下载"]) expect(zh).toContain(text);
    const bare = renderDashboard(f, one({ ...sample(), site: null, accounts: null, platforms: [] }));
    expect(bare).toContain("No site data");
    expect(bare).not.toContain('id="chart-growth"');
    expect(bare).not.toContain("Usage by platform");
    expect(bare).not.toContain("Installer downloads (site)");
  });
  it("serves locally, rejects foreign origins, and never leaks upstream error details", async () => {
    let calls = 0;
    const url = await start(async () => { calls++; return one(sample(), 7); });
    const response = await fetch(`${url}/?days=7&region=eu&lang=en`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await fetch(url, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(url, { headers: { Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    expect(foreignHost).toBe(403);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    const echarts = await fetch(`${url}/assets/echarts.min.js`);
    expect(echarts.status).toBe(200);
    expect(echarts.headers.get("content-type")).toContain("text/javascript");
    expect((await fetch(`${url}/assets/../package.json`)).status).toBe(404);
    expect((await fetch(`${url}/assets/other.js`)).status).toBe(404);
    expect((await fetch(`${url}/?days=400`)).status).toBe(400);
    expect(calls).toBe(1);
    const failed = await start(async () => { throw new Error("upstream secret key"); });
    const error = await fetch(`${failed}/?lang=en`);
    expect(error.status).toBe(502);
    expect(await error.text()).not.toContain("upstream secret key");
  });

  it("plans each window once, with only the parts its cards draw", async () => {
    const custom = filters(new URLSearchParams("days=30&w_growth=365&w_platforms=365&w_ranking=7"), new Date("2026-10-23T10:00:00Z"));
    const windows = plan(custom);
    expect([...windows.keys()].sort((a, b) => a - b)).toEqual([7, 30, 365]);
    expect([...windows.get(365)!].sort()).toEqual(["accounts", "platforms", "site"]);
    expect([...windows.get(7)!]).toEqual(["report"]);
    expect([...windows.get(30)!].sort()).toEqual(["activation", "days", "report", "site"]);
    const calls: { name: string; from: string }[] = [];
    const request: typeof fetch = async (input, init) => {
      const name = String(input).split("/rpc/")[1]!;
      calls.push({ name, from: (JSON.parse(String(init?.body)) as { p_from: string }).p_from });
      const body = name.endsWith("feature_days") ? { days: [] } : name.endsWith("activation") ? sample().activation
        : name.endsWith("site_report") ? sample().site : name.endsWith("accounts_report") ? sample().accounts
        : name.endsWith("platforms") ? { platforms: sample().platforms } : sample().report;
      return Response.json(body);
    };
    const view = await loadView([{ url: "https://global.example", key: "secret" }], custom, request);
    expect(calls).toHaveLength(1 + 4 + 3);
    expect(calls.filter((c) => c.from === "2025-10-24").map((c) => c.name).sort()).toEqual(["tomrade_accounts_report", "tomrade_analytics_platforms", "tomrade_site_report"]);
    expect(calls.filter((c) => c.from === "2026-10-17").map((c) => c.name)).toEqual(["tomrade_analytics_report"]);
    // A part a window does not load is empty, not missing.
    expect(view.get(365)!.report.daily).toEqual([]);
    expect(view.get(7)!.site).toBeNull();
  });
  it("draws each windowed card from its own window and links its picker back to the card", () => {
    const custom = filters(new URLSearchParams("days=30&lang=en&w_growth=90"), new Date("2026-10-23T10:00:00Z"));
    const wide = sample(); wide.site!.totals.installs = 4321; wide.site!.daily = [{ day: "2026-08-01", installs: 4321, updates: 0, pageviews: 0, visits: 0 }];
    const html = renderDashboard(custom, new Map([[30, sample()], [90, wide]]));
    expect(html).toContain("4,321");
    expect(html).toContain("2026-07-26 — 2026-10-23");
    // The page's own window is written as following it; other windows carry the card's anchor.
    expect(html).toContain('href="/?days=30&amp;region=all&amp;metric=duration_ms&amp;lang=en#card-growth">30 days');
    expect(html).toContain('w_growth=90#card-overview" aria-current="true">30 days');
    expect(html).toContain("w_growth=90&amp;w_overview=365#card-overview");
    const payload = JSON.parse(/<script type="application\/json" id="dashboard-data">(.*?)<\/script>/s.exec(html)![1]!);
    expect(payload.from).toMatchObject({ overview: "2026-09-24", growth: "2026-07-26" });
    expect(payload.growth[0]).toMatchObject({ day: "2026-08-01", installs: 4321 });
    expect(html).toContain("365 days");
  });
  it("hands the analyst aggregates only, with the previous period, and keeps the result across restarts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "insights-"));
    const file = path.join(dir, "insights.json");
    const loads: { from: string; to: string }[] = [];
    const answer: Insights = { summary: "Fine.", highlights: [{ title: "Up", detail: "More uses", tone: "good" }], anomalies: [], suggestions: [{ title: "Ship", detail: "Now", priority: "high" }] };
    let prompt = "";
    let system = "";
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const analyst = async (s: string, p: string) => { system = s; prompt = p; await gate; return { insights: answer, cost_usd: 0.012 }; };
    const service = insightsService({ load: async (range) => { loads.push({ from: range.from, to: range.to }); return sample(); }, analyst, file, now: () => new Date("2026-10-23T10:00:00Z") });
    expect(await service.read(f)).toEqual({ entry: null, error: null, running: false });
    const first = service.generate(f);
    const second = service.generate(f);
    expect(second).toBe(first);
    expect((await service.read(f)).running).toBe(true);
    release(); await first;
    expect(loads).toEqual([{ from: "2026-09-24", to: "2026-10-23" }, { from: "2026-08-25", to: "2026-09-23" }]);
    const input = JSON.parse(prompt);
    expect(input.period).toMatchObject({ from: "2026-09-24", to: "2026-10-23", days: 30, region: "all", last_day_incomplete: true });
    expect(input.previous_period).toEqual({ from: "2026-08-25", to: "2026-09-23" });
    expect(input.current.features[0]).toEqual({ feature: "backlog.board", active_minutes: 1, uses: 3, active_ids: 2 });
    expect(input.previous).not.toHaveProperty("daily");
    expect(system).toContain("Write every string in English");
    const restarted = insightsService({ load: async () => sample(), analyst, file });
    const state = await restarted.read(f);
    expect(state.entry).toMatchObject({ region: "all", days: 30, from: "2026-09-24", cost_usd: 0.012, insights: answer });
    // Another view shows the newest analysis, which the page labels as another view's.
    expect((await restarted.read({ ...f, region: "eu" })).entry?.region).toBe("all");
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
    const failing = insightsService({ load: async () => sample(), analyst: async () => { throw new AnalystUnavailable("claude"); }, file, now: () => new Date("2026-10-24T10:00:00Z") });
    await failing.generate(f);
    expect((await failing.read(f)).error).toEqual({ at: "2026-10-24T10:00:00.000Z", kind: "unavailable" });
    expect((await failing.read(f)).entry?.insights).toEqual(answer);
    expect(insightsInput(f, sample(), sample()).current.daily).toHaveLength(1);
  });
  it("runs the local Claude CLI without tools, MCP servers or the dashboard's keys, and rejects malformed answers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "claude-"));
    const fake = path.join(dir, "claude");
    await writeFile(fake, `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => { input += c; }).on("end", () => {
  const args = process.argv.slice(2);
  const leaked = Object.keys(process.env).some((k) => k.startsWith("SUPABASE_"));
  const ok = args.includes("--strict-mcp-config") && args[args.indexOf("--tools") + 1] === "" && args.includes("--json-schema") && !leaked && input === "numbers";
  process.stdout.write(JSON.stringify({ is_error: !ok, total_cost_usd: 0.01, structured_output: { summary: "s", highlights: [], anomalies: [], suggestions: [{ title: "t", detail: "d", priority: "urgent" }] } }));
});
`);
    await chmod(fake, 0o755);
    process.env.SUPABASE_SERVICE_ROLE_KEY_TEST = "secret";
    try {
      const result = await claudeAnalyst({ command: fake })("system", "numbers");
      expect(result).toEqual({ cost_usd: 0.01, insights: { summary: "s", highlights: [], anomalies: [], suggestions: [{ title: "t", detail: "d", priority: "low" }] } });
      await expect(claudeAnalyst({ command: fake })("system", "other")).rejects.toThrow("analyst failed");
      await expect(claudeAnalyst({ command: path.join(dir, "missing") })("s", "p")).rejects.toBeInstanceOf(AnalystUnavailable);
    } finally { delete process.env.SUPABASE_SERVICE_ROLE_KEY_TEST; }
    expect(() => checked({ summary: 1, highlights: [], anomalies: [], suggestions: [] })).toThrow();
    expect(() => checked(null)).toThrow();
  });
  it("starts an analysis only from a form posted by this page, then returns to the card", async () => {
    const generated: string[] = [];
    const insights: InsightsService = {
      read: async () => ({ entry: { region: "all", days: 7, lang: "en", from: "2026-10-17", to: "2026-10-23", generated_at: "2026-10-23T09:00:00Z", cost_usd: 0.02,
        insights: { summary: "<b>All good</b>", highlights: [{ title: "Up", detail: "d", tone: "good" }], anomalies: [], suggestions: [{ title: "Do it", detail: "d", priority: "high" }] } }, error: null, running: false }),
      generate: async (g) => { generated.push(`${g.region}/${g.days}`); }
    };
    const server = dashboardServer(async () => one(sample(), 7), insights); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const page = await (await fetch(`${url}/?days=7&lang=en`)).text();
    for (const text of ["AI analysis and suggestions", "&lt;b&gt;All good&lt;/b&gt;", "Refresh analysis", "Key points", "Nothing out of the ordinary.", "cost $0.020", 'action="/insights?days=7&amp;region=all']) expect(page).toContain(text);
    expect((await fetch(`${url}/insights?days=7`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${url}/insights?days=7`, { method: "POST", headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const posted = await fetch(`${url}/insights?days=7&region=eu&lang=en`, { method: "POST", headers: { Origin: url }, redirect: "manual" });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe("/?days=7&region=eu&lang=en#card-insights");
    expect(generated).toEqual(["eu/7"]);
    expect((await fetch(`${url}/insights?days=7`)).status).toBe(404);
  });
});
