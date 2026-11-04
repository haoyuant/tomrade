/**
 * Two machines on one account Hub, against the Hub as Supabase runs it: the real migration in PostgreSQL (WASM),
 * with only Supabase's auth schema stubbed. Versions, receipts and jsonb — which hands a value's keys back in its own
 * order — are the database's own; the client only carries each call there.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Storage } from "@tomradex/storage";
import Settings from "@tomradex/settings";
import { CloudHub } from "../src/service.js";

const sql = vi.hoisted(() => ({
  db: null as unknown as import("@electric-sql/pglite").PGlite,
  user: "",
  /** Mutations that reached the database. */
  mutations: 0,
  /** One call at a time: each sets who is asking before it asks. */
  turn: Promise.resolve() as Promise<unknown>
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => {
  const user = () => ({ id: sql.user, email: "user@example.test", user_metadata: {} });
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = sql.turn.then(work, work);
    sql.turn = next.catch(() => undefined);
    return next;
  };
  const asUser = async () => {
    await sql.db.exec("reset role");
    await sql.db.query("select set_config('request.jwt.claim.sub', $1, false)", [sql.user]);
    await sql.db.exec("set role authenticated");
  };
  // What supabase-js hands back for an exception the database raised.
  const failed = (error: unknown) => ({ data: null, error: { message: (error as Error).message, code: (error as { code?: string }).code ?? "P0001" } });
  return {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: { user: user() } }, error: null }),
      stopAutoRefresh() {},
      signOut: async () => ({ error: null }),
      updateUser: async () => ({ data: { user: user() }, error: null })
    },
    rpc: (name: string, args?: { p_hub: string; p_mutation: unknown }) => inTurn(async () => {
      await asUser();
      try {
        if (name === "tomrade_ensure_hub") return { data: (await sql.db.query<{ id: string }>("select public.tomrade_ensure_hub() as id")).rows[0]!.id, error: null };
        if (name === "tomrade_mutate_hub") {
          sql.mutations++;
          const r = await sql.db.query<{ result: unknown }>("select public.tomrade_mutate_hub($1, $2::jsonb) as result", [args!.p_hub, JSON.stringify(args!.p_mutation)]);
          return { data: r.rows[0]!.result, error: null };
        }
        throw new Error(`no such function ${name}`);
      } catch (error) {
        return failed(error);
      }
    }),
    from: (table: string) => {
      const where = { hub: "", since: null as string | null };
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => ((where.hub = value), query),
        gt: (_column: string, value: string) => ((where.since = value), query),
        order: () => query,
        range: (from: number, to: number) => inTurn(async () => {
          await asUser();
          try {
            const params: unknown[] = [where.hub, from, to - from + 1, ...(where.since ? [where.since] : [])];
            const r = await sql.db.query<{ kind: string; key: string; value: unknown; version: number; updated_at: Date }>(
              `select kind, key, value, version, updated_at from public.${table} where hub_id = $1 ${where.since ? "and updated_at > $4::timestamptz" : ""} order by kind, key offset $2 limit $3`,
              params
            );
            return { data: r.rows.map((row) => ({ ...row, updated_at: new Date(row.updated_at).toISOString() })), error: null };
          } catch (error) {
            return failed(error);
          }
        })
      };
      return query;
    }
  };
} }));

const dirs: string[] = [];
const contexts: { fiber: { dispose(): Promise<unknown> } }[] = [];
beforeAll(async () => {
  sql.db = new PGlite();
  sql.user = randomUUID();
  await sql.db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await sql.db.query("insert into auth.users values ($1)", [sql.user]);
  await sql.db.exec(fs.readFileSync(new URL("../../../supabase/migrations/202609100001_hub.sql", import.meta.url), "utf8"));
}, 60_000);
afterAll(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  await sql.db.close();
});

async function machine(device: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hub-sql-"));
  dirs.push(dir);
  const bag = await fresh({ hubDir: path.join(dir, "hub"), device, plugins: [
    [Settings, { path: path.join(dir, "settings.json") }],
    [Storage, { watch: false, reconcileMs: 0, snapshotIdleMs: 60_000, snapshotMaxMs: 60_000 }]
  ] });
  contexts.push(bag.ctx);
  await bag.ctx.storage.ready;
  // Used here, so the account's, not a first run's placeholder.
  bag.projects.update(bag.project.id, { description: `Worked on ${device}` });
  await bag.ctx.plugin(CloudHub, {
    url: "https://example.supabase.co", publishableKey: "sb_publishable_test", cacheFile: path.join(dir, "hub-cloud.json"),
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, syncMs: 60_000
  });
  await settle();
  await bag.ctx.cloudHub.ready;
  return { ...bag, cloud: bag.ctx.cloudHub };
}

it("two machines on one account agree through the real Hub, settle a clash once it is chosen, and then send nothing", async () => {
  const a = await machine("hub-a");
  await a.cloud.sync();
  const b = await machine("hub-b");
  await b.cloud.sync();
  expect(b.cloud.info().conflicts).toEqual([]);
  const both = [a, b];

  // A project and a setting on A, then a setting on B.
  const made = a.ctx.projects.create({ name: "Made on A", keyPrefix: "MOA" });
  await a.ctx.storage.writeHub();
  a.ctx.settings.set({ ...a.ctx.settings.get(), theme: "matcha" });
  await a.cloud.sync();
  for (let i = 0; i < 2; i++) await b.cloud.sync();
  b.ctx.settings.set({ ...b.ctx.settings.get(), language: "zh" });
  await b.cloud.sync();
  for (let i = 0; i < 2; i++) await a.cloud.sync();
  for (const m of both) {
    expect(m.cloud.info().conflicts).toEqual([]);
    expect(m.cloud.info().status.state).toBe("synced");
    expect(m.cloud.manifest().projects.map((p) => p.id).sort()).toEqual([a.project.id, b.project.id, made.id].sort());
    expect(m.ctx.settings.get()).toMatchObject({ theme: "matcha", language: "zh" });
  }

  // The same document changed on both before either heard of the other: the second to send waits for the person.
  a.ctx.settings.set({ ...a.ctx.settings.get(), theme: "light" });
  b.ctx.settings.set({ ...b.ctx.settings.get(), theme: "dark" });
  await a.cloud.sync();
  await b.cloud.sync();
  expect(b.cloud.info().conflicts.map((c) => c.id)).toEqual(["preference:settings"]);
  // As the account panel's choice does (account.resolve): settle, apply, sync.
  b.cloud.cache.resolve("preference:settings", "cloud");
  b.ctx.settings.refreshUserStore();
  await b.cloud.sync();
  await a.cloud.sync();
  for (const m of both) {
    expect(m.cloud.info().conflicts).toEqual([]);
    expect(m.cloud.info().status.state).toBe("synced");
    expect(m.ctx.settings.get()).toMatchObject({ theme: "light", language: "zh" });
  }

  // Settled: what each machine has is what the Hub has, and asking again changes nothing anywhere.
  const sent = sql.mutations;
  const told = both.map((m) => vi.spyOn(m.ctx.settings, "refreshUserStore"));
  for (let i = 0; i < 3; i++) {
    for (const m of both) {
      await m.ctx.storage.writeHub();
      await m.cloud.sync();
    }
  }
  expect(sql.mutations).toBe(sent);
  for (const spy of told) expect(spy).not.toHaveBeenCalled();
  for (const m of both) expect(m.cloud.info()).toMatchObject({ pending: 0, conflicts: [] });
}, 60_000);
