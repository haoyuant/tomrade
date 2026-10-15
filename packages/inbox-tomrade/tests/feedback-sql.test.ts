import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Both real migrations in PostgreSQL (WASM); only Supabase's auth schema and roles are stubbed.
const db = new PGlite();
const sender = randomUUID();
const maintainer = randomUUID();
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");

async function actor(id: string | null, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? ""]);
  await db.exec(`set role ${role}`);
}
const ARGS = ["issue:x", "Something", null, "0.10.0", "macOS 26.5 arm64", JSON.stringify({ sections: [{ id: "note", title: "Note", text: "hi" }] })];

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.query("insert into auth.users values ($1), ($2)", [sender, maintainer]);
  await db.exec(migration("202610120003_diagnostic_reports.sql"));
  await db.exec(migration("202610150001_feedback_inbox.sql"));
  // what `tomrade-store maintainer add` does with the service role
  await db.query("insert into public.tomrade_maintainers(user_id) values ($1)", [maintainer]);
}, 30_000);
afterAll(async () => {
  await db.close();
});

describe("feedback inbox", () => {
  it("keeps the kind a report was sent as; an app from before kinds still sends bugs", async () => {
    await actor(sender);
    await db.query("select public.tomrade_submit_diagnostic_report($1, $2, $3, $4, $5, $6, $7::jsonb)", ["R-AAAAAA", ...ARGS]);
    await db.query("select public.tomrade_submit_diagnostic_report($1, $2, $3, $4, $5, $6, $7::jsonb, $8)", ["R-BBBBBB", ...ARGS, "idea"]);
    await expect(db.query("select public.tomrade_submit_diagnostic_report($1, $2, $3, $4, $5, $6, $7::jsonb, $8)", ["R-CCCCCC", ...ARGS, "rant"])).rejects.toThrow();
    expect((await db.query("select code, kind from public.tomrade_diagnostic_reports order by code")).rows).toEqual([{ code: "R-AAAAAA", kind: "bug" }, { code: "R-BBBBBB", kind: "idea" }]);
  });

  it("lets only a maintainer read every report, without who sent it", async () => {
    await actor(sender);
    expect((await db.query<{ is: boolean }>("select public.tomrade_is_maintainer() as is")).rows[0]!.is).toBe(false);
    await expect(db.query("select * from public.tomrade_feedback_pull()")).rejects.toThrow(/maintainer/);
    await expect(db.query("select * from public.tomrade_maintainers")).rejects.toThrow();
    await expect(db.query("insert into public.tomrade_maintainers(user_id) values ($1)", [sender])).rejects.toThrow();

    await actor(maintainer);
    expect((await db.query<{ is: boolean }>("select public.tomrade_is_maintainer() as is")).rows[0]!.is).toBe(true);
    const rows = (await db.query<Record<string, unknown>>("select * from public.tomrade_feedback_pull()")).rows;
    expect(rows.map((r) => [r.code, r.kind])).toEqual([["R-AAAAAA", "bug"], ["R-BBBBBB", "idea"]]);
    expect(Object.keys(rows[0]!)).not.toContain("reporter");
    const later = (await db.query("select * from public.tomrade_feedback_pull(now() + interval '1 minute')")).rows;
    expect(later).toEqual([]);
  });

  it("lets a maintainer triage and answer, which the sender then reads", async () => {
    await actor(sender);
    await expect(db.query("select public.tomrade_feedback_answer('R-BBBBBB', 'wontfix')")).rejects.toThrow(/maintainer/);

    await actor(maintainer);
    await db.query("select public.tomrade_feedback_answer('R-BBBBBB', p_status => 'triaged', p_ticket => 'TOM-200')");
    await db.query("select public.tomrade_feedback_answer('R-BBBBBB', p_reply => 'Good idea, on the list')");
    await expect(db.query("select public.tomrade_feedback_answer('R-BBBBBB', p_status => 'maybe')")).rejects.toThrow();
    await expect(db.query("select public.tomrade_feedback_answer('R-ZZZZZZ', 'wontfix')")).rejects.toThrow(/No report/);

    await actor(sender);
    const mine = (await db.query<Record<string, unknown>>("select status, ticket, reply, replied_at from public.tomrade_diagnostic_reports where code = 'R-BBBBBB'")).rows[0]!;
    expect(mine).toMatchObject({ status: "triaged", ticket: "TOM-200", reply: "Good idea, on the list" });
    expect(mine.replied_at).not.toBeNull();
  });
});
