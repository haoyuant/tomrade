import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const db = new PGlite();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const A = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "cccccccccccccccccccccccccc";

const call = async (sql: string, params: unknown[]) => (await db.query<{ result: any }>(sql, params)).rows[0]!.result;

beforeAll(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key, created_at timestamptz, email_confirmed_at timestamptz, deleted_at timestamptz, is_anonymous boolean not null default false);`);
  for (const name of ["202610230001_analytics.sql", "202610230002_analytics_region_scope.sql", "202611040004_accounts_platforms.sql", "202611060002_analytics_event_unused_indexes.sql"]) await db.exec(migration(name));
  const user = (created: string, confirmed: boolean, extra = "") =>
    db.query(`insert into auth.users (id, created_at, email_confirmed_at${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2::timestamptz, $3::timestamptz${extra ? ", " + extra.split("=")[1] : ""})`, [randomUUID(), created, confirmed ? created : null]);
  await user("2026-09-01T10:00:00Z", true);
  await user("2026-10-02T10:00:00Z", true);
  await user("2026-10-02T23:59:00Z", false);
  await user("2026-10-03T08:00:00Z", true);
  await user("2026-10-03T09:00:00Z", true, "is_anonymous=true");
  await user("2026-10-03T09:30:00Z", true, "deleted_at=now()");
  await user("2026-10-10T08:00:00Z", true);

  // Events straight into the detail table, as ingest would leave them.
  const event = (anon: string, ts: string, platform: string, region: string, activeMs: number | null) =>
    db.query(`insert into public.tomrade_analytics_event (event_id, schema, registry, event, anon_id, install_seq, ts, client, platform, region, active_ms)
      values ($1, 1, 1, $2, $3, 1, $4::timestamptz, '0.27.0', $5, $6, $7)`,
      [randomUUID(), activeMs === null ? "app.start" : "feature.session", anon, ts, platform, region, activeMs]);
  await db.exec("select public.tomrade_analytics_ensure_month('2026-10-15T00:00:00Z'::timestamptz)");
  await event(A, "2026-10-02T10:00:00Z", "macos", "na", 60_000);
  await event(A, "2026-10-03T10:00:00Z", "macos", "na", 30_000);
  await event(B, "2026-10-02T10:00:00Z", "windows", "cn", null);
  await event(C, "2026-10-02T10:00:00Z", "macos", "cn", 10_000);
  await event(C, "2026-10-20T10:00:00Z", "linux", "cn", 5_000);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("accounts report", () => {
  it("counts registered accounts up to the range's end and the new ones inside it, by UTC day", async () => {
    const result = await call("select public.tomrade_accounts_report($1::date, $2::date) as result", ["2026-10-01", "2026-10-07"]);
    expect(result).toEqual({ total: 4, confirmed: 3, new: 3, daily: [{ day: "2026-10-02", new: 2 }, { day: "2026-10-03", new: 1 }] });
    expect((await call("select public.tomrade_accounts_report($1::date, $2::date) as result", ["2026-10-01", "2026-10-31"])).total).toBe(5);
    await expect(call("select public.tomrade_accounts_report($1::date, $2::date) as result", ["2026-10-07", "2026-10-01"])).rejects.toThrow();
  });
});

describe("platform split", () => {
  it("counts each platform's active IDs and active time in the range and region", async () => {
    const all = await call("select public.tomrade_analytics_platforms($1::date, $2::date, null) as result", ["2026-10-01", "2026-10-07"]);
    expect(all.platforms).toEqual([{ platform: "macos", aai: 2, duration_ms: 100_000 }, { platform: "windows", aai: 1, duration_ms: 0 }]);
    const cn = await call("select public.tomrade_analytics_platforms($1::date, $2::date, $3) as result", ["2026-10-01", "2026-10-31", "cn"]);
    expect(cn.platforms).toEqual([{ platform: "linux", aai: 1, duration_ms: 5_000 }, { platform: "macos", aai: 1, duration_ms: 10_000 }, { platform: "windows", aai: 1, duration_ms: 0 }]);
    await expect(call("select public.tomrade_analytics_platforms($1::date, $2::date, $3) as result", ["2026-10-01", "2026-10-07", "mars"])).rejects.toThrow();
  });

  it("is callable by the service role only", async () => {
    const both = () => Promise.all([
      call("select public.tomrade_analytics_platforms($1::date, $2::date, null) as result", ["2026-10-01", "2026-10-07"]),
      call("select public.tomrade_accounts_report($1::date, $2::date) as result", ["2026-10-01", "2026-10-07"])
    ]);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        await expect(both()).rejects.toThrow();
      } finally {
        await db.exec("reset role");
      }
    }
    await db.exec("set role service_role");
    try {
      const [platforms, accounts] = await both();
      expect(platforms.platforms).toHaveLength(2);
      expect(accounts.total).toBe(4);
    } finally {
      await db.exec("reset role");
    }
  });
});
