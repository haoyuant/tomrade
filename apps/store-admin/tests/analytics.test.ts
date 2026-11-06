import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { endpoints, filters, loadDashboard, mergeReports, type DashboardData } from "../src/analytics-data.js";
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
    for (const days of [7, 30, 90]) expect(filters(new URLSearchParams(`days=${days}`)).days).toBe(days);
    for (const query of ["days=400", "region=mars", "metric=aai", "lang=xx"]) expect(() => filters(new URLSearchParams(query))).toThrow();
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
    const html = renderDashboard(f, sample());
    for (const text of ["Daily overview", "Active minutes", "Uses", "Next-day retention", "backlog.board", "2026-10-22", "50%", 'id="chart-overview"', "/assets/dashboard.js"]) expect(html).toContain(text);
    const payload = JSON.parse(/<script type="application\/json" id="dashboard-data">(.*?)<\/script>/s.exec(html)![1]!);
    expect(payload).toMatchObject({ from: "2026-09-24", to: "2026-10-23", feature: "backlog.board", retention: [{ day: "2026-10-20", mature: true }] });
    expect(payload.days[0]).not.toHaveProperty("region");
    expect(renderDashboard(f, mergeReports([]))).toContain("No usage data");
    expect(renderDashboard({ ...f, lang: "zh" }, undefined, "failed")).toContain("无法加载使用数据");
    const malicious = sample(); malicious.report.features[0]!.feature_id = '<script>alert("x")</script>';
    const escaped = renderDashboard(f, malicious);
    expect(escaped).not.toContain('<script>');
    expect(escaped).not.toContain("</script>alert");
    for (const text of ["Activation funnel", "First run done (setup_done)", "Merged (merge)", "80%", "2 h", "Median, 4 IDs", "20%", "Merged within 7 days", "First-week return"]) expect(html).toContain(text);
    const zh = renderDashboard({ ...f, lang: "zh" }, sample());
    for (const text of ["激活漏斗", "首次开始工单耗时", "2 小时", "首周已过的 4 个 ID 中有 2 个回来"]) expect(zh).toContain(text);
    const quiet = sample(); quiet.activation = { funnel: { installs: 0, setup_done: 0, start: 0, open_pr: 0, merge: 0 }, first_start: { median_ms: null, n: 0 }, merged_7d: { cohort: 0, merged: 0 }, week_return: { cohort: 0, returned: 0 } };
    expect(renderDashboard(f, quiet)).toContain("Median, 0 IDs");
    const pending = sample(); pending.report.retention[0]!.day = "2026-10-22";
    expect(renderDashboard(f, pending)).toContain("Pending");
    for (const text of ["Accounts and site", "Registered accounts", "100 confirmed", "Installer downloads", "6 more fetched", "900", "300 visits", "macOS (Apple silicon)", "Usage by platform", "75%", 'id="chart-growth"', "2026-10-23 02:00"]) expect(html).toContain(text);
    // The funnel starts at the site's downloads: 10 installs of 40 downloads.
    expect(html).toContain("Installer downloads (site)");
    expect(html).toContain("25%");
    expect(payload.growth).toEqual([{ day: "2026-10-22", accounts: 7, installs: 40, updates: 6, pageviews: 900 }]);
    for (const text of ["账户与官网", "注册用户", "各平台使用占比", "官网安装包下载"]) expect(zh).toContain(text);
    const bare = renderDashboard(f, { ...sample(), site: null, accounts: null, platforms: [] });
    expect(bare).toContain("No site data");
    expect(bare).not.toContain('id="chart-growth"');
    expect(bare).not.toContain("Usage by platform");
    expect(bare).not.toContain("Installer downloads (site)");
  });
  it("serves locally, rejects foreign origins, and never leaks upstream error details", async () => {
    let calls = 0;
    const url = await start(async () => { calls++; return sample(); });
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
});
