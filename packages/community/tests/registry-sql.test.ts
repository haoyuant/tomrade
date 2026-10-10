import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real migrations in PostgreSQL (WASM); only Supabase's auth schema and roles are stubbed.
const db = new PGlite();
const alice = randomUUID();
const bob = randomUUID();
const nobody = randomUUID();
const commit = "a".repeat(40);
const digest = "b".repeat(64);
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");

async function actor(id: string, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec(`set role ${role}`);
}
const manifest = (id: string, version = "1.0.0", extra: Record<string, unknown> = {}) => ({ id, version, title: "T", description: "D", license: "MIT", engines: { sdk: "^0.2.0" }, ...extra });
const publish = (m: Record<string, unknown>, repo: string, opts: { path?: string; risk?: string } = {}) =>
  db.query("select public.tomrade_publish_plugin($1::jsonb, $2, $3, $4, $5, $6, $7, $8, $9)", [
    JSON.stringify(m),
    repo,
    commit,
    `v${String(m.version)}`,
    digest,
    opts.path ?? `${String(m.id)}/${String(m.version)}/${digest}.tomrade-plugin`,
    1234,
    opts.risk ?? "low",
    []
  ]);

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
  await db.exec(migration("202609240001_plugins.sql"));
  await db.exec(migration("202609240002_plugin_review_worker.sql"));
}, 30_000);
afterAll(async () => {
  await db.close();
});

describe("Community registry migrations", () => {
  it("makes a publisher of an account only through its linked GitHub identity", async () => {
    await actor(alice);
    expect((await db.query<{ p: { github_login: string } }>("select public.tomrade_become_publisher() as p")).rows[0]!.p.github_login).toBe("alice-dev");
    await actor(nobody);
    await expect(db.query("select public.tomrade_become_publisher()")).rejects.toThrow(/Link a GitHub account/);
    await actor("", "anon");
    await expect(db.query("select public.tomrade_become_publisher()")).rejects.toThrow(/permission denied/);
  });

  it("drops what waited for a review that will never come, and the review queue with it", async () => {
    await actor(alice);
    await db.query("select public.tomrade_submit_plugin($1::jsonb, $2, $3)", [JSON.stringify(manifest("alice-dev/queued")), "https://github.com/Alice-Dev/queued", commit]);
    await db.exec("reset role");
    await db.exec(migration("202610100001_open_community.sql"));
    expect((await db.query("select * from public.tomrade_plugins where id = 'alice-dev/queued'")).rows).toEqual([]);
    expect((await db.query("select * from public.tomrade_plugin_versions")).rows).toEqual([]);
    expect((await db.query("select to_regclass('public.tomrade_plugin_submissions') as t")).rows).toEqual([{ t: null }]);
    await actor(alice);
    await expect(db.query("select public.tomrade_submit_plugin($1::jsonb, $2, $3)", [JSON.stringify(manifest("alice-dev/queued")), "https://github.com/Alice-Dev/queued", commit])).rejects.toThrow(/does not exist/);
  });

  it("publishes only the caller's own id, repository and open-source license, and keeps namespaces unique", async () => {
    await actor(alice);
    await publish(manifest("alice-dev/stale"), "https://github.com/Alice-Dev/tomrade-stale");
    await expect(publish(manifest("alice-dev/stale"), "https://github.com/Alice-Dev/tomrade-stale")).rejects.toThrow(/already published; bump the version/);
    await expect(publish(manifest("bob/other"), "https://github.com/bob/other")).rejects.toThrow(/must start with your GitHub login/);
    await expect(publish(manifest("alice-dev/elsewhere"), "https://github.com/someone-else/repo")).rejects.toThrow(/must belong to alice-dev/);
    await expect(publish(manifest("alice-dev/closed", "1.0.0", { license: "UNLICENSED" }), "https://github.com/Alice-Dev/closed")).rejects.toThrow(/open-source plugins only/);
    await expect(publish(manifest("alice-dev/closed", "1.0.0", { license: "BUSL-1.1" }), "https://github.com/Alice-Dev/closed")).rejects.toThrow(/open-source plugins only/);
    await expect(publish(manifest("alice-dev/dual", "1.0.0", { license: "(MIT OR BUSL-1.1)" }), "https://github.com/Alice-Dev/dual")).resolves.toBeTruthy();
    await expect(publish(manifest("alice-dev/moved", "1.0.0"), "https://github.com/Alice-Dev/moved", { path: `bob/moved/1.0.0/${digest}.tomrade-plugin` })).rejects.toThrow(/Upload the package to alice-dev\/moved/);
    await expect(publish(manifest("alice-dev/risky", "1.0.0"), "https://github.com/Alice-Dev/risky", { risk: "none" })).rejects.toThrow(/low, elevated or high/);

    await actor(bob);
    await db.query("select public.tomrade_become_publisher()");
    await expect(publish(manifest("bob/stale"), "https://github.com/bob/stale")).rejects.toThrow(/namespace stale is taken/);
    await expect(publish(manifest("bob/stale", "1.0.0", { namespace: "bob_stale" }), "https://github.com/bob/stale")).resolves.toBeTruthy();
  });

  it("lists a version for everyone the moment it is published, as a community plugin", async () => {
    await actor("", "anon");
    const rows = await db.query<{ status: string; tier: string; digest: string; listed: boolean }>(
      "select status, tier, digest, listed_at is not null as listed from public.tomrade_plugin_versions where plugin_id = 'alice-dev/stale'"
    );
    expect(rows.rows).toEqual([{ status: "listed", tier: "community", digest, listed: true }]);
    expect((await db.query<{ latest_version: string }>("select latest_version from public.tomrade_plugins where id = 'alice-dev/stale'")).rows).toEqual([{ latest_version: "1.0.0" }]);
    await db.query("select public.tomrade_count_download('alice-dev/stale')");
    expect(Number((await db.query<{ downloads: number }>("select downloads from public.tomrade_plugins where id = 'alice-dev/stale'")).rows[0]!.downloads)).toBe(1);
    await expect(publish(manifest("alice-dev/anon"), "https://github.com/alice-dev/anon")).rejects.toThrow(/permission denied/);
  });

  it("denies direct writes, and lets an account report a plugin", async () => {
    await actor(bob);
    await expect(db.query("update public.tomrade_plugin_versions set tier = 'official'")).rejects.toThrow(/permission denied/);
    await expect(db.query("insert into public.tomrade_plugin_revocations(plugin_id, reason) values ('alice-dev/stale', 'x')")).rejects.toThrow(/permission denied/);
    await db.query("select public.tomrade_report_plugin('alice-dev/stale', '1.0.0', 'broken', 'crashes on load')");
    expect((await db.query("select reason from public.tomrade_plugin_reports")).rows).toEqual([{ reason: "broken" }]);
  });
});
