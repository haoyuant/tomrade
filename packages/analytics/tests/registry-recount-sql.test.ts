import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEATURE_REGISTRY_VERSION } from "../src/features.js";

// Every analytics migration in order, then 202611110104's recount on registry inserts.
const db = new PGlite();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const MIGRATIONS = [
  "202610230001_analytics.sql", "202610230002_analytics_region_scope.sql", "202610230003_analytics_aggregate.sql",
  "202610230004_analytics_feature_days.sql", "202610290001_analytics_activation.sql", "202610310001_analytics_plugin_layout.sql",
  "202611040001_analytics_internal_functions.sql", "202611040002_analytics_new_install_cap.sql", "202611040004_accounts_platforms.sql",
  "202611060002_analytics_event_unused_indexes.sql", "202611110101_analytics_registry_fallback.sql", "202611110102_analytics_activation_claims.sql",
  "202611110103_analytics_internal_ids.sql", "202611110104_analytics_registry_recount.sql"
];
const NEWER = FEATURE_REGISTRY_VERSION + 1;
const ANON = "n".repeat(26);

const utcDay = (ago: number) => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ago, 10);
};
const DAY1 = utcDay(4);
const DAY2 = utcDay(2);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

let seq = 0;
const act = (registry: number, ts: number, feature_id: string, action: string) => ({
  schema: 1, registry, anon_id: ANON, install_seq: ++seq, ts, client: "0.9.0", platform: "macos",
  event_id: randomUUID(), event: "feature.activate", feature_id, action, dim: null
});

async function ingest(events: unknown[]) {
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
const stored = async () => (await db.query<{ registry: number; feature_id: string; action: string; counted: boolean; unknown_feature: boolean }>(
  "select registry, feature_id, action, counted, unknown_feature from public.tomrade_analytics_event where anon_id = $1 order by install_seq",
  [ANON]
)).rows;
const uses = async (ts: number) => (await db.query<{ feature_id: string; action: string; events: number; counted_events: number }>(
  "select feature_id, action, sum(events)::int as events, sum(counted_events)::int as counted_events from public.tomrade_analytics_action_daily where day = $1::date group by feature_id, action order by feature_id, action",
  [day(ts)]
)).rows;

beforeAll(async () => {
  await db.exec("set timezone = 'UTC'");
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key, created_at timestamptz, email_confirmed_at timestamptz, deleted_at timestamptz, is_anonymous boolean not null default false);`);
  for (const name of MIGRATIONS) await db.exec(migration(name));
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("a registry version that lands after its release", () => {
  it("re-judges the events that version already sent and rolls their days up again", async () => {
    // A release on registry NEWER, before its migration: one action every registry has, one action new to a known
    // feature, and a new feature with a use and a step.
    expect(await ingest([
      act(NEWER, DAY1, "backlog.plugin", "open"),
      act(NEWER, DAY1, "backlog.board", "peek"),
      act(NEWER, DAY2, "future.thing", "open"),
      act(NEWER, DAY2, "future.thing", "step")
    ])).toMatchObject({ accepted: 4 });
    // Another release's own registry, untouched by NEWER's rows.
    expect(await ingest([act(FEATURE_REGISTRY_VERSION, DAY1, "backlog.board", "open")])).toMatchObject({ accepted: 1 });
    await db.query("select public.tomrade_analytics_aggregate($1::date, $2::date)", [day(DAY1), day(DAY2)]);
    expect(await uses(DAY1)).toEqual([
      { feature_id: "backlog.board", action: "open", events: 1, counted_events: 1 },
      { feature_id: "backlog.board", action: "peek", events: 1, counted_events: 0 },
      { feature_id: "backlog.plugin", action: "open", events: 1, counted_events: 1 }
    ]);
    expect(await uses(DAY2)).toEqual([
      { feature_id: "future.thing", action: "open", events: 1, counted_events: 0 },
      { feature_id: "future.thing", action: "step", events: 1, counted_events: 0 }
    ]);

    // Its migration, written the way every registry migration is: copy the last version, then add the new rows.
    await db.query(
      `insert into public.tomrade_analytics_registry (registry, feature_id, action, counted, dims)
       select $1, feature_id, action, counted, dims from public.tomrade_analytics_registry where registry = $2`,
      [NEWER, FEATURE_REGISTRY_VERSION]
    );
    await db.query(
      `insert into public.tomrade_analytics_registry (registry, feature_id, action, counted, dims) values
         ($1, 'backlog.board', 'peek', true, null), ($1, 'future.thing', 'open', true, null), ($1, 'future.thing', 'step', false, null)`,
      [NEWER]
    );

    expect(await stored()).toEqual([
      { registry: NEWER, feature_id: "backlog.plugin", action: "open", counted: true, unknown_feature: false },
      { registry: NEWER, feature_id: "backlog.board", action: "peek", counted: true, unknown_feature: false },
      { registry: NEWER, feature_id: "future.thing", action: "open", counted: true, unknown_feature: false },
      { registry: NEWER, feature_id: "future.thing", action: "step", counted: false, unknown_feature: false },
      { registry: FEATURE_REGISTRY_VERSION, feature_id: "backlog.board", action: "open", counted: true, unknown_feature: false }
    ]);
    expect(await uses(DAY1)).toEqual([
      { feature_id: "backlog.board", action: "open", events: 1, counted_events: 1 },
      { feature_id: "backlog.board", action: "peek", events: 1, counted_events: 1 },
      { feature_id: "backlog.plugin", action: "open", events: 1, counted_events: 1 }
    ]);
    expect(await uses(DAY2)).toEqual([
      { feature_id: "future.thing", action: "open", events: 1, counted_events: 1 },
      { feature_id: "future.thing", action: "step", events: 1, counted_events: 0 }
    ]);
  });

  it("judges an event of that version arriving afterwards by its own rows, as before", async () => {
    expect(await ingest([act(NEWER, DAY2, "backlog.board", "peek")])).toMatchObject({ accepted: 1 });
    expect((await stored()).at(-1)).toEqual({ registry: NEWER, feature_id: "backlog.board", action: "peek", counted: true, unknown_feature: false });
  });
});
