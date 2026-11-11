import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

// The real migrations in PostgreSQL (WASM); only Supabase's auth schema and roles are stubbed.
const db = new PGlite();
const alice = randomUUID(), bob = randomUUID();
const facts = { platform: "darwin", arch: "arm64", version: "0.29.0", git: true, agents: [], repos: [] };
const session = { projectId: "p-0001", key: "TOM-12", title: "Make it faster", agent: "claude-code", state: "working", startedAt: 1_700_000_000_000, branch: "tom-12/faster" };
const shift = { projectId: "p-0001", done: 1, total: 4, startedAt: 1_700_000_000_000 };
const migration = (name: string) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
async function actor(id: string, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec(`set role ${role}`);
}
const report = async (device: string, activity: unknown) =>
  (await db.query<{ ok: boolean }>("select public.tomrade_report_device_activity($1, $2::jsonb) as ok", [device, JSON.stringify(activity)])).rows[0].ok;
const row = async (device: string) => (await db.query<{ activity: unknown; said: boolean }>("select activity, activity_at is not null as said from public.tomrade_devices where device_id = $1", [device])).rows[0];

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
  for (const name of ["202611110001_devices.sql", "202611110002_device_limit.sql", "202611110003_device_activity.sql"]) await db.exec(migration(name));
  await actor(alice);
  await db.query("select public.tomrade_register_device('mac-0001', 'Mac', $1::jsonb)", [JSON.stringify(facts)]);
}, 30_000);
afterAll(async () => { await db.close(); });

it("keeps what a machine works on, on its own row, for its own account", async () => {
  await actor(alice);
  expect(await row("mac-0001")).toEqual({ activity: {}, said: false });
  expect(await report("mac-0001", { sessions: [session, { ...session, key: "多喝-3", state: "blocked", branch: null }], nightShifts: [shift] })).toBe(true);
  expect(await row("mac-0001")).toEqual({ activity: { sessions: [session, { ...session, key: "多喝-3", state: "blocked", branch: null }], nightShifts: [shift] }, said: true });
  // A machine the account does not have: nothing is kept, and nothing fails.
  expect(await report("gone-0001", { sessions: [], nightShifts: [] })).toBe(false);
  await actor(bob);
  expect(await report("mac-0001", { sessions: [], nightShifts: [] })).toBe(false);
  expect((await db.query("select 1 from public.tomrade_devices")).rows).toEqual([]);
  await actor(alice);
  expect((await row("mac-0001")).activity).toMatchObject({ sessions: [{ key: "TOM-12" }, { key: "多喝-3" }] });
});

it("refuses anything but the fields it names: no conversation, no prompt, no path", async () => {
  await actor(alice);
  const bad: unknown[] = [
    { sessions: [{ ...session, cwd: "/Users/alice/code/app" }], nightShifts: [] },
    { sessions: [{ ...session, transcript: "/Users/alice/.claude/t.jsonl" }], nightShifts: [] },
    { sessions: [{ ...session, prompt: "the secret plan" }], nightShifts: [] },
    { sessions: [{ ...session, activity: "Bash: cat ~/.ssh/id_rsa" }], nightShifts: [] },
    { sessions: [{ ...session, branch: "/Users/alice/code/app" }], nightShifts: [] },
    { sessions: [{ ...session, branch: "C:\\code\\app" }], nightShifts: [] },
    { sessions: [{ ...session, agent: "/usr/local/bin/claude" }], nightShifts: [] },
    { sessions: [{ ...session, key: "../../etc/passwd" }], nightShifts: [] },
    { sessions: [{ ...session, state: "running" }], nightShifts: [] },
    { sessions: [{ ...session, title: "x".repeat(201) }], nightShifts: [] },
    { sessions: [{ projectId: "p-0001", key: "TOM-12" }], nightShifts: [] },
    { sessions: [], nightShifts: [{ ...shift, briefPath: "/Users/alice/Tomrade/brief.md" }] },
    { sessions: [], nightShifts: [], terminal: "ls -la" },
    { sessions: Array.from({ length: 51 }, () => session), nightShifts: [] },
    { sessions: [] },
    []
  ];
  for (const activity of bad) await expect(report("mac-0001", activity)).rejects.toThrow(/Invalid device activity/);
  await expect(db.query("update public.tomrade_devices set activity = '{}'")).rejects.toThrow(/permission denied/);
  await actor("", "anon");
  await expect(report("mac-0001", { sessions: [], nightShifts: [] })).rejects.toThrow(/permission denied/);
  await actor("", "authenticated");
  await expect(report("mac-0001", { sessions: [], nightShifts: [] })).rejects.toThrow(/Authentication required/);
});

it("drops what a machine was doing when it is removed, and keeps it out afterwards", async () => {
  await actor(alice);
  await db.query("select public.tomrade_remove_device('mac-0001')");
  expect(await row("mac-0001")).toEqual({ activity: {}, said: false });
  expect(await report("mac-0001", { sessions: [session], nightShifts: [] })).toBe(false);
  expect(await row("mac-0001")).toEqual({ activity: {}, said: false });
});
