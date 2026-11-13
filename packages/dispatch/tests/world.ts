/**
 * What the dispatch tests share: the account's database as Supabase runs it — the real migrations in PostgreSQL
 * (WASM), with only Supabase's auth schema stubbed — and machines that hold the same project the way real ones
 * do, by its folder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Context } from "cordis";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { fresh, settle } from "@tomradex/testkit";
import { Dispatch } from "@tomradex/dispatch";

const MIGRATIONS = ["202611110001_devices.sql", "202611110002_device_limit.sql", "202611110003_device_activity.sql", "202611110004_device_accept.sql", "202611110005_dispatches.sql", "202611140001_dispatch_roles.sql", "202611140002_device_shares.sql", "202611140003_dispatch_role_claims.sql"];
export const QUIET = { watch: false, reconcileMs: 0, snapshotIdleMs: 60_000, snapshotMaxMs: 60_000 };

export interface Account {
  db: PGlite;
  user: string;
  /** A client as supabase-js gives one, for this account: each call goes to the database as the signed-in user. */
  client(): { rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null }>; from(table: string): any };
  /** Registers a machine with the account, as its first sync does. */
  register(device: string, platform?: string): Promise<void>;
  /** As the database's owner: for what no machine can do, such as moving a clock. */
  admin<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Another person's account on the same account server, by the address they sign in with. */
  guest(email: string): Promise<Account>;
  close(): Promise<void>;
}

export const OWNER_EMAIL = "owner@example.test";

export async function account(): Promise<Account> {
  const db = new PGlite();
  const first = randomUUID();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.query("insert into auth.users values ($1, $2)", [first, OWNER_EMAIL]);
  for (const name of MIGRATIONS) await db.exec(fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  // The tests play more machines than the free plan allows.
  await db.query("insert into public.tomrade_entitlements(user_id, plan, device_limit) values ($1, 'placeholder_plus', null)", [first]);
  // One call at a time: each sets who is asking before it asks.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = turn.then(work, work);
    turn = next.catch(() => undefined);
    return next;
  };
  const as = (user: string): Account => {
  const asUser = async () => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
    await db.exec("set role authenticated");
  };
  const failed = (error: unknown) => ({ data: null, error: { message: (error as Error).message, code: (error as { code?: string }).code ?? "P0001" } });
  const plain = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
  const client = () => ({
    rpc: (name: string, args: Record<string, unknown> = {}) => inTurn(async () => {
      await asUser();
      try {
        const keys = Object.keys(args);
        const values = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
        const r = await db.query<{ r: unknown }>(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, values);
        return { data: r.rows[0]!.r, error: null };
      } catch (error) {
        return failed(error);
      }
    }),
    from: (table: string) => {
      const query = {
        select: () => query, order: () => query,
        limit: (n: number) => inTurn(async () => {
          await asUser();
          try {
            const r = await db.query<Record<string, unknown>>(`select * from public.${table} order by created_at desc limit ${Number(n)}`);
            return { data: r.rows.map(plain), error: null };
          } catch (error) {
            return failed(error);
          }
        })
      };
      return query;
    }
  });
  return {
    db, user, client,
    register: async (device, platform = process.platform) => {
      const { error } = await client().rpc("tomrade_register_device", { p_device: device, p_name: device, p_facts: { platform, arch: "x64", version: "1.0.0", git: true, agents: [], repos: [] } });
      if (error) throw new Error(error.message);
    },
    admin: (sql, params = []) => inTurn(async () => {
      await db.exec("reset role");
      return (await db.query(sql, params)).rows as never[];
    }),
    guest: (email) => inTurn(async () => {
      await db.exec("reset role");
      const id = randomUUID();
      await db.query("insert into auth.users values ($1, $2)", [id, email]);
      return as(id);
    }),
    close: () => db.close()
  };
  };
  return as(first);
}

/** Stands for code link on a machine: these tests play the agents. */
export class FakeCode {
  starts: { projectId: string; itemId: string; opts: Record<string, unknown> }[] = [];
  stopped: string[] = [];
  sessions = new Map<string, { id: string; itemId: string; state: string; summary: string | null }>();
  /** Set: the next Start is turned away at this gate. */
  gate: { gate: string; message: string; remote?: string; repo?: { id: string; name: string } } | null = null;
  /** With a checkout gate: it clears once the repository has been cloned. */
  clearsOnClone = false;
  private n = 0;
  start = async (projectId: string, itemId: string, opts: Record<string, unknown>) => {
    this.starts.push({ projectId, itemId, opts });
    if (this.gate) return { ok: false as const, ...this.gate };
    const id = `session-${++this.n}`;
    this.sessions.set(id, { id, itemId, state: "running", summary: null });
    return { ok: true as const, sessionId: id };
  };
  stopSession = async (_projectId: string, id: string) => {
    this.stopped.push(id);
    const session = this.sessions.get(id);
    if (session) session.state = "ended";
    return true;
  };
  sessionsOf = (_projectId: string, itemId?: string, filter: { ids?: string[]; live?: boolean } = {}) =>
    [...this.sessions.values()].filter((s) => (!filter.ids || filter.ids.includes(s.id)) && (!itemId || s.itemId === itemId) && (!filter.live || s.state !== "ended"));
}

