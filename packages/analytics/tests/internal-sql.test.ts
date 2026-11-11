import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Every analytics migration in order, with the maintainer's ids told apart by 202611110103.
const db = new PGlite();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const BEFORE = [
  "202610230001_analytics.sql", "202610230002_analytics_region_scope.sql", "202610230003_analytics_aggregate.sql",
  "202610230004_analytics_feature_days.sql", "202610290001_analytics_activation.sql", "202610310001_analytics_plugin_layout.sql",
  "202611040001_analytics_internal_functions.sql", "202611040002_analytics_new_install_cap.sql", "202611040004_accounts_platforms.sql",
  "202611060002_analytics_event_unused_indexes.sql"
];
const REAL = "rrrrrrrrrrrrrrrrrrrrrrrrrr";
const CHECKOUT = "cccccccccccccccccccccccccc";
const MAINTAINER = "mmmmmmmmmmmmmmmmmmmmmmmmmm";
const TAGGED = "tttttttttttttttttttttttttt";

const utcDay = (ago: number, hour = 10) => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ago, hour);
};
const OLD = utcDay(6);
const DAY1 = utcDay(5);
const DAY2 = utcDay(1);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

let seq = 0;
const event = (anon: string, ts: number, client: string, body: Record<string, unknown>) =>
  ({ schema: 1, registry: 2, anon_id: anon, install_seq: ++seq, ts, client, platform: "macos", event_id: randomUUID(), ...body });
const session = (anon: string, ts: number, client: string, activeMs: number) => event(anon, ts, client, {
  event: "feature.session", feature_id: "backlog.board", session_id: randomUUID(),
  started_at: ts - activeMs, ended_at: ts, active_ms: activeMs, idle_ms: 0, segments: 1, end_reason: "switch"
});
const act = (anon: string, ts: number, client: string, feature: string, action: string) =>
  event(anon, ts, client, { event: "feature.activate", feature_id: feature, action, dim: null });
const start = (anon: string, ts: number, client: string) => event(anon, ts, client, { event: "app.start", feature_id: null });

async function ingest(events: unknown[]) {
  await db.query("select set_config('request.headers', $1, false)", [JSON.stringify({ "cf-ipcountry": "US" })]);
  await db.exec("set role anon");
  try {
    const { rows } = await db.query<{ result: { accepted: number } }>("select public.tomrade_ingest_analytics($1::jsonb) as result", [
      JSON.stringify({ batch_id: randomUUID(), sent_at: Date.now(), events })
    ]);
    return rows[0]!.result;
  } finally {
    await db.exec("reset role");
  }
}
const call = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ result: T }>(sql, params)).rows[0]!.result;
const aggregate = (from: number, to: number) => call<Record<string, number>>("select public.tomrade_analytics_aggregate($1::date, $2::date) as result", [day(from), day(to)]);
const splits = async (from: number) => (await db.query<{ internal: boolean; active_ms: number; actors: number }>(
  "select internal, sum(active_ms)::int as active_ms, sum(actors)::int as actors from public.tomrade_analytics_feature_daily where day = $1::date and feature_id = 'backlog.board' group by internal order by internal",
  [day(from)]
)).rows;
const internalIds = async () => (await db.query<{ anon_id: string; rolled: boolean }>("select anon_id, rolled from public.tomrade_analytics_internal order by anon_id")).rows;

