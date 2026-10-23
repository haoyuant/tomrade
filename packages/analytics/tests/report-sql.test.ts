import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const db = new PGlite();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const A = "k3m4q2v7x5b6n4r6t2y3wzq4sc";
const B = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const C = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

const utcDay = (ago: number) => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ago, 10);
};
const DAY1 = utcDay(2);
const DAY2 = utcDay(1);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

let seq = 0;
function event(anon: string, ts: number, body: Record<string, unknown>) {
  seq += 1;
  return { schema: 1, registry: 1, anon_id: anon, install_seq: seq, ts, client: "0.2.0", platform: "macos", event_id: randomUUID(), ...body };
}
function session(anon: string, ts: number, feature: string, activeMs: number) {
  return event(anon, ts, {
    event: "feature.session", feature_id: feature, session_id: randomUUID(),
    started_at: ts - activeMs, ended_at: ts, active_ms: activeMs, idle_ms: 0, segments: 1, end_reason: "switch"
  });
}
const open = (anon: string, ts: number, feature: string) =>
  event(anon, ts, { event: "feature.activate", feature_id: feature, action: "open", dim: null });

async function ingest(events: unknown[], region: string) {
  await db.exec("reset role");
  await db.query("select set_config('request.headers', $1, false)", [JSON.stringify({ "cf-ipcountry": region })]);
  await db.exec("set role anon");
  try {
    return await db.query<{ result: { accepted: number } }>("select public.tomrade_ingest_analytics($1::jsonb) as result", [
      JSON.stringify({ batch_id: randomUUID(), sent_at: Date.now(), events })
    ]);
  } finally {
    await db.exec("reset role");
  }
}

beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role;");
  for (const name of ["202610230001_analytics.sql", "202610230002_analytics_region_scope.sql", "202610230003_analytics_aggregate.sql", "202610230004_analytics_feature_days.sql"]) {
    await db.exec(migration(name));
  }
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("aggregation", () => {
  it("rolls ten events into the feature, action and actor tables exactly", async () => {
    await ingest([
      session(A, DAY1, "backlog.board", 60_000),
      open(A, DAY1, "backlog.board"),
      event(A, DAY1, { event: "feature.activate", feature_id: "backlog.create", action: "create", dim: "quick" }),
      session(A, DAY2, "backlog.board", 30_000),
      open(A, DAY2, "backlog.board")
    ], "US");
    await ingest([
      session(B, DAY1, "backlog.table", 120_000),
      open(B, DAY1, "backlog.table"),
      open(B, DAY2, "backlog.table")
    ], "US");
    await ingest([open(B, DAY1, "backlog.table")], "JP");

    const result = await db.query<{ result: { actors: number; features: number; actions: number } }>(
      "select public.tomrade_analytics_aggregate($1::date, $2::date) as result",
      [day(DAY1), day(DAY2)]
    );
    expect(result.rows[0]!.result).toMatchObject({ actors: 11, features: 6, actions: 6 });

    const features = await db.query<{ day: string; region: string; feature_id: string; sessions: number; active_ms: number; actors: number }>(
      "select day::text, region, feature_id, sessions, active_ms::int, actors from public.tomrade_analytics_feature_daily order by day, region, feature_id"
    );
    expect(features.rows).toEqual([
      { day: day(DAY1), region: "apac", feature_id: "backlog.table", sessions: 0, active_ms: 0, actors: 1 },
      { day: day(DAY1), region: "na", feature_id: "backlog.board", sessions: 1, active_ms: 60000, actors: 1 },
      { day: day(DAY1), region: "na", feature_id: "backlog.create", sessions: 0, active_ms: 0, actors: 1 },
      { day: day(DAY1), region: "na", feature_id: "backlog.table", sessions: 1, active_ms: 120000, actors: 1 },
      { day: day(DAY2), region: "na", feature_id: "backlog.board", sessions: 1, active_ms: 30000, actors: 1 },
      { day: day(DAY2), region: "na", feature_id: "backlog.table", sessions: 0, active_ms: 0, actors: 1 }
    ]);

    const actions = await db.query<{ feature_id: string; action: string; events: number; counted_events: number }>(
      "select feature_id, action, sum(events)::int as events, sum(counted_events)::int as counted_events from public.tomrade_analytics_action_daily group by 1, 2 order by 1, 2"
    );
    expect(actions.rows).toEqual([
      { feature_id: "backlog.board", action: "open", events: 2, counted_events: 2 },
      { feature_id: "backlog.create", action: "create", events: 1, counted_events: 1 },
      { feature_id: "backlog.table", action: "open", events: 3, counted_events: 3 }
    ]);

    const actors = await db.query<{ day: string; region: string; feature_id: string; n: number }>(
      "select day::text, region, feature_id, count(*)::int as n from public.tomrade_analytics_actor_daily group by 1, 2, 3 order by 1, 2, 3"
    );
    expect(actors.rows).toEqual([
      { day: day(DAY1), region: "apac", feature_id: "*", n: 1 },
      { day: day(DAY1), region: "apac", feature_id: "backlog.table", n: 1 },
      { day: day(DAY1), region: "na", feature_id: "*", n: 2 },
      { day: day(DAY1), region: "na", feature_id: "backlog.board", n: 1 },
      { day: day(DAY1), region: "na", feature_id: "backlog.create", n: 1 },
      { day: day(DAY1), region: "na", feature_id: "backlog.table", n: 1 },
      { day: day(DAY2), region: "na", feature_id: "*", n: 2 },
      { day: day(DAY2), region: "na", feature_id: "backlog.board", n: 1 },
      { day: day(DAY2), region: "na", feature_id: "backlog.table", n: 1 }
    ]);
  });

  it("is idempotent when a range is recomputed, and folds in a late event once", async () => {
    const before = await db.query<{ sessions: number; active: number }>(
      "select sum(sessions)::int as sessions, sum(active_ms)::int as active from public.tomrade_analytics_feature_daily where day = $1",
      [day(DAY1)]
    );
    await db.query("select public.tomrade_analytics_aggregate($1::date, $2::date)", [day(DAY1), day(DAY2)]);
    const after = await db.query<{ sessions: number; active: number }>(
      "select sum(sessions)::int as sessions, sum(active_ms)::int as active from public.tomrade_analytics_feature_daily where day = $1",
      [day(DAY1)]
    );
    expect(after.rows[0]).toEqual(before.rows[0]);

    await ingest([session(C, DAY1, "backlog.board", 5_000)], "US");
    await db.query("select public.tomrade_analytics_aggregate($1::date, $1::date)", [day(DAY1)]);
    const late = await db.query<{ sessions: number; active_ms: number; actors: number }>(
      "select sessions, active_ms::int, actors from public.tomrade_analytics_feature_daily where day = $1 and region = 'na' and feature_id = 'backlog.board'",
      [day(DAY1)]
    );
    expect(late.rows[0]).toEqual({ sessions: 2, active_ms: 65_000, actors: 2 });
  });

  it("answers a report with totals, a daily series, features, actions and retention", async () => {
    const days = await db.query("select day::text, region, feature_id, sessions, active_ms::int from public.tomrade_analytics_feature_daily order by 1,2,3");
    const { rows } = await db.query<{ report: Record<string, unknown> }>(
      "select public.tomrade_analytics_report($1::date, $2::date) as report",
      [day(DAY1), day(DAY2)]
    );
    const report = rows[0]!.report as {
      totals: { duration_ms: number; sessions: number; uses: number; aai: number };
      daily: { day: string; duration_ms: number; sessions: number; uses: number; aai: number }[];
      features: { feature_id: string; duration_ms: number; uses: number; aai: number }[];
      regions: { region: string; duration_ms: number; sessions: number; uses: number; aai: number }[];
      actions: { feature_id: string; action: string; counted_events: number }[];
      retention: { day: string; cohort: number; d1: number; d7: number; d30: number }[];
      latest: string | null;
    };

    expect(report.totals).toEqual({ duration_ms: 215_000, sessions: 4, uses: 6, aai: 3 });
    expect(report.daily.map((d) => ({ day: d.day, duration_ms: d.duration_ms, sessions: d.sessions, aai: d.aai }))).toEqual([
      { day: day(DAY1), duration_ms: 185_000, sessions: 3, aai: 3 },
      { day: day(DAY2), duration_ms: 30_000, sessions: 1, aai: 2 }
    ]);
    expect(report.features[0]).toEqual({ feature_id: "backlog.table", sessions: 1, duration_ms: 120_000, uses: 3, aai: 1 });
    expect(report.features.find((f) => f.feature_id === "backlog.board")).toEqual({ feature_id: "backlog.board", sessions: 3, duration_ms: 95_000, uses: 2, aai: 2 });
    expect(report.features.find((f) => f.feature_id === "backlog.create")).toEqual({ feature_id: "backlog.create", sessions: 0, duration_ms: 0, uses: 1, aai: 1 });
    expect(report.regions).toEqual([
      { region: "na", duration_ms: 215_000, sessions: 4, uses: 5, aai: 3 },
      { region: "apac", duration_ms: 0, sessions: 0, uses: 1, aai: 1 }
    ]);
    expect(report.actions).toContainEqual({ feature_id: "backlog.board", action: "open", events: 2, counted_events: 2 });
    expect(report.retention).toEqual([{ day: day(DAY1), cohort: 3, d1: 2, d7: 0, d30: 0 }]);
    expect(report.latest).toBeTruthy();

    const us = await db.query<{ report: { totals: { duration_ms: number; sessions: number; uses: number; aai: number } } }>(
      "select public.tomrade_analytics_report($1::date, $2::date, 'na') as report",
      [day(DAY1), day(DAY2)]
    );
    expect(us.rows[0]!.report.totals).toEqual({ duration_ms: 215_000, sessions: 4, uses: 5, aai: 3 });
  });

  it("answers the dashboard's feature-by-day series, filtered by region", async () => {
    const all = await db.query<{ result: { days: { day: string; region: string; feature_id: string; duration_ms: number; sessions: number; uses: number }[] } }>(
      "select public.tomrade_analytics_feature_days($1::date, $2::date) as result",
      [day(DAY1), day(DAY2)]
    );
    expect(all.rows[0]!.result.days).toContainEqual({ day: day(DAY1), region: "na", feature_id: "backlog.board", duration_ms: 65000, sessions: 2, uses: 1 });
    expect(all.rows[0]!.result.days).toContainEqual({ day: day(DAY1), region: "apac", feature_id: "backlog.table", duration_ms: 0, sessions: 0, uses: 1 });
    const na = await db.query<{ result: { days: { region: string }[] } }>(
      "select public.tomrade_analytics_feature_days($1::date, $2::date, 'na') as result",
      [day(DAY1), day(DAY2)]
    );
    expect(na.rows[0]!.result.days.every((row) => row.region === "na")).toBe(true);
    expect(na.rows[0]!.result.days).toHaveLength(5);
  });

  it("allows only the service role to read dashboard aggregates", async () => {
    await db.exec("set role anon");
    try {
      await expect(db.query("select public.tomrade_analytics_feature_days($1::date, $2::date)", [day(DAY1), day(DAY2)])).rejects.toThrow(/permission denied/);
      await expect(db.query("select public.tomrade_analytics_report($1::date, $2::date)", [day(DAY1), day(DAY2)])).rejects.toThrow(/permission denied/);
    } finally { await db.exec("reset role"); }
    await db.exec("set role service_role");
    try {
      const result = await db.query("select public.tomrade_analytics_feature_days($1::date, $2::date)", [day(DAY1), day(DAY2)]);
      expect(result.rows).toHaveLength(1);
      await db.query("select public.tomrade_analytics_report($1::date, $2::date)", [day(DAY1), day(DAY2)]);
    } finally { await db.exec("reset role"); }
  });

  it("refuses a range it cannot answer", async () => {
    await expect(db.query("select public.tomrade_analytics_report($1::date, $2::date)", [day(DAY2), day(DAY1)])).rejects.toThrow(/not a range/);
    await expect(db.query("select public.tomrade_analytics_report($1::date, $2::date, 'mars')", [day(DAY1), day(DAY2)])).rejects.toThrow(/unknown region/);
  });
});
