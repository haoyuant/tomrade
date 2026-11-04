import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const db = new PGlite();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");

const sync = async (from: string, to: string, rows: unknown[]) =>
  (await db.query<{ result: Record<string, number> }>("select public.tomrade_site_sync($1::date, $2::date, $3::jsonb) as result", [from, to, JSON.stringify(rows)])).rows[0]!.result;
const report = async (from: string, to: string, region: string | null = null) =>
  (await db.query<{ result: Record<string, any> }>("select public.tomrade_site_report($1::date, $2::date, $3) as result", [from, to, region])).rows[0]!.result;

const install = (day: string, country: string, platform: string, downloads: number, version = "0.27.0") =>
  ({ day, country, kind: "install", platform, version, requests: Math.ceil(downloads), bytes: downloads * 1000, downloads });

beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role;");
  for (const name of ["202610230001_analytics.sql", "202610230002_analytics_region_scope.sql", "202611040001_site_daily.sql"]) await db.exec(migration(name));
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("site sync", () => {
  it("buckets countries as ingest does, keeps no country, and sums downloads before rounding", async () => {
    await sync("2026-10-01", "2026-10-02", [
      install("2026-10-01", "US", "mac-arm64", 0.6),
      install("2026-10-01", "CA", "mac-arm64", 0.6),
      install("2026-10-01", "DE", "windows", 2),
      install("2026-10-02", "CN", "mac-arm64", 1),
      { day: "2026-10-02", country: "JP", kind: "update", platform: "mac-arm64", version: "0.27.0", requests: 4, bytes: 9, downloads: 3 },
      { day: "2026-10-02", country: "XX", kind: "page", requests: 50, visits: 20 }
    ]);
    const columns = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'tomrade_site_daily'");
    expect(columns.rows.map((c) => c.column_name)).not.toContain("country");
    const rows = await db.query<{ region: string; downloads: string }>("select region, downloads::text from public.tomrade_site_daily where day = '2026-10-01' and platform = 'mac-arm64'");
    expect(rows.rows).toEqual([{ region: "na", downloads: "1.2" }]);

    const all = await report("2026-10-01", "2026-10-02");
    expect(all.totals).toEqual({ installs: 4, updates: 3, pageviews: 50, visits: 20 });
    expect(all.daily.map((d: { day: string; installs: number }) => [d.day, d.installs])).toEqual([["2026-10-01", 3], ["2026-10-02", 1]]);
    expect(all.platforms).toEqual([{ platform: "mac-arm64", installs: 2, updates: 3 }, { platform: "windows", installs: 2, updates: 0 }]);
    expect(all.synced_at).not.toBeNull();
    expect((await report("2026-10-01", "2026-10-02", "cn")).totals).toEqual({ installs: 1, updates: 0, pageviews: 0, visits: 0 });
    expect((await report("2026-10-01", "2026-10-02", "other")).totals.pageviews).toBe(50);
  });

  it("replaces the days it is given, so a re-run counts once and an empty day clears", async () => {
    await sync("2026-10-01", "2026-10-02", [install("2026-10-01", "US", "linux", 5)]);
    await sync("2026-10-01", "2026-10-02", [install("2026-10-01", "US", "linux", 5)]);
    expect((await report("2026-10-01", "2026-10-02")).totals.installs).toBe(5);
    await sync("2026-10-03", "2026-10-03", [install("2026-10-03", "US", "linux", 1)]);
    expect((await report("2026-10-01", "2026-10-03")).totals.installs).toBe(6);
  });

  it("refuses rows outside the range or of an unknown kind, and leaves the table as it was", async () => {
    await expect(sync("2026-10-01", "2026-10-01", [install("2026-10-05", "US", "linux", 1)])).rejects.toThrow("outside the range");
    await expect(sync("2026-10-01", "2026-10-01", [{ day: "2026-10-01", country: "US", kind: "crawl" }])).rejects.toThrow("unknown kind");
    await expect(sync("2026-10-02", "2026-10-01", [])).rejects.toThrow();
    await expect(report("2026-10-01", "2026-10-01", "mars")).rejects.toThrow("unknown region");
    expect((await report("2026-10-01", "2026-10-03")).totals.installs).toBe(6);
  });

  it("keeps only its own side of the border once a deployment names its scope", async () => {
    await db.exec("set tomrade.analytics_scope = 'global'");
    try {
      const result = await sync("2026-10-04", "2026-10-04", [install("2026-10-04", "CN", "windows", 2), install("2026-10-04", "FR", "windows", 1)]);
      expect(result).toMatchObject({ written: 1, skipped: 1 });
      expect((await report("2026-10-04", "2026-10-04")).totals.installs).toBe(1);
    } finally {
      await db.exec("reset tomrade.analytics_scope");
    }
  });

  it("is callable by the service role only", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        await expect(sync("2026-10-01", "2026-10-01", [])).rejects.toThrow();
        await expect(report("2026-10-01", "2026-10-01")).rejects.toThrow();
      } finally {
        await db.exec("reset role");
      }
    }
    await db.exec("set role service_role");
    try {
      expect((await report("2026-10-01", "2026-10-03")).totals.installs).toBe(6);
      await sync("2026-10-05", "2026-10-05", [install("2026-10-05", "US", "linux", 1)]);
    } finally {
      await db.exec("reset role");
    }
  });

  it("still buckets ingest's header the way it did", async () => {
    for (const [header, region] of [["CN", "cn"], ["jp", "apac"], ["GB", "eu"], ["US", "na"], ["BR", "other"], ["", "other"]] as const) {
      await db.query("select set_config('request.headers', $1, false)", [JSON.stringify({ "cf-ipcountry": header })]);
      expect((await db.query<{ r: string }>("select public.tomrade_analytics_region() as r")).rows[0]!.r).toBe(region);
    }
    await db.query("select set_config('request.headers', 'not json', false)");
    expect((await db.query<{ r: string }>("select public.tomrade_analytics_region() as r")).rows[0]!.r).toBe("other");
  });
});
