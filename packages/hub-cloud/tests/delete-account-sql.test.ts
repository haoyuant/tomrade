import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

// The real migrations in PostgreSQL (WASM). Supabase's auth and storage schemas are stubbed,
// storage with the owner foreign key that makes Supabase refuse to delete a user who owns files.
const db = new PGlite();
const alice = randomUUID(), bob = randomUUID();
const digest = "b".repeat(64);
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
async function actor(id: string, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec(`set role ${role}`);
}
const count = async (sql: string, params: unknown[] = []) => {
  await db.exec("reset role");
  return Number((await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0].n);
};

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table auth.identities(id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, provider text, provider_id text, identity_data jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.query("insert into auth.users values ($1), ($2)", [alice, bob]);
  await db.query("insert into auth.identities(user_id, provider, provider_id, identity_data) values ($1, 'github', '101', $2)", [alice, JSON.stringify({ user_name: "alice" })]);
  for (const name of ["202609100001_hub.sql", "202609240001_plugins.sql", "202609240002_plugin_review_worker.sql", "202610100001_open_community.sql"]) await db.exec(migration(name));
  await db.exec(`
    create schema storage;
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid references auth.users(id), owner_id text);
  `);
  await db.exec(migration("202610120001_delete_account.sql"));

  for (const user of [alice, bob]) {
    await actor(user);
    const hub = (await db.query<{ id: string }>("select public.tomrade_ensure_hub() as id")).rows[0].id;
    await db.query("select public.tomrade_mutate_hub($1, $2::jsonb)", [hub, JSON.stringify({ id: randomUUID(), kind: "project", key: "p1", value: { id: "p1", name: "One", keyPrefix: "ONE" }, base_version: 0 })]);
  }
  await actor(alice);
  await db.query("select public.tomrade_become_publisher()");
  const path = `alice/stale/1.0.0/${digest}.tomrade-plugin`;
  await db.exec("reset role");
  await db.query("insert into storage.objects(bucket_id, name, owner, owner_id) values ('plugin-packages', $1, $2, $3)", [path, alice, alice]);
  await actor(alice);
  await db.query("select public.tomrade_publish_plugin($1::jsonb, $2, $3, $4, $5, $6, $7, $8, $9)", [
    JSON.stringify({ id: "alice/stale", version: "1.0.0", title: "Stale", description: "D", license: "MIT", engines: { sdk: "^0.2.0" } }),
    "https://github.com/alice/stale", "a".repeat(40), "v1.0.0", digest, path, 1234, "low", []
  ]);
  await db.query("select public.tomrade_report_plugin('alice/stale', '1.0.0', 'malware', 'checking')");
}, 30_000);
afterAll(async () => { await db.close(); });

it("is for a signed-in account only", async () => {
  await actor("", "anon");
  await expect(db.query("select public.tomrade_delete_account()")).rejects.toThrow(/permission denied/);
  await actor("", "authenticated");
  await expect(db.query("select public.tomrade_delete_account()")).rejects.toThrow(/Authentication required/);
  expect(await count("auth.users")).toBe(2);
});

it("deletes the account and everything keyed to it, keeps its published plugins, and leaves others alone", async () => {
  await actor(alice);
  await db.query("select public.tomrade_delete_account()");
  expect(await count("auth.users where id = $1", [alice])).toBe(0);
  expect(await count("public.tomrade_hubs where owner_id = $1", [alice])).toBe(0);
  expect(await count("public.tomrade_hub_receipts where user_id = $1", [alice])).toBe(0);
  expect(await count("public.tomrade_hub_records")).toBe(1);
  expect(await count("public.tomrade_publishers")).toBe(0);
  expect(await count("public.tomrade_plugin_reports")).toBe(0);
  await db.exec("reset role");
  expect((await db.query("select publisher, owner_id from public.tomrade_plugins")).rows).toEqual([{ publisher: "alice", owner_id: null }]);
  expect((await db.query("select status, submitted_by from public.tomrade_plugin_versions")).rows).toEqual([{ status: "listed", submitted_by: null }]);
  expect((await db.query("select owner, owner_id from storage.objects")).rows).toEqual([{ owner: null, owner_id: null }]);
  expect(await count("auth.users where id = $1", [bob])).toBe(1);
});
