import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

// The real migration in PostgreSQL (WASM); only Supabase's roles are stubbed.
const db = new PGlite();
const migration = fs.readFileSync(new URL("../../../supabase/migrations/202610170001_announcements.sql", import.meta.url), "utf8");

beforeAll(async () => {
  await db.exec("create role anon; create role authenticated;");
  await db.exec(migration);
  // what `tomrade-store announce` writes with the service role
  await db.exec(`
    insert into public.tomrade_announcements(title, body) values ('now', 'hello');
    insert into public.tomrade_announcements(title, starts_at) values ('later', now() + interval '1 day');
    insert into public.tomrade_announcements(title, ends_at) values ('over', now() - interval '1 minute');
    insert into public.tomrade_announcements(title, withdrawn_at) values ('withdrawn', now());
  `);
}, 30_000);
afterAll(async () => {
  await db.close();
});

it("shows any app, signed in or not, only what is current, and lets none of them write", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`reset role; set role ${role}`);
    expect((await db.query("select title from public.tomrade_announcements")).rows).toEqual([{ title: "now" }]);
    await expect(db.query("insert into public.tomrade_announcements(title) values ('spoof')")).rejects.toThrow();
    await expect(db.query("update public.tomrade_announcements set title = 'spoof'")).rejects.toThrow();
    await expect(db.query("delete from public.tomrade_announcements")).rejects.toThrow();
  }
  await db.exec("reset role");
  await expect(db.query("insert into public.tomrade_announcements(title, level) values ('x', 'loud')")).rejects.toThrow();
});
