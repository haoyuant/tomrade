import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

// The real migrations in PostgreSQL (WASM); only Supabase's auth schema and roles are stubbed.
const db = new PGlite();
const alice = randomUUID(), bob = randomUUID(), carol = randomUUID();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const facts = (platform: string, accept = true) => ({ platform, arch: "x64", version: "0.29.0", git: true, agents: [{ id: "claude-code", title: "Claude Code", ready: true }], repos: ["https://github.com/acme/secret"], ...(accept ? { accept: { on: true, projects: "all", ceiling: "full", concurrent: 1 } } : {}) });
async function actor(id: string, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec(`set role ${role}`);
}
interface Row { id: string; state: string; reason: string | null; claimed_by: string | null; to_device: string | null; wish: unknown; from_email: string | null; needs_yes: boolean; approved: boolean; ceiling: string | null }
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0]!.r;
const share = (device: string, email: string, ceiling = "edits", auto = false) => one<{ email: string; ceiling: string; auto: boolean }>("select public.tomrade_share_device($1, $2, $3, $4) as r", [device, email, ceiling, auto]);
const unshare = (device: string, email: string) => one<number>("select public.tomrade_unshare_device($1, $2) as r", [device, email]);
const shares = (device: string) => one<{ email: string; ceiling: string; auto: boolean }[]>("select public.tomrade_device_shares($1) as r", [device]);
interface Shared { share: string; owner: string; device_id: string; name: string; platform: string; agents: unknown[]; accept: unknown; ceiling: string; auto: boolean; last_seen_at: string }
const shared = () => one<Shared[]>("select public.tomrade_shared_devices() as r");
const ask = (shareId: string, from: string, key: string, wish: unknown = {}) => one<Row>("select public.tomrade_create_shared_dispatch($1, $2, 'p-0001', $3, 'A ticket', $4::jsonb, 3600) as r", [shareId, from, key, JSON.stringify(wish)]);
const approve = (id: string, device: string) => one<Row>("select public.tomrade_approve_dispatch($1, $2) as r", [id, device]);
const claim = (id: string, device: string) => one<Row | null>("select public.tomrade_claim_dispatch($1, $2) as r", [id, device]);
const update = (id: string, device: string, state: string, reason: string | null = null) => one<Row>("select public.tomrade_update_dispatch($1, $2, $3, $4) as r", [id, device, state, reason]);
const cancel = (id: string) => one<Row>("select public.tomrade_cancel_dispatch($1, null) as r", [id]);
const seen = async () => (await db.query<{ id: string; item_key: string }>("select id, item_key from public.tomrade_dispatches order by item_key")).rows.map((r) => r.item_key);

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.query("insert into auth.users values ($1, 'Alice@Example.test'), ($2, 'bob@example.test'), ($3, 'carol@example.test')", [alice, bob, carol]);
  for (const name of ["202611110001_devices.sql", "202611110002_device_limit.sql", "202611110003_device_activity.sql", "202611110004_device_accept.sql", "202611110005_dispatches.sql", "202611140001_dispatch_roles.sql", "202611140002_device_shares.sql"]) await db.exec(migration(name));
  await db.query("insert into public.tomrade_entitlements(user_id, plan, device_limit) values ($1, 'placeholder_plus', null)", [alice]);
  await actor(alice);
  for (const [device, platform] of [["mac-0001", "darwin"], ["win-0001", "win32"]]) await db.query("select public.tomrade_register_device($1, $1, $2::jsonb)", [device, JSON.stringify(facts(platform!))]);
  await actor(bob);
  await db.query("select public.tomrade_register_device('bob-0001', 'Bob laptop', $1::jsonb)", [JSON.stringify(facts("darwin", false))]);
  await actor(carol);
  await db.query("select public.tomrade_register_device('car-0001', 'Carol', $1::jsonb)", [JSON.stringify(facts("linux", false))]);
}, 30_000);
afterAll(async () => { await db.close(); });

