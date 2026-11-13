import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

// The real migrations in PostgreSQL (WASM); only Supabase's auth schema and roles are stubbed.
const db = new PGlite();
const alice = randomUUID(), bob = randomUUID();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const facts = (platform: string) => ({ platform, arch: "x64", version: "0.29.0", git: true, agents: [], repos: [] });
async function actor(id: string, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec(`set role ${role}`);
}
interface Row { id: string; state: string; reason: string | null; claimed_by: string | null; to_device: string | null; to_platform: string | null; wish: unknown; title: string }
const create = async (from: string, to: string | null, key: string, opts: { platform?: string; wish?: unknown; ttl?: number; title?: string } = {}) =>
  (await db.query<{ r: Row }>("select public.tomrade_create_dispatch($1, $2, $3, 'p-0001', $4, $5, $6::jsonb, $7) as r", [from, to, opts.platform ?? null, key, opts.title ?? "A ticket", JSON.stringify(opts.wish ?? {}), opts.ttl ?? 3600])).rows[0].r;
const claim = async (id: string, device: string) => (await db.query<{ r: Row | null }>("select public.tomrade_claim_dispatch($1, $2) as r", [id, device])).rows[0].r;
const update = async (id: string, device: string, state: string, reason: string | null = null) => (await db.query<{ r: Row }>("select public.tomrade_update_dispatch($1, $2, $3, $4) as r", [id, device, state, reason])).rows[0].r;
const cancel = async (id: string, reason: string | null = null) => (await db.query<{ r: Row }>("select public.tomrade_cancel_dispatch($1, $2) as r", [id, reason])).rows[0].r;

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
  await db.query("insert into auth.users values ($1), ($2)", [alice, bob]);
  for (const name of ["202611110001_devices.sql", "202611110002_device_limit.sql", "202611110003_device_activity.sql", "202611110004_device_accept.sql", "202611110005_dispatches.sql", "202611140001_dispatch_roles.sql"]) await db.exec(migration(name));
  // Alice subscribes: three machines. Bob has one.
  await db.query("insert into public.tomrade_entitlements(user_id, plan, device_limit) values ($1, 'placeholder_plus', null)", [alice]);
  await actor(alice);
  for (const [device, platform] of [["mac-0001", "darwin"], ["win-0001", "win32"], ["win-0002", "win32"]]) await db.query("select public.tomrade_register_device($1, $1, $2::jsonb)", [device, JSON.stringify(facts(platform))]);
  await actor(bob);
  await db.query("select public.tomrade_register_device('bob-0001', 'Bob', $1::jsonb)", [JSON.stringify(facts("win32"))]);
}, 30_000);
afterAll(async () => { await db.close(); });

it("goes from queued to accepted, running and done on the machine it names", async () => {
  await actor(alice);
  const sent = await create("mac-0001", "win-0001", "TOM-1", { wish: { engine: "claude-code", permissionMode: "acceptEdits" }, title: "x".repeat(250) });
  expect(sent).toMatchObject({ state: "queued", to_device: "win-0001", to_platform: null, wish: { engine: "claude-code", permissionMode: "acceptEdits" }, claimed_by: null });
  expect(sent.title).toHaveLength(200);
  // Not the machine that asked, and not another one.
  expect(await claim(sent.id, "mac-0001")).toBeNull();
  expect(await claim(sent.id, "win-0002")).toBeNull();
  expect(await claim(sent.id, "win-0001")).toMatchObject({ state: "accepted", claimed_by: "win-0001" });
  expect(await claim(sent.id, "win-0001")).toBeNull();
  await expect(update(sent.id, "win-0002", "running")).rejects.toThrow(/cannot go to running/);
  expect(await update(sent.id, "win-0001", "running")).toMatchObject({ state: "running" });
  await expect(update(sent.id, "win-0001", "refused", "too late")).rejects.toThrow(/cannot go to refused/);
  expect(await update(sent.id, "win-0001", "done", "stopped: out of quota")).toMatchObject({ state: "done", reason: "stopped: out of quota" });
  await expect(update(sent.id, "win-0001", "running")).rejects.toThrow(/cannot go/);
  await expect(cancel(sent.id)).rejects.toThrow(/no longer going/);
});

