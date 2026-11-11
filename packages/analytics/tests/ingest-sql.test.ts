import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEATURE_REGISTRY_VERSION, featureById, registrySnapshot } from "../src/features.js";

// The real migration in PostgreSQL (WASM), with only the two Supabase roles stubbed.
const db = new PGlite();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const ANON = "k3m4q2v7x5b6n4r6t2y3wzq4sc";

const batch = (events: unknown[]) => ({ batch_id: randomUUID(), sent_at: Date.now(), events });
const base = () => ({ schema: 1, registry: 1, anon_id: ANON, install_seq: 1, ts: Date.now(), client: "0.2.0", platform: "macos" });

async function ingest(payload: unknown, headers: Record<string, string> = {}) {
  await db.exec("reset role");
  await db.query("select set_config('request.headers', $1, false)", [JSON.stringify(headers)]);
  await db.exec("set role anon");
  try {
    return await db.query<{ result: { accepted: number; duplicates: number; rejected: number; received: number } }>(
      "select public.tomrade_ingest_analytics($1::jsonb) as result",
      [JSON.stringify(payload)]
    );
  } finally {
    await db.exec("reset role");
  }
}

const count = async (table: string) => (await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0]!.n;

beforeAll(async () => {
  // Supabase's sessions run in UTC; the WASM database would take the machine's zone, and a date range turned into
  // timestamps there would miss the events of the hours its date and UTC's differ.
  await db.exec("set timezone = 'UTC'");
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(migration("202610230001_analytics.sql"));
  await db.exec(migration("202610230002_analytics_region_scope.sql"));
  await db.exec(migration("202610230003_analytics_aggregate.sql"));
  await db.exec(migration("202610290001_analytics_activation.sql"));
  await db.exec(migration("202610310001_analytics_plugin_layout.sql"));
  await db.exec(migration("202611040001_analytics_internal_functions.sql"));
  await db.exec(migration("202611040002_analytics_new_install_cap.sql"));
  await db.exec(migration("202611060002_analytics_event_unused_indexes.sql"));
  await db.exec(migration("202611110101_analytics_registry_fallback.sql"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("analytics ingest", () => {
  it("takes the three events, computes counted from the registry and keeps the dim", async () => {
    const start = { ...base(), event_id: randomUUID(), event: "app.start", feature_id: null, first_run: true };
    const activate = { ...base(), install_seq: 2, event_id: randomUUID(), event: "feature.activate", feature_id: "backlog.create", action: "create", dim: "quick" };
    const session = {
      ...base(), install_seq: 3, event_id: randomUUID(), event: "feature.session", feature_id: "backlog.board",
      session_id: randomUUID(), started_at: Date.now() - 300_000, ended_at: Date.now(), active_ms: 300_000, idle_ms: 0, segments: 1, end_reason: "switch"
    };
    const { rows } = await ingest(batch([start, activate, session]));
    expect(rows[0]!.result).toEqual({ accepted: 3, duplicates: 0, rejected: 0, received: 3 });

    const stored = await db.query<{ event: string; counted: boolean; dim: string | null; region: string; active_ms: number | null }>(
      "select event, counted, dim, region, active_ms from public.tomrade_analytics_event order by install_seq"
    );
    expect(stored.rows).toEqual([
      { event: "app.start", counted: false, dim: null, region: "other", active_ms: null },
      { event: "feature.activate", counted: true, dim: "quick", region: "other", active_ms: null },
      { event: "feature.session", counted: false, dim: null, region: "other", active_ms: 300_000 }
    ]);
  });

  it("holds the same registry as packages/analytics, row for row", async () => {
    const { rows } = await db.query<{ feature_id: string; action: string; counted: boolean; dims: string[] | null }>(
      "select feature_id, action, counted, dims from public.tomrade_analytics_registry where registry = $1 order by feature_id, action",
      [FEATURE_REGISTRY_VERSION]
    );
    const snapshot = registrySnapshot();
    // A feature with a dim action carries its closed set on that action only; the rest on every action.
    const dimAction = (id: string) => featureById(id)?.dimAction;
    const expected = snapshot.features
      .flatMap((feature) => feature.actions.map((action) => ({
        feature_id: feature.id,
        action: action.name,
        counted: !!action.counted,
        dims: feature.dims && (!dimAction(feature.id) || dimAction(feature.id) === action.name) ? feature.dims : null
      })))
      .sort((a, b) => a.feature_id.localeCompare(b.feature_id) || a.action.localeCompare(b.action));
    const stored = [...rows].sort((a, b) => a.feature_id.localeCompare(b.feature_id) || a.action.localeCompare(b.action));
    expect(stored).toEqual(expected);
    // Registry 1 stays exactly as an older client knows it: registry 2 added five steps, registry 3 one surface.
    const old = await db.query<{ n: number }>("select count(*)::int as n from public.tomrade_analytics_registry where registry = 1");
    expect(old.rows[0]!.n).toBe(rows.length - 6);
  });

  it("takes registry 2's activation steps, never as a use, and flags none of them unknown", async () => {
    const steps = [["onboarding", "setup_done"], ["code.link", "project_repo_linked"], ["code.link", "claim_external"], ["agent.chat", "plan_applied"], ["agent.chat", "run_reverted"]];
    const events = steps.map(([feature_id, action], i) => ({ ...base(), registry: 2, install_seq: 100 + i, event_id: randomUUID(), event: "feature.activate", feature_id, action, dim: null }));
    const old = { ...base(), registry: 2, install_seq: 110, event_id: randomUUID(), event: "feature.activate", feature_id: "code.link", action: "start", dim: null };
    const { rows } = await ingest(batch([...events, old]));
    expect(rows[0]!.result).toEqual({ accepted: 6, duplicates: 0, rejected: 0, received: 6 });
    const stored = await db.query<{ feature_id: string; action: string; counted: boolean; unknown_feature: boolean; registry: number }>(
      "select feature_id, action, counted, unknown_feature, registry from public.tomrade_analytics_event where registry = 2 order by install_seq"
    );
    expect(stored.rows).toEqual([
      ...steps.map(([feature_id, action]) => ({ feature_id, action, counted: false, unknown_feature: false, registry: 2 })),
      { feature_id: "code.link", action: "start", counted: true, unknown_feature: false, registry: 2 }
    ]);
    // An older client cannot name them.
    const early = { ...base(), registry: 1, install_seq: 120, event_id: randomUUID(), event: "feature.activate", feature_id: "agent.chat", action: "plan_applied", dim: null };
    expect((await ingest(batch([early]))).rows[0]!.result).toMatchObject({ accepted: 0, rejected: 1 });
    await db.exec("delete from public.tomrade_analytics_event where registry = 2");
  });

  it("is idempotent for a retried batch", async () => {
    const event = { ...base(), event_id: randomUUID(), event: "feature.activate", feature_id: "backlog.board", action: "open", dim: null };
    const payload = batch([event]);
    const first = await ingest(payload);
    expect(first.rows[0]!.result).toMatchObject({ accepted: 1, duplicates: 0 });
    const again = await ingest(payload);
    expect(again.rows[0]!.result).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(await count("tomrade_analytics_event")).toBe(4);
  });

  it("rejects the whole batch when an event carries a field outside the contract", async () => {
    const event = { ...base(), event_id: randomUUID(), event: "feature.activate", feature_id: "backlog.board", action: "open", title: "a private ticket" };
    await expect(ingest(batch([event]))).rejects.toThrow(/outside the contract/);
    expect(await count("tomrade_analytics_event")).toBe(4);
  });

  it("keeps an unknown feature flagged, drops an unregistered dim, and rejects an unknown action", async () => {
    const unknown = { ...base(), event_id: randomUUID(), event: "feature.activate", feature_id: "future.thing", action: "open" };
    const dim = { ...base(), install_seq: 2, event_id: randomUUID(), event: "feature.activate", feature_id: "backlog.create", action: "create", dim: "paste" };
    const badAction = { ...base(), install_seq: 3, event_id: randomUUID(), event: "feature.activate", feature_id: "backlog.board", action: "delete" };
    const { rows } = await ingest(batch([unknown, dim, badAction]));
    expect(rows[0]!.result).toMatchObject({ accepted: 2, rejected: 1 });
    const stored = await db.query<{ feature_id: string; dim: string | null; unknown_feature: boolean }>(
      "select feature_id, dim, unknown_feature from public.tomrade_analytics_event where event_id in ($1, $2) order by feature_id",
      [unknown.event_id, dim.event_id]
    );
    expect(stored.rows).toEqual([
      { feature_id: "backlog.create", dim: null, unknown_feature: false },
      { feature_id: "future.thing", dim: null, unknown_feature: true }
    ]);
  });

  it("refuses a session whose active time exceeds its wall clock", async () => {
    const now = Date.now();
    const session = {
      ...base(), event_id: randomUUID(), event: "feature.session", feature_id: "backlog.board",
      session_id: randomUUID(), started_at: now - 10_000, ended_at: now, active_ms: 60_000, idle_ms: 0, segments: 1, end_reason: "switch"
    };
    const { rows } = await ingest(batch([session]));
    expect(rows[0]!.result).toMatchObject({ accepted: 0, rejected: 1 });
  });

  it("infers only the five coarse regions and stores neither country nor IP", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ "cf-ipcountry": "CN" }, "cn"],
      [{ "cf-ipcountry": "JP" }, "apac"],
      [{ "cf-ipcountry": "DE" }, "eu"],
      [{ "x-vercel-ip-country": "US" }, "na"],
      [{ "cf-ipcountry": "ZZ" }, "other"],
      [{}, "other"]
    ];
    for (const [headers, region] of cases) {
      const event = { ...base(), event_id: randomUUID(), event: "feature.activate", feature_id: "backlog.board", action: "open", dim: null };
      await ingest(batch([event]), headers);
      const stored = await db.query<{ region: string }>("select region from public.tomrade_analytics_event where event_id = $1", [event.event_id]);
      expect(stored.rows[0]!.region).toBe(region);
    }
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'tomrade_analytics_event'"
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of ["ip", "ip_address", "email", "account", "user_id", "project_id", "path", "title", "repo"]) expect(names).not.toContain(forbidden);
  });

  it("does not let the public roles read or write the tables directly", async () => {
    await db.exec("reset role; set role anon");
    await expect(db.query("select * from public.tomrade_analytics_event")).rejects.toThrow();
    await expect(db.query("insert into public.tomrade_analytics_event(event_id, schema, registry, event, anon_id, install_seq, ts, client, platform, region) values (gen_random_uuid(), 1, 1, 'app.start', $1, 1, now(), '0.1.0', 'macos', 'other')", [ANON])).rejects.toThrow();
    await db.exec("reset role");
  });

  // The ingests above ran as anon after these were closed, so ingest still reaches them.
  it("keeps ingest's helpers closed to the public roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`reset role; set role ${role}`);
      try {
        await expect(db.query("select public.tomrade_analytics_ensure_month('1999-01-01'::timestamptz)")).rejects.toThrow(/permission denied/);
        await expect(db.query("select public.tomrade_analytics_region()")).rejects.toThrow(/permission denied/);
        await expect(db.query("select public.tomrade_analytics_scope_allows('cn')")).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec("reset role");
      }
    }
    expect((await db.query("select to_regclass('public.tomrade_analytics_event_1999_01') is null as absent")).rows[0]).toEqual({ absent: true });
  });

  it("indexes every month, old or new, by its key and region alone", async () => {
    await db.exec("reset role");
    await db.query("select public.tomrade_analytics_ensure_month(now())");
    await db.query("select public.tomrade_analytics_ensure_month('2031-03-15'::timestamptz)");
    const indexes = await db.query<{ partition: string; columns: string }>(
      `select c.relname as partition, string_agg(a.attname, ',' order by k.ord) as columns
         from pg_inherits h
         join pg_class c on c.oid = h.inhrelid
         join pg_index i on i.indrelid = c.oid
         cross join unnest(i.indkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
        where h.inhparent = 'public.tomrade_analytics_event'::regclass
        group by c.relname, i.indexrelid`
    );
    const months = new Set(indexes.rows.map((r) => r.partition));
    expect(months.size).toBeGreaterThanOrEqual(2);
    for (const month of months) {
      expect(indexes.rows.filter((r) => r.partition === month).map((r) => r.columns).sort(), month).toEqual(["event_id,ts", "region,ts"]);
    }
    await db.exec("drop table public.tomrade_analytics_event_2031_03");
  });

  it("keeps each deployment's detail on its side", async () => {
    const cn = { ...base(), event_id: randomUUID(), event: "feature.activate", feature_id: "backlog.board", action: "open", dim: null };
    const us = { ...base(), install_seq: 2, event_id: randomUUID(), event: "feature.activate", feature_id: "backlog.board", action: "open", dim: null };

    await db.exec("set tomrade.analytics_scope = 'global'");
    await expect(ingest(batch([cn]), { "cf-ipcountry": "CN" })).rejects.toThrow(/does not accept cn/);
    expect((await ingest(batch([us]), { "cf-ipcountry": "US" })).rows[0]!.result.accepted).toBe(1);

    await db.exec("set tomrade.analytics_scope = 'cn'");
    const fr = { ...base(), install_seq: 3, event_id: randomUUID(), event: "feature.activate", feature_id: "backlog.board", action: "open", dim: null };
    await expect(ingest(batch([fr]), { "cf-ipcountry": "FR" })).rejects.toThrow(/does not accept eu/);
    expect((await ingest(batch([{ ...cn, event_id: randomUUID(), install_seq: 4 }]), { "cf-ipcountry": "CN" })).rows[0]!.result.accepted).toBe(1);
    // Only what this test set: `reset all` would take the session's UTC away too.
    await db.exec("reset tomrade.analytics_scope");
  });

  it("drops only whole event partitions past 180 days and aggregates past 25 months", async () => {
    await db.exec("reset role");
    const old = new Date(Date.now() - 400 * 24 * 60 * 60_000);
    await db.query("select public.tomrade_analytics_ensure_month($1::timestamptz)", [old.toISOString()]);
    await db.query(
      `insert into public.tomrade_analytics_event (event_id, schema, registry, event, anon_id, install_seq, ts, client, platform, region)
       values (gen_random_uuid(), 1, 1, 'app.start', $1, 1, $2::timestamptz, '0.1.0', 'macos', 'other')`,
      [ANON, old.toISOString()]
    );
    await db.query("insert into public.tomrade_analytics_actor_daily (day, region, feature_id, anon_id) values ($1::date, 'other', '*', $2)", [old.toISOString().slice(0, 10), ANON]);
    const aggregate = new Date(Date.now() - 800 * 24 * 60 * 60_000);
    await db.query("insert into public.tomrade_analytics_feature_daily (day, region, feature_id, client_minor) values ($1::date, 'other', 'backlog.board', '0.2')", [aggregate.toISOString().slice(0, 10)]);
    const before = await db.query<{ n: number }>("select count(*)::int as n from public.tomrade_analytics_actor_daily");
    expect(before.rows[0]!.n).toBe(1);

    const result = await db.query<{ result: { partitions: number; actors: number; features: number } }>("select public.tomrade_analytics_retention() as result");
    expect(result.rows[0]!.result.partitions).toBe(1);
    expect(result.rows[0]!.result.actors).toBe(1);
    expect(result.rows[0]!.result.features).toBe(1);
    const left = await db.query<{ n: number }>("select count(*)::int as n from public.tomrade_analytics_event where ts < now() - interval '180 days'");
    expect(left.rows[0]!.n).toBe(0);
  });

  it("caps the installs it meets for the first time in an hour, never one it already knows", async () => {
    const seen = async () => (await db.query<{ n: number }>(
      "select coalesce(sum(installs), 0)::int as n from public.tomrade_analytics_new_installs where hour = date_trunc('hour', now(), 'UTC')"
    )).rows[0]!.n;
    const start = (anon: string) => ({ ...base(), anon_id: anon, event_id: randomUUID(), event: "app.start", feature_id: null });
    await db.exec(`set tomrade.analytics_new_installs_per_hour = '${(await seen()) + 1}'`);
    try {
      expect((await ingest(batch([start("b".repeat(26))]))).rows[0]!.result.accepted).toBe(1);
      const before = await count("tomrade_analytics_event");
      await expect(ingest(batch([start("c".repeat(26))]))).rejects.toMatchObject({ code: "PT429" });
      expect(await count("tomrade_analytics_event")).toBe(before);
      expect((await ingest(batch([start(ANON)]))).rows[0]!.result.accepted).toBe(1);
    } finally {
      await db.exec("reset tomrade.analytics_new_installs_per_hour");
    }
    await db.exec("reset role; set role anon");
    try {
      await expect(db.query("select * from public.tomrade_analytics_new_installs")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("activation funnel", () => {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  // Noon UTC 25 days ago: the cohort's install day, well inside detail retention.
  const d0 = Math.floor((Date.now() - 25 * DAY) / DAY) * DAY + 12 * HOUR;
  const iso = (ms: number) => new Date(ms).toISOString();
  const day = (ms: number) => iso(ms).slice(0, 10);
  const id = (letter: string) => `${"a".repeat(25)}${letter}`;
  let seq = 0;

  async function put(anon: string, at: number, action: string | null, region = "na") {
    await db.query("select public.tomrade_analytics_ensure_month($1::timestamptz)", [iso(at)]);
    const feature = action === null ? null : action === "setup_done" ? "onboarding" : "code.link";
    await db.query(
      `insert into public.tomrade_analytics_event (event_id, schema, registry, event, anon_id, install_seq, ts, client, platform, region, feature_id, action)
       values (gen_random_uuid(), 1, 2, $1, $2, $3, $4::timestamptz, '0.3.0', 'macos', $5, $6, $7)`,
      [action === null ? "app.start" : "feature.activate", anon, ++seq, iso(at), region, feature, action]
    );
  }
  const activation = async (from: number, to: number, region: string | null = null) =>
    (await db.query<{ result: Record<string, unknown> }>("select public.tomrade_analytics_activation($1::date, $2::date, $3) as result", [day(from), day(to), region])).rows[0]!.result;

  beforeAll(async () => {
    await db.exec("reset role");
    // A: the whole way, merged within a week, back on day 3.
    await put(id("a"), d0, null);
    await put(id("a"), d0 + HOUR, "setup_done");
    await put(id("a"), d0 + 3 * HOUR, "start");
    await put(id("a"), d0 + DAY, "open_pr");
    await put(id("a"), d0 + 2 * DAY, "merge");
    await put(id("a"), d0 + 3 * DAY, null);
    // B: set up and started, then gone until day 10.
    await put(id("b"), d0, null);
    await put(id("b"), d0 + HOUR, "setup_done");
    await put(id("b"), d0 + 5 * HOUR, "start");
    await put(id("b"), d0 + 10 * DAY, null);
    // C: started without the first-run milestone, back the next day.
    await put(id("c"), d0, null);
    await put(id("c"), d0 + HOUR, "start");
    await put(id("c"), d0 + DAY, null);
    // D: everything, but only from day 8 on.
    await put(id("d"), d0, null);
    await put(id("d"), d0 + 8 * DAY, "setup_done");
    await put(id("d"), d0 + 8 * DAY + HOUR, "start");
    await put(id("d"), d0 + 8 * DAY + 2 * HOUR, "open_pr");
    await put(id("d"), d0 + 9 * DAY, "merge");
    // E: installed before the range.
    await put(id("e"), d0 - 20 * DAY, null);
    await put(id("e"), d0 + HOUR, "setup_done");
    // F: installed in mainland China, nothing else.
    await put(id("f"), d0, null, "cn");
  });

  afterAll(async () => {
    await db.query("delete from public.tomrade_analytics_event where anon_id like $1", [`${"a".repeat(25)}%`]);
  });

  it("follows the range's installs up to now, each step needing every one before it", async () => {
    const result = await activation(d0 - DAY, d0 + DAY);
    expect(result.funnel).toEqual({ installs: 5, setup_done: 3, start: 3, open_pr: 2, merge: 2 });
    // C's start counts towards the time to start though it skipped setup: 1h, 3h, 5h, 8d.
    expect(result.first_start).toEqual({ median_ms: 4 * HOUR, n: 4 });
    expect(result.merged_7d).toEqual({ cohort: 5, merged: 1 });
    expect(result.week_return).toEqual({ cohort: 5, returned: 2 });
  });

  it("narrows to a region and leaves no median when nobody started", async () => {
    const result = await activation(d0 - DAY, d0 + DAY, "cn");
    expect(result.funnel).toEqual({ installs: 1, setup_done: 0, start: 0, open_pr: 0, merge: 0 });
    expect(result.first_start).toEqual({ median_ms: null, n: 0 });
    expect((await activation(d0 - DAY, d0 + DAY, "all")).funnel).toMatchObject({ installs: 5 });
  });

  it("holds a cohort too young for its windows out of them", async () => {
    // Installs from yesterday on (the other tests' among them): none has had seven days yet.
    const now = Date.now();
    const before = (await activation(now - DAY, now)).funnel as { installs: number; setup_done: number };
    await put(id("g"), now - HOUR, null);
    await put(id("g"), now - HOUR / 2, "setup_done");
    const result = await activation(now - DAY, now);
    expect(result.funnel).toMatchObject({ installs: before.installs + 1, setup_done: before.setup_done + 1 });
    expect(result.merged_7d).toEqual({ cohort: 0, merged: 0 });
    expect(result.week_return).toEqual({ cohort: 0, returned: 0 });
  });

  it("refuses a backwards range and an unknown region, and is not open to the public roles", async () => {
    await expect(activation(d0, d0 - DAY)).rejects.toThrow(/not a range/);
    await expect(activation(d0, d0, "mars")).rejects.toThrow(/unknown region/);
    await db.exec("set role anon");
    try {
      await expect(db.query("select public.tomrade_analytics_activation(current_date, current_date, null)")).rejects.toThrow();
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("a registry this server does not have yet", () => {
  const NEWER = FEATURE_REGISTRY_VERSION + 1;
  const anon = "f".repeat(26);
  const event = (registry: number, feature_id: string, action: string, install_seq: number, ts = Date.now()) =>
    ({ ...base(), anon_id: anon, registry, install_seq, ts, event_id: randomUUID(), event: "feature.activate", feature_id, action, dim: null });

  afterAll(async () => {
    await db.exec("reset role");
    await db.query("delete from public.tomrade_analytics_event where anon_id = $1", [anon]);
  });

  it("reads the newest one below it, keeping what it lacks uncounted and the client's version stored", async () => {
    const { rows } = await ingest(batch([
      event(NEWER, "backlog.plugin", "open", 1),
      event(NEWER, "backlog.board", "open_again", 2),
      event(NEWER, "future.thing", "open", 3)
    ]));
    expect(rows[0]!.result).toEqual({ accepted: 3, duplicates: 0, rejected: 0, received: 3 });
    const stored = await db.query<{ feature_id: string; counted: boolean; unknown_feature: boolean; registry: number }>(
      "select feature_id, counted, unknown_feature, registry from public.tomrade_analytics_event where anon_id = $1 order by install_seq",
      [anon]
    );
    expect(stored.rows).toEqual([
      { feature_id: "backlog.plugin", counted: true, unknown_feature: false, registry: NEWER },
      { feature_id: "backlog.board", counted: false, unknown_feature: false, registry: NEWER },
      { feature_id: "future.thing", counted: false, unknown_feature: true, registry: NEWER }
    ]);
  });

  it("counts, once its registry arrives, the uses that came before it and rolls their day up again", async () => {
    await db.exec("reset role");
    const ts = Date.now() - 2 * 86_400_000;
    const day = new Date(ts).toISOString().slice(0, 10);
    await db.query("select public.tomrade_analytics_ensure_month($1::timestamptz)", [new Date(ts).toISOString()]);
    // As production stored them before the fix: a use and a step, both uncounted, under a registry not pushed yet.
    for (const [seq, feature_id, action] of [[10, "backlog.board", "open"], [11, "onboarding", "setup_done"]] as const) {
      await db.query(
        `insert into public.tomrade_analytics_event (event_id, schema, registry, event, anon_id, install_seq, ts, client, platform, region, feature_id, action, counted, unknown_feature)
         values (gen_random_uuid(), 1, $1, 'feature.activate', $2, $3, $4::timestamptz, '0.9.0', 'macos', 'other', $5, $6, false, true)`,
        [NEWER, anon, seq, new Date(ts).toISOString(), feature_id, action]
      );
    }
    await db.query("select public.tomrade_analytics_aggregate($1::date, $1::date)", [day]);
    const uses = async () => (await db.query<{ action: string; events: number; counted_events: number }>(
      "select action, events, counted_events from public.tomrade_analytics_action_daily where day = $1::date and client_minor = '0.9' order by action",
      [day]
    )).rows;
    expect(await uses()).toEqual([{ action: "open", events: 1, counted_events: 0 }, { action: "setup_done", events: 1, counted_events: 0 }]);

    await db.query(
      `insert into public.tomrade_analytics_registry (registry, feature_id, action, counted, dims)
       select $1, feature_id, action, counted, dims from public.tomrade_analytics_registry where registry = $2`,
      [NEWER, FEATURE_REGISTRY_VERSION]
    );
    try {
      await db.exec(migration("202611110101_analytics_registry_fallback.sql"));
      expect(await uses()).toEqual([{ action: "open", events: 1, counted_events: 1 }, { action: "setup_done", events: 1, counted_events: 0 }]);
      // Run again, nothing moves.
      await db.exec(migration("202611110101_analytics_registry_fallback.sql"));
      expect(await uses()).toEqual([{ action: "open", events: 1, counted_events: 1 }, { action: "setup_done", events: 1, counted_events: 0 }]);
    } finally {
      await db.query("delete from public.tomrade_analytics_registry where registry = $1", [NEWER]);
    }
  });
});
