import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

// The real migration in PostgreSQL (WASM); only Supabase's auth schema and roles are stubbed.
const db = new PGlite();
const alice = randomUUID(), bob = randomUUID();
const facts = { platform: "darwin", arch: "arm64", version: "0.29.0", git: true, agents: [{ id: "claude-code", title: "Claude Code", ready: true }], repos: ["https://github.com/acme/app", "git@github.com:acme/tools"] };
async function actor(id: string, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec(`set role ${role}`);
}
const register = async (device: string, name: string, value: unknown = facts, rejoin = false) =>
  (await db.query<{ r: { state: string; device?: { device_id: string; name: string; facts: unknown } } }>(
    "select public.tomrade_register_device($1, $2, $3::jsonb, $4) as r", [device, name, JSON.stringify(value), rejoin]
  )).rows[0].r;
const mine = async () => (await db.query<{ device_id: string; name: string; removed_at: string | null }>("select device_id, name, removed_at from public.tomrade_devices order by device_id")).rows;

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
  await db.exec(fs.readFileSync(new URL("../../../supabase/migrations/202611110001_devices.sql", import.meta.url), "utf8"));
}, 30_000);
afterAll(async () => { await db.close(); });

it("registers a machine for its own account only, and keeps a name the account changed", async () => {
  await actor(alice);
  expect(await register("mac-0001", "  Alice's Mac ")).toMatchObject({ state: "registered", device: { device_id: "mac-0001", name: "Alice's Mac", facts } });
  await register("win-0001", "DESKTOP-1");
  await db.query("select public.tomrade_rename_device('win-0001', 'Windows tower')");
  // What it can do changed; the name it would give itself is not taken again.
  expect(await register("win-0001", "DESKTOP-1", { ...facts, platform: "win32", git: false })).toMatchObject({ device: { name: "Windows tower", facts: { platform: "win32", git: false } } });

  await actor(bob);
  expect(await mine()).toEqual([]);
  await expect(db.query("select public.tomrade_rename_device('mac-0001', 'Mine now')")).rejects.toThrow(/No such device/);
  await expect(db.query("select public.tomrade_remove_device('mac-0001')")).rejects.toThrow(/No such device/);
  await register("mac-0001", "Bob's Mac");
  expect((await mine()).map((d) => d.name)).toEqual(["Bob's Mac"]);
  await actor(alice);
  expect((await mine()).map((d) => d.name)).toEqual(["Alice's Mac", "Windows tower"]);
});

it("refuses direct writes, anonymous callers, and anything but the fields it names", async () => {
  await actor(alice);
  await expect(db.query("update public.tomrade_devices set name = 'hijacked'")).rejects.toThrow(/permission denied/);
  await expect(db.query("insert into public.tomrade_devices(user_id, device_id, name) values ($1, 'evil-0001', 'x')", [alice])).rejects.toThrow(/permission denied/);
  await expect(db.query("delete from public.tomrade_devices")).rejects.toThrow(/permission denied/);
  const bad: unknown[] = [
    { ...facts, dir: "/Users/alice/code" },
    { ...facts, token: "ghp_secret" },
    { ...facts, repos: ["/Users/alice/code/app"] },
    { ...facts, repos: ["C:\\code\\app"] },
    { ...facts, repos: ["file:///Users/alice/code/app"] },
    { ...facts, repos: ["https://alice:hunter2@github.com/acme/app"] },
    { ...facts, agents: [{ id: "claude-code", title: "Claude Code", ready: true, path: "/usr/local/bin/claude" }] },
    { ...facts, agents: [{ id: "claude-code", title: "/usr/local/bin/claude", ready: true }] },
    { ...facts, git: "/usr/bin/git" },
    { platform: "darwin" },
    []
  ];
  for (const value of bad) await expect(register("mac-0001", "Alice's Mac", value)).rejects.toThrow(/Invalid device fields/);
  await expect(register("../etc", "x")).rejects.toThrow(/Invalid device/);
  await expect(register("mac-0001", " ")).rejects.toThrow(/Invalid device/);
  await actor("", "anon");
  await expect(db.query("select * from public.tomrade_devices")).rejects.toThrow(/permission denied/);
  await expect(register("mac-0001", "x")).rejects.toThrow(/permission denied/);
  await actor("", "authenticated");
  await expect(register("mac-0001", "x")).rejects.toThrow(/Authentication required/);
});

it("keeps a removed machine out until someone signs in on it again", async () => {
  await actor(alice);
  await db.query("select public.tomrade_remove_device('win-0001')");
  expect((await mine()).find((d) => d.device_id === "win-0001")?.removed_at).not.toBeNull();
  // Still running with its old session: it is told, and stays out.
  expect(await register("win-0001", "DESKTOP-1")).toEqual({ state: "removed" });
  await db.query("select public.tomrade_device_seen('win-0001')");
  expect((await mine()).find((d) => d.device_id === "win-0001")?.removed_at).not.toBeNull();
  // Signed in again there: back, under the name it gives itself now.
  expect(await register("win-0001", "DESKTOP-2", facts, true)).toMatchObject({ state: "registered", device: { name: "DESKTOP-2" } });
});

it("counts the accounts with more than one machine, for the service role only", async () => {
  await actor(alice);
  await expect(db.query("select public.tomrade_multi_device_accounts()")).rejects.toThrow(/permission denied/);
  await db.exec("reset role");
  const count = async () => Number((await db.query<{ n: string }>("select public.tomrade_multi_device_accounts() as n")).rows[0].n);
  expect(await count()).toBe(1);
  await actor(alice);
  await db.query("select public.tomrade_remove_device('win-0001')");
  await db.exec("reset role");
  expect(await count()).toBe(0);
});

it("stamps when a machine was last here, and goes with the account", async () => {
  await db.exec("reset role");
  await db.query("update public.tomrade_devices set last_seen_at = now() - interval '1 day' where device_id = 'mac-0001'");
  await actor(alice);
  await db.query("select public.tomrade_device_seen('mac-0001')");
  const row = (await db.query<{ fresh: boolean }>("select last_seen_at > now() - interval '1 minute' as fresh from public.tomrade_devices where device_id = 'mac-0001'")).rows[0];
  expect(row.fresh).toBe(true);
  await db.exec("reset role");
  await db.query("delete from auth.users where id = $1", [alice]);
  expect((await db.query("select 1 from public.tomrade_devices where user_id = $1", [alice])).rows).toEqual([]);
  expect((await db.query("select 1 from public.tomrade_devices where user_id = $1", [bob])).rows).toHaveLength(1);
});