it("lets only one of two machines take a request made for a platform", async () => {
  await actor(alice);
  const sent = await create("mac-0001", null, "TOM-2", { platform: "win32" });
  expect(sent).toMatchObject({ to_device: null, to_platform: "win32" });
  expect(await claim(sent.id, "mac-0001")).toBeNull();
  const taken = await Promise.all([claim(sent.id, "win-0001"), claim(sent.id, "win-0002")]);
  expect(taken.filter(Boolean)).toHaveLength(1);
  const winner = taken.find(Boolean)!.claimed_by!;
  const loser = winner === "win-0001" ? "win-0002" : "win-0001";
  await expect(update(sent.id, loser, "running")).rejects.toThrow(/cannot go/);
  expect(await update(sent.id, winner, "refused", "no agent is signed in here")).toMatchObject({ state: "refused", reason: "no agent is signed in here" });
});

it("asks one machine at a time to work a ticket", async () => {
  await actor(alice);
  const first = await create("mac-0001", "win-0001", "TOM-3");
  await expect(create("mac-0001", "win-0002", "TOM-3")).rejects.toThrow(/already sent to a machine/);
  // The machine it names may say no without taking it; then another may be asked.
  expect(await update(first.id, "win-0001", "refused", "this computer does not accept work")).toMatchObject({ state: "refused", claimed_by: "win-0001" });
  const second = await create("mac-0001", "win-0002", "TOM-3");
  expect(await cancel(second.id, "changed my mind")).toMatchObject({ state: "cancelled", reason: "changed my mind" });
  expect(await claim(second.id, "win-0002")).toBeNull();
  // Cancelled while it runs: the row says so, for the taking machine to stop.
  const third = await create("mac-0001", "win-0002", "TOM-3");
  await claim(third.id, "win-0002");
  await update(third.id, "win-0002", "running");
  expect(await cancel(third.id)).toMatchObject({ state: "cancelled" });
  await expect(update(third.id, "win-0002", "done")).rejects.toThrow(/cannot go/);
});

it("is no longer on offer once its time has run out, and makes room for the next", async () => {
  await actor(alice);
  const sent = await create("mac-0001", "win-0001", "TOM-4", { ttl: 60 });
  await db.exec("reset role");
  await db.query("update public.tomrade_dispatches set expires_at = now() - interval '1 second' where id = $1", [sent.id]);
  await actor(alice);
  expect(await claim(sent.id, "win-0001")).toBeNull();
  const next = await create("mac-0001", "win-0001", "TOM-4");
  expect(next.id).not.toBe(sent.id);
  expect((await db.query<{ state: string; reason: string }>("select state, reason from public.tomrade_dispatches where id = $1", [sent.id])).rows[0]).toEqual({ state: "cancelled", reason: "expired" });
  await cancel(next.id);
});

it("carries the id of a role, and nothing a role says", async () => {
  await actor(alice);
  const sent = await create("mac-0001", "win-0001", "TOM-20", { wish: { role: "1f0e9a7c-0000-4000-8000-000000000001", engine: "codex" } });
  expect(sent.wish).toEqual({ role: "1f0e9a7c-0000-4000-8000-000000000001", engine: "codex" });
  await cancel(sent.id);
  await expect(create("mac-0001", "win-0001", "TOM-21", { wish: { role: "no spaces allowed" } })).rejects.toThrow(/Invalid dispatch/);
  await expect(create("mac-0001", "win-0001", "TOM-21", { wish: { role: { id: "x" } } })).rejects.toThrow(/Invalid dispatch/);
  await expect(create("mac-0001", "win-0001", "TOM-21", { wish: { role: "careful", instructions: "anything" } })).rejects.toThrow(/Invalid dispatch/);
});

it("puts a request back when the machine that took it stops before the work starts", async () => {
  await actor(alice);
  const sent = await create("mac-0001", null, "TOM-22", { platform: "win32" });
  expect(await claim(sent.id, "win-0001")).toMatchObject({ state: "accepted", claimed_by: "win-0001" });
  // only the machine that holds it puts it back
  await expect(update(sent.id, "win-0002", "queued")).rejects.toThrow(/cannot go to queued/);
  expect(await update(sent.id, "win-0001", "queued", "ignored")).toMatchObject({ state: "queued", claimed_by: null, reason: null });
  // and the other machine of the platform may take it now
  expect(await claim(sent.id, "win-0002")).toMatchObject({ state: "accepted", claimed_by: "win-0002" });
  expect(await update(sent.id, "win-0002", "running")).toMatchObject({ state: "running" });
  // once the work runs there is no putting it back
  await expect(update(sent.id, "win-0002", "queued")).rejects.toThrow(/cannot go to queued/);
  await cancel(sent.id);
});