it("is the owner's to give, one machine to one address, and says the same whether or not the address is anyone's", async () => {
  await actor(alice);
  expect(await share("win-0001", "  Bob@Example.test ")).toMatchObject({ email: "bob@example.test", ceiling: "edits", auto: false });
  // an address nobody has is taken just the same: nothing here says who is a user
  expect(await share("win-0001", "nobody@example.test", "ask")).toMatchObject({ email: "nobody@example.test", ceiling: "ask", auto: false });
  // given again, it is changed, not doubled
  expect(await share("win-0001", "bob@example.test", "ask", true)).toMatchObject({ ceiling: "ask", auto: true });
  expect((await shares("win-0001")).map((s) => [s.email, s.ceiling, s.auto])).toEqual([["bob@example.test", "ask", true], ["nobody@example.test", "ask", false]]);
  expect(await shares("mac-0001")).toEqual([]);
  await expect(share("win-0001", "alice@example.test")).rejects.toThrow(/own address/);
  await expect(share("win-0001", "not an address")).rejects.toThrow(/Invalid share/);
  await expect(share("win-0001", "bob@example.test", "everything")).rejects.toThrow(/Invalid share/);
  await expect(share("bob-0001", "carol@example.test")).rejects.toThrow(/not one of the account's devices/);
  expect(await share("win-0001", "bob@example.test", "edits", false)).toMatchObject({ ceiling: "edits", auto: false });
  // the table itself is nobody's to read or write
  await expect(db.query("select * from public.tomrade_device_shares")).rejects.toThrow(/permission denied/);
  await actor(bob);
  await expect(db.query("select * from public.tomrade_device_shares")).rejects.toThrow(/permission denied/);
  expect(await shares("win-0001")).toEqual([]);
});

it("shows the other person the machine, and no more of it than choosing one needs", async () => {
  await actor(bob);
  const mine = await shared();
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ owner: "alice@example.test", device_id: "win-0001", name: "win-0001", platform: "win32", ceiling: "edits", auto: false, agents: [{ id: "claude-code", title: "Claude Code", ready: true }], accept: { on: true, projects: "all", ceiling: "full" } });
  expect(Object.keys(mine[0]!).sort()).toEqual(["accept", "agents", "auto", "ceiling", "device_id", "last_seen_at", "name", "owner", "platform", "share"]);
  expect(JSON.stringify(mine)).not.toContain("secret");
  // neither the owner's devices nor anyone's dispatches are theirs to read
  expect((await db.query<{ device_id: string }>("select device_id from public.tomrade_devices")).rows.map((r) => r.device_id)).toEqual(["bob-0001"]);
  await actor(carol);
  expect(await shared()).toEqual([]);
  await actor(alice);
  expect(await shared()).toEqual([]);
});