beforeAll(async () => {
  await db.exec("set timezone = 'UTC'");
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key, created_at timestamptz, email_confirmed_at timestamptz, deleted_at timestamptz, is_anonymous boolean not null default false);`);
  for (const name of BEFORE) await db.exec(migration(name));
  // Before the migration: a real install, and an unpackaged checkout already rolled up as anyone else.
  await ingest([start(REAL, OLD, "0.28.0"), session(REAL, OLD, "0.28.0", 60_000), act(REAL, OLD + 1000, "0.28.0", "code.link", "claim_external")]);
  await ingest([start(CHECKOUT, OLD, "0.1.0"), session(CHECKOUT, OLD, "0.1.0", 30_000)]);
  await db.query("select public.tomrade_analytics_aggregate($1::date, $2::date)", [day(OLD), day(OLD)]);
  await db.exec(migration("202611110103_analytics_internal_ids.sql"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("internal anonymous ids", () => {
  it("marks the ids that sent a checkout or prerelease build in the backfill, and moves their old rows", async () => {
    expect(await internalIds()).toEqual([{ anon_id: CHECKOUT, rolled: true }]);
    expect(await splits(OLD)).toEqual([{ internal: false, active_ms: 60_000, actors: 1 }, { internal: true, active_ms: 30_000, actors: 1 }]);
  });

  it("classifies by version: prerelease tags, build metadata and 0.1.0 are internal, plain releases are not", async () => {
    const internal = async (client: string) => call<boolean>("select public.tomrade_analytics_internal_client($1) as result", [client]);
    for (const client of ["0.26.0-dev", "0.29.0+internal", "0.1.0"]) expect(await internal(client)).toBe(true);
    for (const client of ["0.28.0", "0.1.1", "1.0.0"]) expect(await internal(client)).toBe(false);
  });

  it("re-splits an id's earlier days once it sends its first non-release event", async () => {
    await ingest([start(MAINTAINER, DAY1, "0.28.0"), session(MAINTAINER, DAY1, "0.28.0", 120_000)]);
    await ingest([session(REAL, DAY1, "0.28.0", 10_000)]);
    await aggregate(DAY1, DAY1);
    expect(await splits(DAY1)).toEqual([{ internal: false, active_ms: 130_000, actors: 2 }]);

    // Days later the same id runs a dev build; the hourly run covers only the recent days.
    expect(await ingest([session(MAINTAINER, DAY2, "0.29.0-dev", 5_000)])).toMatchObject({ accepted: 1 });
    expect((await internalIds()).find((r) => r.anon_id === MAINTAINER)).toEqual({ anon_id: MAINTAINER, rolled: false });
    expect(await aggregate(DAY2, DAY2)).toMatchObject({ resplit_days: 1 });
    expect(await splits(DAY1)).toEqual([{ internal: false, active_ms: 10_000, actors: 1 }, { internal: true, active_ms: 120_000, actors: 1 }]);
    expect(await splits(DAY2)).toEqual([{ internal: true, active_ms: 5_000, actors: 1 }]);
    expect(await aggregate(DAY2, DAY2)).toMatchObject({ resplit_days: 0 });
  });

  it("takes a release build's +internal version through ingest and marks its id", async () => {
    expect(await ingest([start(TAGGED, DAY2, "0.29.0+internal"), session(TAGGED, DAY2, "0.29.0+internal", 7_000)])).toMatchObject({ accepted: 2 });
    await aggregate(DAY2, DAY2);
    expect(await splits(DAY2)).toEqual([{ internal: true, active_ms: 12_000, actors: 2 }]);
  });

  it("leaves internal ids out of every dashboard RPC when asked, and keeps the old numbers by default", async () => {
    type Report = { totals: { duration_ms: number; aai: number }; retention: { cohort: number }[]; latest: string | null };
    const report = (exclude?: boolean) => call<Report>(
      exclude === undefined
        ? "select public.tomrade_analytics_report($1::date, $2::date, null) as result"
        : "select public.tomrade_analytics_report($1::date, $2::date, null, $3) as result",
      exclude === undefined ? [day(OLD), day(DAY2)] : [day(OLD), day(DAY2), exclude]
    );
    expect((await report()).totals).toMatchObject({ duration_ms: 60_000 + 30_000 + 130_000 + 12_000, aai: 4 });
    expect((await report(false)).totals).toMatchObject({ aai: 4 });
    const real = await report(true);
    expect(real.totals).toMatchObject({ duration_ms: 70_000, aai: 1 });
    expect(real.retention.reduce((n, r) => n + r.cohort, 0)).toBe(1);

    const days = await call<{ days: { duration_ms: number }[] }>("select public.tomrade_analytics_feature_days($1::date, $2::date, null, true) as result", [day(OLD), day(DAY2)]);
    expect(days.days.reduce((n, d) => n + d.duration_ms, 0)).toBe(70_000);

    const platforms = await call<{ platforms: { aai: number; duration_ms: number }[] }>("select public.tomrade_analytics_platforms($1::date, $2::date, null, true) as result", [day(OLD), day(DAY2)]);
    expect(platforms.platforms).toEqual([{ platform: "macos", aai: 1, duration_ms: 70_000 }]);

    type Funnel = { funnel: { installs: number }; first_start: { n: number } };
    const activation = (exclude: boolean) => call<Funnel>("select public.tomrade_analytics_activation($1::date, $2::date, null, $3) as result", [day(OLD), day(DAY2), exclude]);
    expect((await activation(false)).funnel.installs).toBe(4);
    // The real install claimed a ticket from its own terminal: that is its first start (TOM-1060).
    expect(await activation(true)).toMatchObject({ funnel: { installs: 1 }, first_start: { median_ms: 1000, n: 1 } });
  });

  it("resolves PostgREST's named arguments to one function each, granted only to the service role", async () => {
    const { rows } = await db.query<{ proname: string; n: number }>(
      `select proname, count(*)::int as n from pg_proc where proname in ('tomrade_analytics_report', 'tomrade_analytics_feature_days', 'tomrade_analytics_activation', 'tomrade_analytics_platforms') group by proname order by proname`
    );
    expect(rows.map((r) => r.n)).toEqual([1, 1, 1, 1]);
    const named = await call<{ totals: { aai: number } }>(
      "select public.tomrade_analytics_report(p_from => $1::date, p_to => $2::date, p_region => null, p_exclude_internal => true) as result", [day(OLD), day(DAY2)]
    );
    expect(named.totals.aai).toBe(1);
    await db.exec("set role anon");
    try {
      await expect(db.query("select public.tomrade_analytics_report(current_date, current_date, null, true)")).rejects.toThrow();
      await expect(db.query("select * from public.tomrade_analytics_internal")).rejects.toThrow();
    } finally {
      await db.exec("reset role");
    }
  });

  it("forgets an internal id once retention has removed all its detail", async () => {
    await db.query("delete from public.tomrade_analytics_event where anon_id = $1", [CHECKOUT]);
    await db.query("delete from public.tomrade_analytics_actor_daily where anon_id = $1", [CHECKOUT]);
    expect(await call<{ internal: number }>("select public.tomrade_analytics_retention() as result")).toMatchObject({ internal: 1 });
    expect((await internalIds()).map((r) => r.anon_id)).toEqual([MAINTAINER, TAGGED]);
  });
});
