import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const db = new PGlite();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");

const sync = async (from: string, to: string, rows: unknown[]) =>
  (await db.query<{ result: Record<string, number> }>("select public.tomrade_ab_sync($1::date, $2::date, $3::jsonb) as result", [from, to, JSON.stringify(rows)])).rows[0]!.result;
const report = async (from: string, to: string, region: string | null = null) =>
  (await db.query<{ result: Record<string, any> }>("select public.tomrade_ab_report($1::date, $2::date, $3) as result", [from, to, region])).rows[0]!.result;

const row = (day: string, variant: string, event: string, n: number, device = "desktop", lang = "en", test = "home-v2") => ({ day, test, variant, lang, device, event, n });
const total = (rows: { variant: string; device: string; event: string; n: number }[], variant: string, event: string, device = "desktop") =>
  rows.filter((r) => r.variant === variant && r.event === event && r.device === device).reduce((sum, r) => sum + r.n, 0);

beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(migration("202611170001_ab_daily.sql"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("A/B test sync", () => {
  it("reports an empty table as a test that has not started", async () => {
    expect(await report("2026-11-01", "2026-11-30")).toEqual({ from: "2026-11-01", to: "2026-11-30", synced_at: null, tests: [], rows: [] });
  });

  it("adds the range's days up per test, version, language, device and event", async () => {
    const written = await sync("2026-11-17", "2026-11-18", [
      row("2026-11-17", "a", "view", 100), row("2026-11-17", "b", "view", 90),
      row("2026-11-18", "a", "view", 50), row("2026-11-18", "a", "view", 7, "mobile"),
      row("2026-11-18", "b", "download", 4), row("2026-11-18", "b", "download-via-page", 1, "desktop", "zh"),
      row("2026-11-18", "b", "downloader", 2)
    ]);
    expect(written).toEqual({ written: 7, replaced: 0, expired: 0 });
    const both = await report("2026-11-17", "2026-11-18");
    expect(both.tests).toEqual([{ test: "home-v2", first_day: "2026-11-17", last_day: "2026-11-18" }]);
    expect(total(both.rows, "a", "view")).toBe(150);
    expect(total(both.rows, "a", "view", "mobile")).toBe(7);
    expect(total(both.rows, "b", "download")).toBe(4);
    expect(both.rows).toContainEqual({ test: "home-v2", variant: "b", lang: "zh", device: "desktop", event: "download-via-page", n: 1 });
    expect(both.synced_at).not.toBeNull();
    const first = await report("2026-11-17", "2026-11-17", "cn");
    expect(first.tests).toEqual([{ test: "home-v2", first_day: "2026-11-17", last_day: "2026-11-17" }]);
    expect(total(first.rows, "a", "view")).toBe(100);
    // A range without rows still says when the table was last copied.
    const quiet = await report("2026-10-01", "2026-10-31");
    expect(quiet).toMatchObject({ tests: [], rows: [] });
    expect(quiet.synced_at).toBe(both.synced_at);
  });

  it("replaces the days it is given, so a re-run counts once and an empty day clears", async () => {
    const again = await sync("2026-11-18", "2026-11-18", [row("2026-11-18", "a", "view", 60), row("2026-11-18", "a", "view", 5)]);
    expect(again).toMatchObject({ written: 1, replaced: 5 });
    const both = await report("2026-11-17", "2026-11-18");
    expect(total(both.rows, "a", "view")).toBe(165);
    expect(total(both.rows, "b", "download")).toBe(0);
    await sync("2026-11-18", "2026-11-18", []);
    expect((await report("2026-11-17", "2026-11-18")).tests[0].last_day).toBe("2026-11-17");
  });

  it("lists a later test first", async () => {
    await sync("2026-11-20", "2026-11-20", [row("2026-11-20", "a", "view", 3, "desktop", "en", "home-v3")]);
    expect((await report("2026-11-17", "2026-11-20")).tests.map((t: { test: string }) => t.test)).toEqual(["home-v3", "home-v2"]);
    await sync("2026-11-20", "2026-11-20", []);
  });

  it("refuses rows outside the range or of an unknown kind, and leaves the table as it was", async () => {
    await expect(sync("2026-11-17", "2026-11-17", [row("2026-11-19", "a", "view", 1)])).rejects.toThrow("outside the range");
    await expect(sync("2026-11-17", "2026-11-17", [row("2026-11-17", "c", "view", 1)])).rejects.toThrow("unknown variant");
    await expect(sync("2026-11-17", "2026-11-17", [row("2026-11-17", "a", "click", 1)])).rejects.toThrow("unknown event");
    await expect(sync("2026-11-17", "2026-11-17", [row("2026-11-17", "a", "view", 1, "tablet")])).rejects.toThrow("unknown device");
    await expect(sync("2026-11-17", "2026-11-17", [row("2026-11-17", "a", "view", 1, "desktop", "fr")])).rejects.toThrow("unknown language");
    await expect(sync("2026-11-17", "2026-11-17", [row("2026-11-17", "a", "view", 1, "desktop", "en", "")])).rejects.toThrow("names no test");
    await expect(sync("2026-11-18", "2026-11-17", [])).rejects.toThrow();
    await expect(sync("2026-01-01", "2026-11-17", [])).rejects.toThrow("at most 120 days");
    await expect(report("2026-11-18", "2026-11-17")).rejects.toThrow();
    expect(total((await report("2026-11-17", "2026-11-18")).rows, "a", "view")).toBe(100);
  });

  it("is callable by the service role only, and the table by neither public role", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        await expect(sync("2026-11-17", "2026-11-17", [])).rejects.toThrow();
        await expect(report("2026-11-17", "2026-11-17")).rejects.toThrow();
        await expect(db.query("select * from public.tomrade_ab_daily")).rejects.toThrow();
      } finally {
        await db.exec("reset role");
      }
    }
    await db.exec("set role service_role");
    try {
      expect(total((await report("2026-11-17", "2026-11-17")).rows, "b", "view")).toBe(90);
      await sync("2026-11-19", "2026-11-19", [row("2026-11-19", "a", "view", 1)]);
    } finally {
      await db.exec("reset role");
    }
    const secured = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid = 'public.tomrade_ab_daily'::regclass");
    expect(secured.rows[0]).toEqual({ relrowsecurity: true });
  });

  it("drops what is older than 25 months", async () => {
    await db.exec("insert into public.tomrade_ab_daily (day, test, variant, lang, device, event, n) values ('2024-01-01', 'old', 'a', 'en', 'desktop', 'view', 9)");
    expect(await sync("2026-11-19", "2026-11-19", [])).toMatchObject({ expired: 1 });
  });
});
