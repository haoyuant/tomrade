import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, expect, it } from "vitest";

const migration = fs.readFileSync(new URL("../../../supabase/migrations/202611060001_rls_auto_enable_execute.sql", import.meta.url), "utf8");
const dbs: PGlite[] = [];
async function database() {
  const db = new PGlite();
  dbs.push(db);
  // A role that makes tables without being a superuser, as Supabase's postgres role is not one.
  await db.exec("create role anon; create role authenticated; create role migrator; grant create, usage on schema public to migrator");
  return db;
}
afterAll(async () => { for (const db of dbs) await db.close(); });

// A stand-in for what the dashboard installs in prod: same name and shape, not its exact body.
const dashboardTrigger = `
  create function public.rls_auto_enable() returns event_trigger
  language plpgsql security definer set search_path = pg_catalog as $$
  declare cmd record;
  begin
    for cmd in select * from pg_event_trigger_ddl_commands()
      where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') and schema_name = 'public'
    loop
      execute format('alter table %s enable row level security', cmd.object_identity);
    end loop;
  end;
  $$;
  create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable();
`;
const canExecute = async (db: PGlite, role: string) =>
  (await db.query<{ ok: boolean }>("select has_function_privilege($1, 'public.rls_auto_enable()', 'execute') as ok", [role])).rows[0]!.ok;

it("takes EXECUTE on rls_auto_enable from the API roles, and new tables still get RLS", async () => {
  const db = await database();
  await db.exec(dashboardTrigger);
  expect(await canExecute(db, "anon")).toBe(true);

  await db.exec(migration);
  for (const role of ["anon", "authenticated", "migrator"]) expect(await canExecute(db, role)).toBe(false);

  await db.exec("set role migrator; create table public.made_after (id int); reset role");
  const rls = await db.query<{ on: boolean }>("select relrowsecurity as on from pg_class where oid = 'public.made_after'::regclass");
  expect(rls.rows[0]!.on).toBe(true);
}, 30_000);

it("does nothing where the dashboard never made the function", async () => {
  const db = await database();
  await db.exec(migration);
  expect((await db.query("select to_regprocedure('public.rls_auto_enable()') as fn")).rows).toEqual([{ fn: null }]);
}, 30_000);
