import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

// The real migrations in PostgreSQL (WASM); only Supabase's auth schema and roles are stubbed.
const db = new PGlite();
const free = randomUUID(), paid = randomUUID(), early = randomUUID();
const facts = { platform: "darwin", arch: "arm64", version: "0.29.0", git: true, agents: [], repos: [] };
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
async function actor(id: string, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec(`set role ${role}`);
}
const register = async (device: string, rejoin = false) =>
  (await db.query<{ r: { state: string; limit?: number; plan?: string } }>(
    "select public.tomrade_register_device($1, $2, $3::jsonb, $4) as r", [device, device, JSON.stringify(facts), rejoin]
  )).rows[0].r;
const plan = async () => (await db.query<{ r: { plan: string; limit: number | null; used: number } }>("select public.tomrade_device_plan() as r")).rows[0].r;
const entitle = async (user: string, limit: number | null, expires: string | null = null) => {
  await db.exec("reset role");
  await db.query(
    "insert into public.tomrade_entitlements(user_id, plan, device_limit, expires_at) values ($1, 'placeholder_plus', $2, $3::timestamptz) on conflict (user_id) do update set device_limit = excluded.device_limit, expires_at = excluded.expires_at",
    [user, limit, expires]
  );
};

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.query("insert into auth.users values ($1), ($2), ($3)", [free, paid, early]);
  await db.exec(migration("202611110001_devices.sql"));
  // Before the limit existed: an account that already has three machines.
  await actor(early);
  for (const device of ["early-0001", "early-0002", "early-0003"]) await register(device);
  await db.exec("reset role");
  await db.exec(migration("202611110002_device_limit.sql"));
}, 30_000);
afterAll(async () => { await db.close(); });

it("gives a free account two machines, and tells the third why it has no place", async () => {
  await actor(free);
  expect(await plan()).toEqual({ plan: "free", limit: 2, used: 0 });
  expect(await register("free-0001")).toMatchObject({ state: "registered" });
  expect(await register("free-0002")).toMatchObject({ state: "registered" });
  expect(await register("free-0003")).toEqual({ state: "over_limit", limit: 2, plan: "free" });
  expect((await db.query("select device_id from public.tomrade_devices order by device_id")).rows).toEqual([{ device_id: "free-0001" }, { device_id: "free-0002" }]);
  // The two that have a place go on saying what changed.
  expect(await register("free-0001")).toMatchObject({ state: "registered" });
  expect(await plan()).toEqual({ plan: "free", limit: 2, used: 2 });
});

it("opens a place when a machine is removed, and a removed one needs a place to come back", async () => {
  await actor(free);
  await db.query("select public.tomrade_remove_device('free-0001')");
  expect(await plan()).toMatchObject({ used: 1 });
  expect(await register("free-0003")).toMatchObject({ state: "registered" });
  // Signed in again on the removed one: the account is full now.
  expect(await register("free-0001")).toEqual({ state: "removed" });
  expect(await register("free-0001", true)).toEqual({ state: "over_limit", limit: 2, plan: "free" });
  await db.query("select public.tomrade_remove_device('free-0002')");
  expect(await register("free-0001", true)).toMatchObject({ state: "registered" });
});

it("lets a subscription raise the limit or lift it, until it runs out", async () => {
  await entitle(paid, 3);
  await actor(paid);
  expect(await plan()).toEqual({ plan: "placeholder_plus", limit: 3, used: 0 });
  for (const device of ["paid-0001", "paid-0002", "paid-0003"]) expect(await register(device)).toMatchObject({ state: "registered" });
  expect(await register("paid-0004")).toEqual({ state: "over_limit", limit: 3, plan: "placeholder_plus" });
  await entitle(paid, null);
  await actor(paid);
  expect(await plan()).toEqual({ plan: "placeholder_plus", limit: null, used: 3 });
  for (const device of ["paid-0004", "paid-0005"]) expect(await register(device)).toMatchObject({ state: "registered" });
  // Ran out: back to the free plan's two. The five it has stay; a sixth has no place.
  await entitle(paid, null, "2020-01-01T00:00:00Z");
  await actor(paid);
  expect(await plan()).toEqual({ plan: "free", limit: 2, used: 5 });
  expect(await register("paid-0006")).toEqual({ state: "over_limit", limit: 2, plan: "free" });
  expect(await register("paid-0001")).toMatchObject({ state: "registered" });
});

it("keeps the machines an account had before the limit, and adds no more", async () => {
  await actor(early);
  expect(await plan()).toEqual({ plan: "free", limit: 2, used: 3 });
  for (const device of ["early-0001", "early-0002", "early-0003"]) expect(await register(device)).toMatchObject({ state: "registered" });
  expect(await register("early-0004")).toEqual({ state: "over_limit", limit: 2, plan: "free" });
  // Down to two: still full. Down to one: a place.
  await db.query("select public.tomrade_remove_device('early-0003')");
  expect(await register("early-0004")).toMatchObject({ state: "over_limit" });
  await db.query("select public.tomrade_remove_device('early-0002')");
  expect(await register("early-0004")).toMatchObject({ state: "registered" });
});

it("lets no API role write a subscription or read another account's", async () => {
  await actor(free);
  await expect(db.query("insert into public.tomrade_entitlements(user_id, plan, device_limit) values ($1, 'placeholder_plus', null)", [free])).rejects.toThrow(/permission denied/);
  await expect(db.query("update public.tomrade_entitlements set device_limit = null")).rejects.toThrow(/permission denied/);
  await expect(db.query("delete from public.tomrade_entitlements")).rejects.toThrow(/permission denied/);
  expect((await db.query("select user_id from public.tomrade_entitlements")).rows).toEqual([]);
  await expect(db.query("select public.tomrade_device_allowance($1)", [paid])).rejects.toThrow(/permission denied/);
  await actor(paid);
  expect((await db.query("select user_id from public.tomrade_entitlements")).rows).toEqual([{ user_id: paid }]);
  await actor("", "anon");
  await expect(db.query("select * from public.tomrade_entitlements")).rejects.toThrow(/permission denied/);
  await expect(db.query("select public.tomrade_device_plan()")).rejects.toThrow(/permission denied/);
  // A plan id nobody defined is refused even from the service role.
  await db.exec("reset role");
  await expect(db.query("insert into public.tomrade_entitlements(user_id, plan) values ($1, 'made_up')", [free])).rejects.toThrow(/check constraint/);
  // It goes with the account.
  await db.query("delete from auth.users where id = $1", [paid]);
  expect((await db.query("select 1 from public.tomrade_entitlements")).rows).toEqual([]);
});
