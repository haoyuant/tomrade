import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  await db.exec("create role anon; create role authenticated;");
  await db.exec(migration("202610230001_analytics.sql"));
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
});
