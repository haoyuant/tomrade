import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real migration in PostgreSQL (WASM); only Supabase's auth schema and roles are stubbed.
const db = new PGlite();
const alice = randomUUID();
const bob = randomUUID();
const nobody = randomUUID();
const commit = "a".repeat(40);

async function actor(id: string, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec(`set role ${role}`);
}
const manifest = (id: string, version = "1.0.0", extra: Record<string, unknown> = {}) => ({ id, version, title: "T", description: "D", license: "MIT", engines: { sdk: "^0.2.0" }, ...extra });
const submit = async (m: Record<string, unknown>, repo: string) => (await db.query<{ id: string }>("select public.tomrade_submit_plugin($1::jsonb, $2, $3) as id", [JSON.stringify(m), repo, commit])).rows[0]!.id;

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table auth.identities(id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), provider text, provider_id text, identity_data jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.query("insert into auth.users values ($1), ($2), ($3)", [alice, bob, nobody]);
  await db.query("insert into auth.identities(user_id, provider, provider_id, identity_data) values ($1, 'github', '101', $2), ($3, 'github', '202', $4)", [
    alice,
    JSON.stringify({ user_name: "Alice-Dev", full_name: "Alice" }),
    bob,
    JSON.stringify({ user_name: "bob" })
  ]);
  await db.exec(fs.readFileSync(new URL("../../../supabase/migrations/202609240001_plugins.sql", import.meta.url), "utf8"));
}, 30_000);
afterAll(async () => {
  await db.close();
});

describe("Community registry migration", () => {
  it("makes a publisher of an account only through its linked GitHub identity", async () => {
    await actor(alice);
    expect((await db.query<{ p: { github_login: string } }>("select public.tomrade_become_publisher() as p")).rows[0]!.p.github_login).toBe("alice-dev");
    await actor(nobody);
    await expect(db.query("select public.tomrade_become_publisher()")).rejects.toThrow(/Link a GitHub account/);
    await actor("", "anon");
    await expect(db.query("select public.tomrade_become_publisher()")).rejects.toThrow(/permission denied/);
  });

  it("takes a submission only for the caller's own id and repository, and keeps namespaces unique", async () => {
    await actor(alice);
    const id = await submit(manifest("alice-dev/stale"), "https://github.com/Alice-Dev/tomrade-stale");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(submit(manifest("alice-dev/stale", "1.0.1"), "https://github.com/Alice-Dev/tomrade-stale")).rejects.toThrow(/already has a submission in review/);
    await expect(submit(manifest("bob/other"), "https://github.com/bob/other")).rejects.toThrow(/must start with your GitHub login/);
    await expect(submit(manifest("alice-dev/elsewhere"), "https://github.com/someone-else/repo")).rejects.toThrow(/must belong to alice-dev/);

    await actor(bob);
    await db.query("select public.tomrade_become_publisher()");
    await expect(submit(manifest("bob/stale"), "https://github.com/bob/stale")).rejects.toThrow(/namespace stale is taken/);
    await expect(submit(manifest("bob/stale", "1.0.0", { namespace: "bob_stale" }), "https://github.com/bob/stale")).resolves.toBeTruthy();
  });

  it("shows a version to everyone only once it is listed, and its submitter meanwhile", async () => {
    await actor("", "anon");
    expect((await db.query("select * from public.tomrade_plugin_versions where plugin_id = 'alice-dev/stale'")).rows).toEqual([]);
    await actor(alice);
    expect((await db.query<{ status: string }>("select status from public.tomrade_plugin_versions where plugin_id = 'alice-dev/stale'")).rows).toEqual([{ status: "queued" }]);
    await actor(bob);
    expect((await db.query("select * from public.tomrade_plugin_submissions where plugin_id = 'alice-dev/stale'")).rows).toEqual([]);

    // The worker lists it: it runs with the service role, outside RLS.
    await db.exec("reset role");
    await db.query("update public.tomrade_plugin_versions set status = 'listed', tier = 'ai-reviewed', risk = 'low' where plugin_id = 'alice-dev/stale'");
    await actor("", "anon");
    expect((await db.query<{ tier: string }>("select tier from public.tomrade_plugin_versions where plugin_id = 'alice-dev/stale'")).rows).toEqual([{ tier: "ai-reviewed" }]);
    await db.query("select public.tomrade_count_download('alice-dev/stale')");
    expect(Number((await db.query<{ downloads: number }>("select downloads from public.tomrade_plugins where id = 'alice-dev/stale'")).rows[0]!.downloads)).toBe(1);
  });

  it("denies direct writes, and lets an account report and a publisher ask for review", async () => {
    await actor(bob);
    await expect(db.query("update public.tomrade_plugin_versions set tier = 'reviewed'")).rejects.toThrow(/permission denied/);
    await expect(db.query("insert into public.tomrade_plugin_revocations(plugin_id, reason) values ('alice-dev/stale', 'x')")).rejects.toThrow(/permission denied/);
    await db.query("select public.tomrade_report_plugin('alice-dev/stale', '1.0.0', 'broken', 'crashes on load')");
    expect((await db.query("select reason from public.tomrade_plugin_reports")).rows).toEqual([{ reason: "broken" }]);
    await expect(db.query("select public.tomrade_request_official_review('alice-dev/stale', '1.0.0')")).rejects.toThrow(/Only the plugin's publisher/);
    await actor(alice);
    await db.query("select public.tomrade_request_official_review('alice-dev/stale', '1.0.0')");
    expect((await db.query("select status from public.tomrade_plugin_review_requests")).rows).toEqual([{ status: "open" }]);
  });
});
