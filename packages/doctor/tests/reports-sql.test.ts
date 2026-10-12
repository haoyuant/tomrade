import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real migration in PostgreSQL (WASM); only Supabase's auth schema and roles are stubbed.
const db = new PGlite();
const alice = randomUUID();
const bob = randomUUID();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");

async function actor(id: string | null, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? ""]);
  await db.exec(`set role ${role}`);
}
const submit = (code: string, report: unknown = { sections: [] }) =>
  db.query<{ id: string }>("select public.tomrade_submit_diagnostic_report($1, $2, $3, $4, $5, $6, $7::jsonb) as id", [code, "issue:x", "WorkBuddy failed", "workbuddy", "0.6.0", "macOS 26.5 arm64", JSON.stringify(report)]);
const CODE = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.query("insert into auth.users values ($1), ($2)", [alice, bob]);
  await db.exec(migration("202610120003_diagnostic_reports.sql"));
}, 30_000);
afterAll(async () => {
  await db.close();
});

describe("diagnostic reports", () => {
  it("are sent only by a signed-in person, once per code", async () => {
    await actor(null, "anon");
    await expect(submit("R-AAAAAA")).rejects.toThrow();
    await actor(alice);
    const first = (await submit("R-ABCDEF")).rows[0]!.id;
    const again = (await submit("R-ABCDEF")).rows[0]!.id;
    expect(again).toBe(first);
    await expect(submit("not-a-code")).rejects.toThrow();
  });

  it("can't be written or changed by hand, only read and deleted by their sender", async () => {
    await actor(alice);
    await expect(db.query("insert into public.tomrade_diagnostic_reports(code, reporter, fingerprint, app_version, platform, report) values ('R-ZZZZZZ', $1, 'f', '1', 'p', '{}')", [alice])).rejects.toThrow();
    await expect(db.query("update public.tomrade_diagnostic_reports set status = 'fixed'")).rejects.toThrow();
    await actor(bob);
    expect((await db.query("select code from public.tomrade_diagnostic_reports")).rows).toEqual([]);
    await db.query("delete from public.tomrade_diagnostic_reports");
    await actor(alice);
    expect((await db.query<{ code: string; status: string }>("select code, status from public.tomrade_diagnostic_reports")).rows).toEqual([{ code: "R-ABCDEF", status: "new" }]);
    await db.query("delete from public.tomrade_diagnostic_reports where code = 'R-ABCDEF'");
    expect((await db.query("select code from public.tomrade_diagnostic_reports")).rows).toEqual([]);
  });

  it("stop at thirty a day per person", async () => {
    await actor(bob);
    for (let i = 0; i < 30; i++) await submit(`R-B${CODE[i]}${CODE[i]}${CODE[i]}${CODE[i]}${CODE[i]}`);
    await expect(submit("R-BXYXYX")).rejects.toThrow(/Too many/);
  });
});