it("lets the next machine take a request whose taker went quiet before starting, and never one that runs", async () => {
  await actor(alice);
  const sent = await create("mac-0001", null, "TOM-23", { platform: "win32" });
  expect(await claim(sent.id, "win-0001")).toMatchObject({ claimed_by: "win-0001" });
  // a claim just made is the claimer's
  expect(await claim(sent.id, "win-0002")).toBeNull();
  const age = async (minutes: number) => {
    await db.exec("reset role");
    await db.query("update public.tomrade_dispatches set updated_at = now() - make_interval(mins => $2) where id = $1", [sent.id, minutes]);
    await actor(alice);
  };
  await age(4);
  expect(await claim(sent.id, "win-0002")).toBeNull();
  // saying it is still at it keeps the claim
  await age(6);
  expect(await update(sent.id, "win-0001", "accepted")).toMatchObject({ state: "accepted", claimed_by: "win-0001" });
  expect(await claim(sent.id, "win-0002")).toBeNull();
  // quiet for longer than a machine may be: of the two that ask at once, one gets it
  await age(6);
  expect(await claim(sent.id, "mac-0001")).toBeNull();
  const taken = await Promise.all([claim(sent.id, "win-0002"), claim(sent.id, "win-0001")]);
  expect(taken.filter(Boolean)).toHaveLength(1);
  const holder = taken.find(Boolean)!.claimed_by!;
  expect(await update(sent.id, holder, "running")).toMatchObject({ state: "running" });
  // running, however long ago it was last heard of, is nobody else's to take
  await age(600);
  expect(await claim(sent.id, holder === "win-0001" ? "win-0002" : "win-0001")).toBeNull();
  expect(await claim(sent.id, holder)).toBeNull();
  await cancel(sent.id);

  // one made for a single machine is that machine's alone, quiet or not
  const named = await create("mac-0001", "win-0001", "TOM-24");
  expect(await claim(named.id, "win-0001")).toBeTruthy();
  await db.exec("reset role");
  await db.query("update public.tomrade_dispatches set updated_at = now() - interval '1 hour' where id = $1", [named.id]);
  await actor(alice);
  expect(await claim(named.id, "win-0002")).toBeNull();
  expect(await claim(named.id, "win-0001")).toMatchObject({ state: "accepted", claimed_by: "win-0001" });
  await cancel(named.id);
});

it("is the account's alone, between machines that hold a place, with nothing but the fields it names", async () => {
  await actor(alice);
  const sent = await create("mac-0001", "win-0001", "TOM-5");
  await expect(db.query("update public.tomrade_dispatches set state = 'done'")).rejects.toThrow(/permission denied/);
  await expect(db.query("insert into public.tomrade_dispatches(user_id, from_device, to_device, project_id, item_key, title, expires_at) values ($1, 'mac-0001', 'win-0001', 'p', 'T-1', 't', now())", [alice])).rejects.toThrow(/permission denied/);
  for (const wish of [{ prompt: "rm -rf" }, { engine: "/usr/local/bin/claude" }, { permissionMode: "by pass" }, { engine: "claude-code", cwd: "/Users/alice" }, []]) await expect(create("mac-0001", "win-0002", "TOM-6", { wish })).rejects.toThrow(/Invalid dispatch/);
  await expect(create("mac-0001", null, "TOM-6")).rejects.toThrow(/Invalid dispatch/);
  await expect(create("mac-0001", "win-0002", "TOM-6", { ttl: 5 })).rejects.toThrow(/Invalid dispatch/);
  await expect(create("mac-0001", "mac-0001", "TOM-6")).rejects.toThrow(/No such device/);
  await expect(create("mac-0001", "bob-0001", "TOM-6")).rejects.toThrow(/No such device/);
  await expect(create("gone-0001", "win-0001", "TOM-6")).rejects.toThrow(/not one of the account's devices/);
  // A machine removed from the account neither sends nor takes.
  await db.query("select public.tomrade_remove_device('win-0001')");
  await expect(claim(sent.id, "win-0001")).rejects.toThrow(/not one of the account's devices/);
  await expect(create("win-0001", "win-0002", "TOM-6")).rejects.toThrow(/not one of the account's devices/);

  await actor(bob);
  expect((await db.query("select id from public.tomrade_dispatches")).rows).toEqual([]);
  expect(await claim(sent.id, "bob-0001")).toBeNull();
  await expect(cancel(sent.id)).rejects.toThrow(/no longer going/);
  await expect(update(sent.id, "bob-0001", "refused")).rejects.toThrow(/cannot go/);
  await actor("", "anon");
  await expect(db.query("select * from public.tomrade_dispatches")).rejects.toThrow(/permission denied/);
  await expect(claim(sent.id, "win-0001")).rejects.toThrow(/permission denied/);
  // It goes with the account.
  await db.exec("reset role");
  await db.query("delete from auth.users where id = $1", [alice]);
  expect((await db.query("select 1 from public.tomrade_dispatches")).rows).toEqual([]);
});
