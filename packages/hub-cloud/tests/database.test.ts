import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

// Execute the actual migration in PostgreSQL (WASM). Only Supabase's auth schema
// and roles are stubbed; RLS, SQL transactions, receipts and PL/pgSQL are real.
const db = new PGlite();
const userA = randomUUID(), userB = randomUUID();
let hubA: string, hubB: string;
async function actor(id: string, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec(`set role ${role}`);
}
async function mutate(hub: string, mutation: Record<string, unknown>) {
  return (await db.query<{ result: { ok: boolean; record: { value: unknown; version: number } } }>(
    "select public.tomrade_mutate_hub($1, $2::jsonb) as result", [hub, JSON.stringify(mutation)]
  )).rows[0].result;
}
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
  await db.query("insert into auth.users values ($1), ($2)", [userA, userB]);
  await db.exec(fs.readFileSync(new URL("../../../supabase/migrations/202609100001_hub.sql", import.meta.url), "utf8"));
  await actor(userA);
  hubA = (await db.query<{ id: string }>("select public.tomrade_ensure_hub() as id")).rows[0].id;
  await actor(userB);
  hubB = (await db.query<{ id: string }>("select public.tomrade_ensure_hub() as id")).rows[0].id;
}, 30_000);
afterAll(async () => { await db.close(); });

describe("Supabase Hub migration", () => {
  it("creates one personal Hub per account and isolates reads with RLS", async () => {
    await actor(userA);
    expect((await db.query<{ id: string }>("select public.tomrade_ensure_hub() as id")).rows[0].id).toBe(hubA);
    expect((await db.query("select id from public.tomrade_hubs")).rows).toEqual([{ id: hubA }]);
    expect((await db.query("select user_id from public.tomrade_hub_members")).rows).toEqual([{ user_id: userA }]);
    await expect(db.query("select * from public.tomrade_hub_receipts")).rejects.toThrow(/permission denied/);
  });
  it("enforces versions, idempotent retries, deletion tombstones and ownership", async () => {
    await actor(userA);
    const op = { id: randomUUID(), kind: "project", key: "p1", value: { id: "p1", name: "One", keyPrefix: "TOM" }, base_version: 0 };
    const first = await mutate(hubA, op);
    expect(first).toMatchObject({ ok: true, record: { version: 1 } });
    expect(await mutate(hubA, op)).toEqual(first);
    await expect(mutate(hubA, { ...op, value: null })).rejects.toThrow(/reused/);
    const stale = await mutate(hubA, { ...op, id: randomUUID(), value: null });
    expect(stale).toMatchObject({ ok: false, record: { version: 1 } });
    expect(await mutate(hubA, { ...op, id: randomUUID(), value: null, base_version: 1 })).toMatchObject({ ok: true, record: { value: null, version: 2 } });
    await actor(userB);
    expect((await db.query("select * from public.tomrade_hub_records where hub_id = $1", [hubA])).rows).toEqual([]);
    await expect(mutate(hubA, { ...op, id: randomUUID() })).rejects.toThrow(/denied/);
    expect(await mutate(hubB, { ...op, id: randomUUID() })).toMatchObject({ ok: true });
  });
  it("denies direct writes, membership escalation, anonymous RPCs and local-path payloads", async () => {
    await actor(userA);
    await expect(db.query("update public.tomrade_hubs set name = 'hijacked'")).rejects.toThrow(/permission denied/);
    await expect(db.query("insert into public.tomrade_hub_members values ($1, $2, 'owner')", [hubB, userA])).rejects.toThrow(/permission denied/);
    await expect(mutate(hubA, { id: randomUUID(), kind: "project", key: "bad", base_version: 0, value: { id: "bad", name: "Bad", keyPrefix: "BAD", dir: "/private/path" } })).rejects.toThrow(/Invalid Hub record/);
    await expect(mutate(hubA, { id: randomUUID(), kind: "preference", key: "theme", base_version: 0, value: { value: "dark", updatedAt: 1 } })).rejects.toThrow(/Invalid Hub mutation/);
    expect(await mutate(hubA, { id: randomUUID(), kind: "preference", key: "settings", base_version: 0, value: { v: 1, sections: { theme: { value: "dark", updatedAt: 1 } } } })).toMatchObject({ ok: true });
    await actor("", "anon");
    await expect(db.query("select public.tomrade_ensure_hub()")).rejects.toThrow(/permission denied/);
    await expect(db.query("select * from public.tomrade_hub_records")).rejects.toThrow(/permission denied/);
    await actor("", "authenticated");
    await expect(db.query("select public.tomrade_ensure_hub()")).rejects.toThrow(/Authentication required/);
  });
});
