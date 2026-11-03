import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

// The real migration in PostgreSQL (WASM); only Supabase's auth schema and roles are stubbed.
const db = new PGlite();
const early = randomUUID(), older = randomUUID();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
async function actor(id: string, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec(`set role ${role}`);
}
async function signUp(meta: Record<string, unknown> | null): Promise<string> {
  const id = randomUUID();
  await db.exec("reset role");
  await db.query("insert into auth.users(id, raw_user_meta_data) values ($1, $2)", [id, meta && JSON.stringify(meta)]);
  return id;
}
const stored = async (id: string) => {
  await db.exec("reset role");
  return (await db.query<{ marketing: boolean; updated_at: Date }>("select marketing, updated_at from public.tomrade_email_preferences where user_id = $1", [id])).rows[0];
};

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.query("insert into auth.users values ($1, $2), ($3, null)", [early, JSON.stringify({ marketing_emails: true }), older]);
  await db.exec(migration("202611030001_email_preferences.sql"));
}, 30_000);
afterAll(async () => { await db.close(); });

it("records the choice made on the sign-up form, and no mail for an account that made none", async () => {
  const yes = await signUp({ terms_version: "2026-10-12", marketing_emails: true });
  const no = await signUp({ terms_version: "2026-10-12", marketing_emails: false });
  const silent = await signUp(null);
  const odd = await signUp({ marketing_emails: "yes" });
  expect((await stored(yes)).marketing).toBe(true);
  expect((await stored(no)).marketing).toBe(false);
  expect((await stored(silent)).marketing).toBe(false);
  expect((await stored(odd)).marketing).toBe(false);
});

it("gives accounts made before it the choice their sign-up carried, else no mail", async () => {
  expect((await stored(early)).marketing).toBe(true);
  expect((await stored(older)).marketing).toBe(false);
});

it("lets a person read and change only their own choice", async () => {
  const alice = await signUp({ marketing_emails: true });
  const bob = await signUp({ marketing_emails: true });
  const before = (await stored(alice)).updated_at;
  await actor(alice);
  expect((await db.query("select user_id, marketing from public.tomrade_email_preferences")).rows).toEqual([{ user_id: alice, marketing: true }]);
  await db.query("update public.tomrade_email_preferences set marketing = false");
  expect((await stored(alice)).marketing).toBe(false);
  expect((await stored(alice)).updated_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect((await stored(bob)).marketing).toBe(true);

  await actor(alice);
  await expect(db.query("update public.tomrade_email_preferences set user_id = $1", [bob])).rejects.toThrow(/permission denied/);
  await expect(db.query("insert into public.tomrade_email_preferences(user_id, marketing) values ($1, true)", [randomUUID()])).rejects.toThrow(/permission denied/);
  await expect(db.query("delete from public.tomrade_email_preferences")).rejects.toThrow(/permission denied/);
  await actor("", "anon");
  await expect(db.query("select * from public.tomrade_email_preferences")).rejects.toThrow(/permission denied/);
});

it("goes with the account", async () => {
  const gone = await signUp({ marketing_emails: true });
  await db.exec("reset role");
  await db.query("delete from auth.users where id = $1", [gone]);
  expect(await stored(gone)).toBeUndefined();
});