export interface FakeEngine { id: string; title: string; ok: boolean; modes?: string[] }
export const CLAUDE: FakeEngine = { id: "claude-code", title: "Claude Code", ok: true, modes: ["auto", "bypassPermissions", "acceptEdits", "default", "plan", "local"] };

const dirs: string[] = [];
const contexts: Context[] = [];
export async function cleanup(): Promise<void> {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export interface MachineOptions {
  platform?: string;
  /** Other plugins, loaded before dispatch: the full test brings the real code link. */
  plugins?: unknown[];
  /** False: no stand-in for code link and the agents; the plugins bring the real ones. */
  fakes?: boolean;
  /** Signals reach the other machines, as over the presence channel; off, each test says when a machine looks. */
  bus?: Set<{ device: string; ctx: Context }>;
  dir?: string;
  /** Run before the machine starts looking at the queue: what it has on disk when Tomrade starts. */
  prepare?: (m: Machine) => Promise<void>;
}

/** A machine of the account: its own Hub folder and settings, the account's queue, and stand-ins for code link and the agents. */
export async function machine(acct: Account, device: string, opts: MachineOptions = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `tomrade-dispatch-${device}-`));
  if (!opts.dir) dirs.push(dir);
  const hubDir = path.join(dir, "hub");
  const bag = await fresh({ hubDir, device, plugins: [[Settings, { path: path.join(dir, "settings.json") }], [Storage, QUIET], ...((opts.plugins ?? []) as never[])] });
  contexts.push(bag.ctx);
  await bag.ctx.storage.ready;
  await acct.register(device, opts.platform);
  const me = { device, ctx: bag.ctx as Context };
  opts.bus?.add(me);
  bag.ctx.provide("cloudHub", {
    client: acct.client(), info: () => ({ user: { id: acct.user, email: "user@example.test" } }),
    devicesInfo: () => ({ state: "ready", devices: [] }),
    describeDevice() {}, refreshDevice() {},
    signal: (name: string) => { for (const other of opts.bus ?? []) if (other !== me) other.ctx.emit("cloudHub/signal", name, device); }
  } as never);
  const code = new FakeCode();
  const engines: FakeEngine[] = [CLAUDE];
  const cloned: { remote: string; branch: string; parent: string }[] = [];
  if (opts.fakes !== false) {
    bag.ctx.provide("codeLink", code as never);
    bag.ctx.provide("agent", { codeEngines: () => engines.map((e) => ({ id: e.id, title: e.title, ...(e.modes ? { permissionModes: { default: e.modes[0], choices: e.modes.map((value) => ({ value, label: value })) } } : {}), available: async () => ({ ok: e.ok }) })) } as never);
    bag.ctx.provide("repos", { get: () => ({ defaultBranch: "main" }), cloneInto: async (remote: string, branch: string, parent: string) => { cloned.push({ remote, branch, parent }); if (code.clearsOnClone) code.gate = null; } } as never);
  }
  const accept = (policy: Record<string, unknown> = {}) => bag.ctx.settings.set({ ...bag.ctx.settings.get(), dispatch: { accept: true, ...policy } } as never);
  const m = { ...bag, dir, device, s: undefined as unknown as Dispatch, queue: undefined as unknown as Dispatch["queue"], code, engines, cloned, accept, storage: bag.ctx.storage };
  await opts.prepare?.(m);
  await bag.ctx.plugin(Dispatch, { logFile: path.join(dir, "dispatch-log.json"), tickMs: 3_600_000 });
  await settle();
  m.s = bag.ctx.dispatch;
  m.queue = bag.ctx.dispatch.queue;
  return m;
}
export type Machine = Awaited<ReturnType<typeof machine>>;

/** The project's folder as `from` has it now reaches `to`: attached the first time, read again after. */
export async function share(from: Machine, to: Machine, projectId: string): Promise<void> {
  await from.storage.publish(projectId);
  const source = from.hub.catalog.project(projectId)!.dir!;
  const target = path.join(to.dir, "hub", "projects", `shared-${projectId.slice(0, 8)}`);
  const first = !to.hub.catalog.project(projectId);
  fs.cpSync(source, target, { recursive: true, force: true });
  if (first) await to.storage.attach(target);
  else await to.storage.refresh(projectId);
}

export async function until(check: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
