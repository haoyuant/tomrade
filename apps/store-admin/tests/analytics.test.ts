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
  days: [{ day: "2026-10-22", feature_id: "backlog.board", region: "na", duration_ms: 60000, uses }]
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
  });
  it("reads only aggregate RPCs, passes the region, and fails the whole view when a source fails", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const request: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json(String(input).endsWith("feature_days") ? { days: sample().days } : sample().report);
    };
    await loadDashboard([{ url: "https://global.example", key: "secret" }, { url: "https://cn.example", key: "secret-cn" }], { ...f, region: "cn" }, request);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.url.includes("/rest/v1/rpc/tomrade_analytics_") && (c.body as { p_region: string }).p_region === "cn")).toBe(true);
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
    const pending = sample(); pending.report.retention[0]!.day = "2026-10-22";
    expect(renderDashboard(f, pending)).toContain("Pending");
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
