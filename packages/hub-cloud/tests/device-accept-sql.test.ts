import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

// The real migrations in PostgreSQL (WASM); only Supabase's auth schema and roles are stubbed.
const db = new PGlite();
const alice = randomUUID();
const facts = { platform: "darwin", arch: "arm64", version: "0.29.0", git: true, agents: [], repos: [] };
const accept = { on: true, projects: "all", ceiling: "edits", concurrent: 1 };
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const register = async (value: unknown) =>
  (await db.query<{ r: { state: string; device?: { facts: unknown } } }>("select public.tomrade_register_device('mac-0001', 'Mac', $1::jsonb) as r", [JSON.stringify(value)])).rows[0].r;

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
  await db.query("insert into auth.users values ($1)", [alice]);
  for (const name of ["202611110001_devices.sql", "202611110002_device_limit.sql", "202611110003_device_activity.sql", "202611110004_device_accept.sql"]) await db.exec(migration(name));
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [alice]);
  await db.exec("set role authenticated");
}, 30_000);
afterAll(async () => { await db.close(); });

it("takes a machine's word on whether it accepts work, and one that says nothing of it", async () => {
  expect(await register(facts)).toMatchObject({ state: "registered", device: { facts } });
  expect(await register({ ...facts, accept })).toMatchObject({ state: "registered", device: { facts: { accept } } });
  expect(await register({ ...facts, accept: { on: false, projects: ["p-0001", "0e549d3b-a515-40b2-b931-f22bb6ee2c1e"], ceiling: "full", concurrent: 8 } })).toMatchObject({ state: "registered" });
});

it("refuses anything else under it", async () => {
  const bad: unknown[] = [
    { ...accept, dir: "/Users/alice/code" },
    { ...accept, projects: ["/Users/alice/code/app"] },
    { ...accept, projects: "some" },
    { ...accept, projects: Array.from({ length: 201 }, (_, i) => `p-${i}`) },
    { ...accept, ceiling: "bypassPermissions" },
    { ...accept, concurrent: 0 },
    { ...accept, concurrent: 9 },
    { ...accept, concurrent: 1.5 },
    { ...accept, on: "yes" },
    { on: true },
    "all"
  ];
  for (const value of bad) await expect(register({ ...facts, accept: value })).rejects.toThrow(/Invalid device fields/);
  // What it checked before still holds.
  await expect(register({ ...facts, accept, token: "ghp_secret" })).rejects.toThrow(/Invalid device fields/);
  await expect(register({ ...facts, accept, repos: ["/Users/alice/code/app"] })).rejects.toThrow(/Invalid device fields/);
});