it("waits for the owner's yes on that machine before it can be taken", async () => {
  await actor(bob);
  const [mine] = await shared();
  const sent = await ask(mine!.share, "bob-0001", "TOM-1", { role: "careful" });
  expect(sent).toMatchObject({ state: "queued", to_device: "win-0001", from_email: "bob@example.test", needs_yes: true, approved: false, ceiling: "edits", wish: { role: "careful" } });
  // the person who asked reads how it stands, and that one alone
  expect(await seen()).toEqual(["TOM-1"]);
  // only from a machine of their own, to a machine shared with them
  await expect(ask(mine!.share, "win-0001", "TOM-2")).rejects.toThrow(/not one of the account's devices/);
  await expect(ask(randomUUID(), "bob-0001", "TOM-2")).rejects.toThrow(/No such shared device/);
  await expect(ask(mine!.share, "bob-0001", "TOM-2", { prompt: "rm -rf" })).rejects.toThrow(/Invalid dispatch/);
  await expect(ask(mine!.share, "bob-0001", "TOM-1")).rejects.toThrow(/already sent/);
  // it is not theirs to say yes to, nor to take
  await expect(approve(sent.id, "bob-0001")).rejects.toThrow(/no longer waits|not one of/);
  await actor(carol);
  await expect(ask(mine!.share, "car-0001", "TOM-3")).rejects.toThrow(/No such shared device/);
  expect(await seen()).toEqual([]);
  await expect(cancel(sent.id)).rejects.toThrow(/no longer going/);

  await actor(alice);
  // in the owner's queue, for that machine, not yet takable
  expect(await seen()).toEqual(["TOM-1"]);
  expect(await claim(sent.id, "win-0001")).toBeNull();
  // the yes is said on the machine it is for
  await expect(approve(sent.id, "mac-0001")).rejects.toThrow(/no longer waits/);
  expect(await approve(sent.id, "win-0001")).toMatchObject({ needs_yes: true, approved: true, state: "queued" });
  await expect(approve(sent.id, "win-0001")).rejects.toThrow(/no longer waits/);
  expect(await claim(sent.id, "mac-0001")).toBeNull();
  expect(await claim(sent.id, "win-0001")).toMatchObject({ state: "accepted", claimed_by: "win-0001" });
  expect(await update(sent.id, "win-0001", "running")).toMatchObject({ state: "running" });
  await actor(bob);
  expect((await db.query<{ state: string; claimed_by: string }>("select state, claimed_by from public.tomrade_dispatches")).rows).toEqual([{ state: "running", claimed_by: "win-0001" }]);
  // the person who asked may take it back; it is not theirs to move otherwise
  await expect(update(sent.id, "bob-0001", "done")).rejects.toThrow(/cannot go/);
  expect(await cancel(sent.id)).toMatchObject({ state: "cancelled" });
});

it("can be turned away by the owner, and needs no yes where the owner said so", async () => {
  await actor(bob);
  const [mine] = await shared();
  const sent = await ask(mine!.share, "bob-0001", "TOM-4");
  await actor(alice);
  expect(await update(sent.id, "win-0001", "refused", "declined")).toMatchObject({ state: "refused", reason: "declined" });
  await share("win-0001", "bob@example.test", "ask", true);
  await actor(bob);
  const again = await ask(mine!.share, "bob-0001", "TOM-4");
  expect(again).toMatchObject({ needs_yes: false, approved: true, ceiling: "ask" });
  await actor(alice);
  expect(await claim(again.id, "win-0001")).toMatchObject({ state: "accepted" });
  expect(await update(again.id, "win-0001", "done")).toMatchObject({ state: "done" });
});

it("taken back, hides the machine and cancels what that person still has going there", async () => {
  await actor(bob);
  const [mine] = await shared();
  const waiting = await ask(mine!.share, "bob-0001", "TOM-5");
  await actor(alice);
  // one of the owner's own, to the same machine, is not that person's
  const own = await one<Row>("select public.tomrade_create_dispatch('mac-0001', 'win-0001', null, 'p-0001', 'TOM-6', 'Mine', '{}'::jsonb, 3600) as r");
  expect(await unshare("win-0001", "bob@example.test")).toBe(1);
  expect(await unshare("win-0001", "bob@example.test")).toBe(0);
  expect((await db.query<{ item_key: string; state: string; reason: string | null }>("select item_key, state, reason from public.tomrade_dispatches where id in ($1, $2) order by item_key", [waiting.id, own.id])).rows)
    .toEqual([{ item_key: "TOM-5", state: "cancelled", reason: "unshared" }, { item_key: "TOM-6", state: "queued", reason: null }]);
  await actor(bob);
  expect(await shared()).toEqual([]);
  await expect(ask(mine!.share, "bob-0001", "TOM-7")).rejects.toThrow(/No such shared device/);
  // a machine removed from the account is no longer anyone's to send to
  await actor(alice);
  await share("mac-0001", "bob@example.test");
  await db.query("select public.tomrade_remove_device('mac-0001')");
  await actor(bob);
  expect(await shared()).toEqual([]);
  await actor("", "anon");
  await expect(db.query("select public.tomrade_shared_devices()")).rejects.toThrow(/permission denied/);
});
