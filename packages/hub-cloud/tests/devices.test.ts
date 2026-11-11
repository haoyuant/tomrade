import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Storage } from "@tomradex/storage";
import Settings from "@tomradex/settings";
import { CloudHub } from "../src/service.js";

interface Row { device_id: string; name: string; facts: unknown; last_seen_at: string; updated_at: string; removed: boolean; activity?: unknown; activity_at?: string | null }

/** One account's side of the cloud: its machines' table as the migration keeps it, and the presence channel. */
const cloud = vi.hoisted(() => ({
  offline: false,
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  rows: new Map<string, Row>(),
  /** Each registration that reached the database, and each "seen" stamp. */
  registered: [] as { device: string; facts: unknown; rejoin: boolean }[],
  seen: [] as string[],
  /** Set: the database refuses a registration with this message, as one without the migration would. */
  refuse: null as string | null,
  /** The account's plan: how many machines it allows, null for no limit. */
  plan: { plan: "placeholder_plus", limit: null as number | null },
  planReads: 0,
  /** Each summary of a machine's work that reached the database, and how often the machines' table was read. */
  told: [] as { device: string; activity: unknown }[],
  reads: 0,
  /** True: an account server from before the activity columns. */
  plain: false,
  /** True: the account answers a registration with nothing, as a stand-in that knows no such function does. */
  blank: false,
  /** True: an account server from before machines said whether they take work. */
  noAccept: false,
  presence: {} as Record<string, Record<string, unknown>[]>,
  listeners: new Set<() => void>(),
  topics: [] as string[],
  tell() { for (const fn of [...cloud.listeners]) fn(); }
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => {
  const user = () => ({ id: cloud.user, email: "user@example.test", user_metadata: {} });
  const down = () => ({ data: null, error: { message: "fetch failed" } });
  const missing = { data: null, error: { message: "No such device", code: "P0002" } };
  const now = () => new Date().toISOString();
  return {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: { user: user() } }, error: null }),
      stopAutoRefresh() {}, signOut: async () => ({ error: null }),
      signInWithPassword: async () => ({ data: { user: user(), session: { access_token: "a", refresh_token: "r", user: user() } }, error: null }),
      setSession: async (s: { user?: unknown }) => ({ data: { session: s, user: s.user }, error: null }),
      updateUser: async () => ({ data: { user: user() }, error: null })
    },
    rpc: async (name: string, args: { p_device?: string; p_name?: string; p_facts?: unknown; p_rejoin?: boolean } = {}) => {
      if (cloud.offline) return down();
      if (name === "tomrade_ensure_hub") return { data: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", error: null };
      if (name === "tomrade_mutate_hub") {
        const op = (args as unknown as { p_mutation: { kind: string; key: string; value: unknown; base_version: number } }).p_mutation;
        return { data: { ok: true, record: { kind: op.kind, key: op.key, value: op.value, version: op.base_version + 1 } }, error: null };
      }
      if (name === "tomrade_device_plan") {
        cloud.planReads++;
        return { data: { ...cloud.plan, used: [...cloud.rows.values()].filter((r) => !r.removed).length }, error: null };
      }
      const id = args.p_device!;
      const old = cloud.rows.get(id);
      if (name === "tomrade_register_device") {
        if (cloud.refuse) return { data: null, error: { message: cloud.refuse, code: "PGRST202" } };
        if (cloud.blank) return { data: null, error: null };
        if (cloud.noAccept && (args.p_facts as { accept?: unknown }).accept) return { data: null, error: { message: "Invalid device fields", code: "22023" } };
        cloud.registered.push({ device: id, facts: args.p_facts, rejoin: !!args.p_rejoin });
        if (old?.removed && !args.p_rejoin) return { data: { state: "removed" }, error: null };
        const used = [...cloud.rows.values()].filter((r) => !r.removed).length;
        if ((!old || old.removed) && cloud.plan.limit !== null && used >= cloud.plan.limit) return { data: { state: "over_limit", ...cloud.plan }, error: null };
        cloud.rows.set(id, { device_id: id, name: old && !old.removed ? old.name : args.p_name!, facts: args.p_facts, last_seen_at: now(), updated_at: now(), removed: false });
        return { data: { state: "registered" }, error: null };
      }
      if (name === "tomrade_report_device_activity") {
        if (cloud.plain) return { data: null, error: { message: "Could not find the function public.tomrade_report_device_activity", code: "PGRST202" } };
        if (!old || old.removed) return { data: false, error: null };
        cloud.told.push({ device: id, activity: structuredClone((args as { p_activity?: unknown }).p_activity) });
        Object.assign(old, { activity: (args as { p_activity?: unknown }).p_activity, activity_at: now(), last_seen_at: now() });
        return { data: true, error: null };
      }
      if (name === "tomrade_device_seen") {
        cloud.seen.push(id);
        if (old && !old.removed) old.last_seen_at = now();
        return { data: null, error: null };
      }
      if (!old || old.removed) return missing;
      if (name === "tomrade_rename_device") old.name = args.p_name!;
      if (name === "tomrade_remove_device") Object.assign(old, { removed: true, facts: {}, activity: {}, activity_at: null });
      return { data: null, error: null };
    },
    from: (table: string) => {
      let columns = "";
      const query = {
        select: (asked: string) => { columns = asked; return query; }, eq: () => query, gt: () => query, order: () => query, is: () => query,
        range: async () => (cloud.offline ? down() : { data: [], error: null }),
        limit: async () => {
          if (cloud.offline) return down();
          if (table !== "tomrade_devices") return { data: [], error: null };
          const wide = columns.includes("activity");
          if (wide && cloud.plain) return { data: null, error: { message: "column tomrade_devices.activity does not exist", code: "42703" } };
          cloud.reads++;
          const rows = [...cloud.rows.values()].filter((r) => !r.removed).map(({ removed: _removed, activity, activity_at, ...row }) => (wide ? { ...row, activity: activity ?? {}, activity_at: activity_at ?? null } : row));
          return { data: structuredClone(rows), error: null };
        }
      };
      return query;
    },
    channel: (topic: string, opts: { config: { private: boolean; presence: { key: string } } }) => {
      const key = opts.config.presence.key;
      cloud.topics.push(`${topic}${opts.config.private ? " (private)" : ""}`);
      let onSync = () => {};
      const channel = {
        on: (_type: string, _filter: unknown, fn: () => void) => { onSync = fn; return channel; },
        subscribe: (said: (status: string) => void) => { cloud.listeners.add(onSync); queueMicrotask(() => said("SUBSCRIBED")); return channel; },
        presenceState: () => structuredClone(cloud.presence),
        track: async (meta: Record<string, unknown>) => { cloud.presence[key] = [meta]; cloud.tell(); return "ok"; },
        untrack: async () => { delete cloud.presence[key]; cloud.tell(); return "ok"; },
        close: () => { cloud.listeners.delete(onSync); if (cloud.presence[key]) { delete cloud.presence[key]; cloud.tell(); } }
      };
      return channel;
    },
    removeChannel: async (channel: { close(): void }) => { channel.close(); return "ok"; }
  };
} }));

const dirs: string[] = [];
const contexts: { fiber: { dispose(): Promise<unknown> } }[] = [];
beforeEach(() => {
  cloud.offline = false; cloud.rows.clear(); cloud.registered = []; cloud.seen = []; cloud.refuse = null;
  cloud.presence = {}; cloud.listeners.clear(); cloud.topics = [];
  cloud.plan = { plan: "placeholder_plus", limit: null }; cloud.planReads = 0;
  cloud.told = []; cloud.reads = 0; cloud.plain = false; cloud.blank = false; cloud.noAccept = false;
});
afterEach(async () => {
  vi.useRealTimers();
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** What the machine's other services say it can do; `agent` and `machineSetup` are read through their contracts. */
interface Abilities { engines: { id: string; title: string; ok: boolean; need?: string }[]; git: "ready" | "missing" }

async function machine(device: string, opts: { dir?: string; appVersion?: string; offlineMs?: number; activityMs?: number } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-devices-"));
  if (!opts.dir) dirs.push(dir);
  const bag = await fresh({ hubDir: path.join(dir, "hub"), device, plugins: [
    [Settings, { path: path.join(dir, "settings.json") }],
    [Storage, { watch: false, reconcileMs: 0, snapshotIdleMs: 60_000, snapshotMaxMs: 60_000 }]
  ] });
  contexts.push(bag.ctx);
  await bag.ctx.storage.ready;
  const able: Abilities = { engines: [{ id: "claude-code", title: "Claude Code", ok: true }], git: "ready" };
  bag.ctx.provide("agent", { codeEngines: () => able.engines.map((e) => ({ id: e.id, title: e.title, available: async () => ({ ok: e.ok, need: e.need }) })) } as never);
  bag.ctx.provide("machineSetup", { git: async () => ({ state: able.git }) } as never);
  await bag.ctx.plugin(CloudHub, {
    url: "https://example.supabase.co", publishableKey: "sb_publishable_test", cacheFile: path.join(dir, "hub-cloud.json"),
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, syncMs: 60_000,
    appVersion: opts.appVersion ?? "1.0.0", deviceOfflineMs: opts.offlineMs ?? 45_000, deviceActivityMs: opts.activityMs ?? 0
  });
  await settle();
  await bag.ctx.cloudHub.ready;
  const changes = { n: 0 };
  bag.ctx.on("cloudHub/devices", () => { changes.n++; });
  return { ...bag, dir, able, changes, cloud: bag.ctx.cloudHub };
}
const stop = async (m: { ctx: { fiber: { dispose(): Promise<unknown> } } }) => {
  contexts.splice(contexts.indexOf(m.ctx), 1);
  await m.ctx.fiber.dispose();
};

it("registers this machine with what it can do, and no path or credential", async () => {
  const a = await machine("mac-0001");
  a.ctx.hub.catalog.setRepo("https://github.com/acme/app", { checkout: "/Users/alice/code/app" });
  a.ctx.hub.catalog.setRepo("git@github.com:acme/tools", { checkout: "/Users/alice/code/tools" });
  a.ctx.hub.catalog.setRepo("https://github.com/acme/unplaced", { checkout: null });
  a.ctx.hub.catalog.setRepo("/Users/alice/code/local-only", { checkout: "/Users/alice/code/local-only" });
  a.able.engines = [
    { id: "codex", title: "Codex", ok: false, need: "sign-in" },
    { id: "claude-code", title: "Claude Code", ok: true },
    { id: "pi", title: "Pi", ok: false, need: "install" }
  ];
  expect(a.cloud.devicesInfo()).toMatchObject({ state: "pending", devices: [] });
  await a.cloud.sync();

  expect(cloud.registered).toHaveLength(1);
  expect(cloud.registered[0]).toEqual({ device: "mac-0001", rejoin: false, facts: {
    platform: process.platform, arch: process.arch, version: "1.0.0", git: true,
    agents: [{ id: "claude-code", title: "Claude Code", ready: true }, { id: "codex", title: "Codex", ready: false }],
    repos: ["git@github.com:acme/tools", "https://github.com/acme/app"]
  } });
  expect(JSON.stringify(cloud.registered)).not.toMatch(/Users|alice|local-only/);
  const info = a.cloud.devicesInfo();
  expect(info.state).toBe("ready");
  expect(info.devices).toMatchObject([{ id: "mac-0001", self: true, online: true, version: "1.0.0", git: true }]);
  expect(a.cloud.devices().map((d) => d.id)).toEqual(["mac-0001"]);
  expect(info.devices[0]!.name).toBe(cloud.rows.get("mac-0001")!.name);
  // Private, and named after the account: nobody else's machines can join it.
  expect(cloud.topics).toEqual([`tomrade-devices:${cloud.user} (private)`]);
});

it("writes again only when what the machine can do changes, across restarts too", async () => {
  const a = await machine("mac-0001");
  for (let i = 0; i < 3; i++) await a.cloud.sync();
  expect(cloud.registered).toHaveLength(1);
  const told = a.changes.n;
  await a.cloud.sync();
  expect(a.changes.n).toBe(told);

  // An agent signs out.
  a.able.engines = [{ id: "claude-code", title: "Claude Code", ok: false, need: "sign-in" }];
  for (let i = 0; i < 2; i++) await a.cloud.sync();
  expect(cloud.registered).toHaveLength(2);
  expect(a.cloud.devices()[0]!.agents).toEqual([{ id: "claude-code", title: "Claude Code", ready: false }]);

  // A new checkout.
  a.ctx.hub.catalog.setRepo("https://github.com/acme/app", { checkout: "/code/app" });
  for (let i = 0; i < 2; i++) await a.cloud.sync();
  expect(cloud.registered).toHaveLength(3);

  // The same build started again says nothing; an upgraded one says its version.
  await stop(a);
  const again = await machine("mac-0001", { dir: a.dir });
  again.able.engines = a.able.engines;
  again.ctx.hub.catalog.setRepo("https://github.com/acme/app", { checkout: "/code/app" });
  for (let i = 0; i < 2; i++) await again.cloud.sync();
  expect(cloud.registered).toHaveLength(3);
  await stop(again);
  const upgraded = await machine("mac-0001", { dir: a.dir, appVersion: "1.1.0" });
  upgraded.able.engines = a.able.engines;
  upgraded.ctx.hub.catalog.setRepo("https://github.com/acme/app", { checkout: "/code/app" });
  await upgraded.cloud.sync();
  expect(cloud.registered).toHaveLength(4);
  expect(cloud.registered.at(-1)!.facts).toMatchObject({ version: "1.1.0" });
});

it("keeps a change made offline owed, and sends it once the account is reachable", async () => {
  cloud.offline = true;
  const a = await machine("mac-0001");
  await a.cloud.sync();
  expect(cloud.registered).toEqual([]);
  expect(a.cloud.devicesInfo()).toMatchObject({ state: "pending", devices: [] });
  cloud.offline = false;
  await a.cloud.sync();
  expect(cloud.registered).toHaveLength(1);

  // Online, then a change while offline: the list stays as last read, and the change goes later.
  cloud.offline = true;
  a.able.git = "missing";
  a.able.engines = [];
  await a.cloud.sync();
  expect(cloud.registered).toHaveLength(1);
  expect(a.cloud.devices()).toMatchObject([{ id: "mac-0001", agents: [{ id: "claude-code" }] }]);
  cloud.offline = false;
  await a.cloud.sync();
  expect(cloud.registered).toHaveLength(2);
  expect(a.cloud.devices()).toMatchObject([{ id: "mac-0001", agents: [] }]);
});

it("an account server without the devices table leaves Hub sync alone", async () => {
  cloud.refuse = "Could not find the function public.tomrade_register_device";
  const a = await machine("mac-0001");
  const warn = vi.spyOn(a.ctx.logger, "warn").mockImplementation(() => {});
  for (let i = 0; i < 3; i++) await a.cloud.sync();
  expect(a.cloud.info().status.state).toBe("synced");
  expect(a.cloud.devicesInfo()).toMatchObject({ state: "pending", devices: [] });
  expect(warn.mock.calls.filter((args) => /not registered/.test(args.map(String).join(" ")))).toHaveLength(1);
  warn.mockRestore();
});

it("sees another machine come online, drop for a while, and say it is leaving", async () => {
  const a = await machine("mac-0001", { offlineMs: 40 });
  await a.cloud.sync();
  const b = await machine("win-0001", { offlineMs: 40 });
  await b.cloud.sync();
  await settle();
  // B's presence arrived before A had its row: A reads the table again by itself.
  await vi.waitFor(() => expect(a.cloud.devices().map((d) => d.id)).toEqual(["mac-0001", "win-0001"]), { timeout: 5000 });
  const other = () => a.cloud.devices().find((d) => d.id === "win-0001")!;
  expect(other()).toMatchObject({ self: false, online: true });
  expect(b.cloud.devices().find((d) => d.id === "mac-0001")).toMatchObject({ self: false, online: true });

  // A dropped connection: still online for a while, then offline with when it was last here.
  const told = a.changes.n;
  const droppedAt = Date.now();
  delete cloud.presence["win-0001"];
  cloud.tell();
  expect(other().online).toBe(true);
  await vi.waitFor(() => expect(other().online).toBe(false), { timeout: 2000 });
  expect(a.changes.n).toBeGreaterThan(told + 1);
  expect(other().lastSeenAt).toBeGreaterThanOrEqual(droppedAt - 5);
  expect(other().lastSeenAt).toBeLessThanOrEqual(Date.now());

  // Back, and then it leaves on purpose: offline at once, and the account is told when it was last here.
  cloud.presence["win-0001"] = [{ at: Date.now() }];
  cloud.tell();
  expect(other().online).toBe(true);
  cloud.seen = [];
  await b.cloud.goOffline();
  expect(other().online).toBe(false);
  expect(cloud.seen).toEqual(["win-0001"]);
  expect(cloud.presence["win-0001"]).toBeUndefined();
  // Its next pass brings it back online.
  await b.cloud.sync();
  await settle();
  expect(other().online).toBe(true);
});

it("shows the others as last seen when it starts with no connection", async () => {
  const a = await machine("mac-0001");
  await a.cloud.sync();
  const b = await machine("win-0001");
  await b.cloud.sync();
  await a.cloud.sync();
  await stop(b);
  await stop(a);
  cloud.offline = true;
  const again = await machine("mac-0001", { dir: a.dir });
  await again.cloud.sync();
  const seenAt = Date.parse(cloud.rows.get("win-0001")!.last_seen_at);
  expect(again.cloud.devices()).toMatchObject([{ id: "mac-0001", self: true, online: true }, { id: "win-0001", online: false, lastSeenAt: seenAt }]);
});

it("renames a machine from any of the account's machines, and keeps the name over what the machine calls itself", async () => {
  const a = await machine("mac-0001");
  await a.cloud.sync();
  const b = await machine("win-0001");
  await b.cloud.sync();
  await a.cloud.sync();
  await a.cloud.renameDevice("win-0001", "  Windows tower ");
  expect(a.cloud.devices().find((d) => d.id === "win-0001")!.name).toBe("Windows tower");
  b.able.git = "missing";
  await b.cloud.sync();
  expect(b.cloud.devices().find((d) => d.self)!.name).toBe("Windows tower");
  await expect(a.cloud.renameDevice("win-0001", "   ")).rejects.toThrow();
  await expect(a.cloud.renameDevice("gone-0001", "Nobody")).rejects.toThrow(/No such device/);
  cloud.offline = true;
  await expect(a.cloud.renameDevice("win-0001", "Later")).rejects.toThrow(/\[network\]/);
});

it("a removed machine stays out until someone signs in on it again", async () => {
  const a = await machine("mac-0001");
  await a.cloud.sync();
  const b = await machine("win-0001");
  await b.cloud.sync();
  await a.cloud.sync();
  await a.cloud.removeDevice("win-0001");
  expect(a.cloud.devices().map((d) => d.id)).toEqual(["mac-0001"]);

  // Still running with its session: it learns it was removed, leaves the presence, and does not come back by itself.
  for (let i = 0; i < 3; i++) await b.cloud.sync();
  expect(b.cloud.devicesInfo()).toMatchObject({ state: "removed", devices: [] });
  expect(cloud.presence["win-0001"]).toBeUndefined();
  b.able.git = "missing";
  const sent = cloud.registered.length;
  for (let i = 0; i < 2; i++) await b.cloud.sync();
  expect(cloud.registered).toHaveLength(sent);
  await a.cloud.sync();
  expect(a.cloud.devices().map((d) => d.id)).toEqual(["mac-0001"]);
  // The Hub itself still syncs there.
  expect(b.cloud.info().status.state).toBe("synced");

  await b.cloud.signIn("user@example.test", "password");
  expect(cloud.registered.at(-1)).toMatchObject({ device: "win-0001", rejoin: true });
  expect(b.cloud.devicesInfo().state).toBe("ready");
  await a.cloud.sync();
  expect(a.cloud.devices().map((d) => d.id)).toEqual(["mac-0001", "win-0001"]);
});

it("removing this machine takes it out at once, and signing out takes it offline", async () => {
  const a = await machine("mac-0001");
  await a.cloud.sync();
  const b = await machine("win-0001");
  await b.cloud.sync();
  await a.cloud.sync();
  await settle();

  await b.cloud.removeDevice("win-0001");
  expect(b.cloud.devicesInfo()).toMatchObject({ state: "removed", devices: [] });

  cloud.seen = [];
  await a.cloud.signOut();
  expect(cloud.presence["mac-0001"]).toBeUndefined();
  expect(cloud.seen).toEqual(["mac-0001"]);
  expect(a.cloud.devicesInfo()).toMatchObject({ state: "signed-out", devices: [] });
});

it("a third machine on the free plan has no place: it says so, lists the two that do, and its Hub still syncs", async () => {
  cloud.plan = { plan: "free", limit: 2 };
  const a = await machine("mac-0001");
  await a.cloud.sync();
  const b = await machine("win-0001");
  await b.cloud.sync();
  const c = await machine("lin-0001");
  await c.cloud.sync();
  await settle();

  const info = c.cloud.devicesInfo();
  expect(info.state).toBe("over-limit");
  expect(info.plan).toEqual({ id: "free", limit: 2, subscribeUrl: "https://tomrade.com/pricing/" });
  // The machines that hold the places, to remove one from here; it is not among them, and sees none as online.
  expect(info.devices.map((d) => [d.id, d.self, d.online])).toEqual([["mac-0001", false, false], ["win-0001", false, false]]);
  expect(cloud.rows.has("lin-0001")).toBe(false);
  expect(cloud.presence["lin-0001"]).toBeUndefined();
  expect(c.cloud.info().status.state).toBe("synced");
  expect(a.cloud.devicesInfo()).toMatchObject({ state: "ready", plan: { id: "free", limit: 2 } });

  // It does not ask again on every pass.
  const asked = cloud.registered.length;
  for (let i = 0; i < 3; i++) await c.cloud.sync();
  expect(cloud.registered).toHaveLength(asked);
  expect(c.cloud.devicesInfo().state).toBe("over-limit");

  // One of the two is removed from the machine that has no place: it takes the place.
  await c.cloud.removeDevice("win-0001");
  await c.cloud.sync();
  await settle();
  expect(c.cloud.devicesInfo().state).toBe("ready");
  expect(c.cloud.devices().map((d) => d.id)).toEqual(["lin-0001", "mac-0001"]);
  expect(c.cloud.devices()[0]).toMatchObject({ self: true, online: true });
  expect(cloud.presence["lin-0001"]).toBeDefined();
});

it("a machine with no place takes one when the account subscribes, once asked to check again", async () => {
  cloud.plan = { plan: "free", limit: 2 };
  const a = await machine("mac-0001");
  await a.cloud.sync();
  const b = await machine("win-0001");
  await b.cloud.sync();
  const c = await machine("lin-0001");
  await c.cloud.sync();
  expect(c.cloud.devicesInfo().state).toBe("over-limit");

  cloud.plan = { plan: "placeholder_plus", limit: null };
  await c.cloud.sync();
  expect(c.cloud.devicesInfo().state).toBe("over-limit");
  expect(await c.cloud.recheckDevices()).toMatchObject({ state: "ready", plan: { id: "placeholder_plus", limit: null } });
  expect(c.cloud.devices().map((d) => d.id).sort()).toEqual(["lin-0001", "mac-0001", "win-0001"]);
  // The others read the new plan when the number of machines changes.
  await a.cloud.sync();
  expect(a.cloud.devicesInfo().plan).toMatchObject({ id: "placeholder_plus", limit: null });
});

it("reads the plan when a run begins and when the machines change, not on every pass", async () => {
  cloud.plan = { plan: "free", limit: 2 };
  const a = await machine("mac-0001");
  for (let i = 0; i < 4; i++) await a.cloud.sync();
  expect(cloud.planReads).toBe(1);
  const b = await machine("win-0001");
  await b.cloud.sync();
  for (let i = 0; i < 3; i++) await a.cloud.sync();
  expect(cloud.planReads).toBe(3);
});

it("a removed machine that signs in again waits for a place when the account is full", async () => {
  cloud.plan = { plan: "free", limit: 2 };
  const a = await machine("mac-0001");
  await a.cloud.sync();
  const b = await machine("win-0001");
  await b.cloud.sync();
  await a.cloud.removeDevice("win-0001");
  const c = await machine("lin-0001");
  await c.cloud.sync();
  expect(c.cloud.devicesInfo().state).toBe("ready");

  await b.cloud.sync();
  expect(b.cloud.devicesInfo().state).toBe("removed");
  await b.cloud.signIn("user@example.test", "password");
  expect(b.cloud.devicesInfo()).toMatchObject({ state: "over-limit", plan: { limit: 2 } });
  await b.cloud.removeDevice("lin-0001");
  await b.cloud.sync();
  expect(b.cloud.devicesInfo().state).toBe("ready");
  expect(cloud.registered.at(-1)).toMatchObject({ device: "win-0001", rejoin: true });
});

const session = (key: string, state = "working", extra: Record<string, unknown> = {}) => ({ projectId: "p-0001", key, title: `Ticket ${key}`, agent: "claude-code", state, startedAt: 1_700_000_000_000, branch: `${key.toLowerCase()}/work`, ...extra });
const idle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

it("tells the account what this machine works on: only the fields it names, and nothing while it is idle", async () => {
  const a = await machine("mac-0001");
  for (let i = 0; i < 2; i++) await a.cloud.sync();
  expect(cloud.told).toEqual([]);

  a.cloud.reportActivity("sessions", [
    session("TOM-1", "working", { cwd: "/Users/alice/code/app", transcript: "/Users/alice/.claude/t.jsonl", prompt: "the secret plan", activity: "Bash: cat ~/.ssh/id_rsa", summary: "said a lot", worktree: "/Users/alice/wt" }),
    // Refused where they stand, without taking the rest with them.
    session("TOM-2", "running"),
    session("../../etc/passwd"),
    { ...session("TOM-3"), agent: "/usr/local/bin/claude" },
    { ...session("TOM-4"), branch: "/Users/alice/code/app" },
    "not a session"
  ]);
  a.cloud.reportActivity("nightShifts", [{ projectId: "p-0001", done: 1, total: 4, startedAt: 1_700_000_000_000, briefPath: "/Users/alice/Tomrade/brief.md", spentUsd: 3 }]);
  await vi.waitFor(() => expect(cloud.told).toHaveLength(1));
  expect(cloud.told[0]).toEqual({ device: "mac-0001", activity: {
    sessions: [
      { projectId: "p-0001", key: "TOM-1", title: "Ticket TOM-1", agent: "claude-code", state: "working", startedAt: 1_700_000_000_000, branch: "tom-1/work" },
      { projectId: "p-0001", key: "TOM-4", title: "Ticket TOM-4", agent: "claude-code", state: "working", startedAt: 1_700_000_000_000, branch: null }
    ],
    nightShifts: [{ projectId: "p-0001", done: 1, total: 4, startedAt: 1_700_000_000_000 }]
  } });
  expect(JSON.stringify(cloud.told)).not.toMatch(/Users|alice|secret|ssh|brief|spentUsd/);
  // This machine reads its own as it is now.
  expect(a.cloud.devices()[0]).toMatchObject({ self: true, sessions: [{ key: "TOM-1" }, { key: "TOM-4" }], nightShifts: [{ done: 1, total: 4 }] });

  // Said again the same, in another order: nothing is written.
  a.cloud.reportActivity("sessions", [{ ...session("TOM-4"), branch: null }, session("TOM-1")]);
  await idle();
  await a.cloud.sync();
  expect(cloud.told).toHaveLength(1);

  // The sessions end: they leave the summary.
  a.cloud.reportActivity("sessions", []);
  a.cloud.reportActivity("nightShifts", []);
  await vi.waitFor(() => expect(cloud.told).toHaveLength(2));
  expect(cloud.told[1]!.activity).toEqual({ sessions: [], nightShifts: [] });
});

it("writes at most once per interval however often a session changes, and ends on the latest", async () => {
  const a = await machine("mac-0001", { activityMs: 150 });
  await a.cloud.sync();
  a.cloud.reportActivity("sessions", [session("TOM-1", "working")]);
  // The first change after a quiet while goes at once.
  await vi.waitFor(() => expect(cloud.told).toHaveLength(1), { timeout: 100 });
  // An agent that flips state many times a second.
  for (let i = 0; i < 40; i++) {
    a.cloud.reportActivity("sessions", [session("TOM-1", i % 2 ? "working" : "waiting")]);
    await idle(5);
  }
  a.cloud.reportActivity("sessions", [session("TOM-1", "blocked")]);
  await idle(400);
  expect(cloud.told.length).toBeLessThanOrEqual(4);
  expect(cloud.told.at(-1)!.activity).toMatchObject({ sessions: [{ key: "TOM-1", state: "blocked" }] });
});

it("another machine sees the change within moments, without waiting for its next pass", async () => {
  const a = await machine("mac-0001");
  await a.cloud.sync();
  const b = await machine("win-0001");
  await b.cloud.sync();
  await a.cloud.sync();
  await settle();
  const other = () => a.cloud.devices().find((d) => d.id === "win-0001")!;
  expect(other()).toMatchObject({ online: true, sessions: [], nightShifts: [], activityAt: null });

  const told = a.changes.n;
  b.cloud.reportActivity("sessions", [session("WIN-7", "waiting")]);
  // No sync is called on A: B's presence says it changed, and A reads the table.
  await vi.waitFor(() => expect(other().sessions).toEqual([{ projectId: "p-0001", key: "WIN-7", title: "Ticket WIN-7", agent: "claude-code", state: "waiting", startedAt: 1_700_000_000_000, branch: "win-7/work" }]), { timeout: 3000 });
  expect(a.changes.n).toBeGreaterThan(told);
  expect(other().activityAt).toBeGreaterThan(Date.now() - 5000);

  b.cloud.reportActivity("sessions", []);
  await vi.waitFor(() => expect(other().sessions).toEqual([]), { timeout: 3000 });
});

it("a machine that went off still shows what it was last doing, and when", async () => {
  const a = await machine("mac-0001", { offlineMs: 0 });
  await a.cloud.sync();
  const b = await machine("win-0001");
  await b.cloud.sync();
  b.cloud.reportActivity("sessions", [session("WIN-7")]);
  await vi.waitFor(() => expect(cloud.told).toHaveLength(1));
  const saidAt = Date.parse(cloud.rows.get("win-0001")!.activity_at!);
  await stop(b);
  await a.cloud.sync();
  expect(a.cloud.devices().find((d) => d.id === "win-0001")).toMatchObject({ online: false, sessions: [{ key: "WIN-7", state: "working" }], activityAt: saidAt });
});

it("keeps a summary that could not be sent owed, and sends what is current once the account is reachable", async () => {
  const a = await machine("mac-0001");
  await a.cloud.sync();
  cloud.offline = true;
  a.cloud.reportActivity("sessions", [session("TOM-1")]);
  await idle();
  a.cloud.reportActivity("sessions", [session("TOM-2")]);
  await idle();
  await a.cloud.sync();
  expect(cloud.told).toEqual([]);
  cloud.offline = false;
  await a.cloud.sync();
  expect(cloud.told.map((t) => t.activity)).toMatchObject([{ sessions: [{ key: "TOM-2" }] }]);
});

it("says nothing of its work from a machine the account has no place for, or was removed from", async () => {
  cloud.plan = { plan: "free", limit: 1 };
  const a = await machine("mac-0001");
  await a.cloud.sync();
  const b = await machine("win-0001");
  await b.cloud.sync();
  expect(b.cloud.devicesInfo().state).toBe("over-limit");
  b.cloud.reportActivity("sessions", [session("WIN-7")]);
  await idle();
  await b.cloud.sync();
  expect(cloud.told).toEqual([]);

  a.cloud.reportActivity("sessions", [session("TOM-1")]);
  await vi.waitFor(() => expect(cloud.told).toHaveLength(1));
  await a.cloud.removeDevice("mac-0001");
  a.cloud.reportActivity("sessions", [session("TOM-2")]);
  await idle();
  expect(cloud.told).toHaveLength(1);
  expect(cloud.rows.get("mac-0001")).toMatchObject({ removed: true, activity: {} });
});

it("an account server from before machines said what they work on still lists them", async () => {
  cloud.plain = true;
  const a = await machine("mac-0001");
  const warn = vi.spyOn(a.ctx.logger, "warn").mockImplementation(() => {});
  await a.cloud.sync();
  const b = await machine("win-0001");
  await b.cloud.sync();
  a.cloud.reportActivity("sessions", [session("TOM-1")]);
  await idle();
  await a.cloud.sync();
  expect(a.cloud.devices().map((d) => [d.id, d.sessions.length, d.activityAt === null || d.self])).toEqual([["mac-0001", 1, true], ["win-0001", 0, true]]);
  expect(cloud.told).toEqual([]);
  warn.mockRestore();
});

it("an answer it cannot read leaves this machine unregistered, said once, and Hub sync alone", async () => {
  cloud.blank = true;
  const a = await machine("mac-0001");
  const warn = vi.spyOn(a.ctx.logger, "warn").mockImplementation(() => {});
  for (let i = 0; i < 3; i++) await a.cloud.sync();
  expect(a.cloud.info().status.state).toBe("synced");
  expect(a.cloud.devicesInfo()).toMatchObject({ state: "pending", devices: [] });
  expect(warn.mock.calls.filter((args) => /not registered/.test(args.map(String).join(" ")))).toHaveLength(1);
  warn.mockRestore();
  cloud.blank = false;
  await a.cloud.sync();
  expect(a.cloud.devicesInfo().state).toBe("ready");
});

it("says whether this machine takes work when another service tells it, and again when that changes", async () => {
  const a = await machine("mac-0001");
  await a.cloud.sync();
  expect(cloud.registered.at(-1)!.facts).not.toHaveProperty("accept");
  let accept: Record<string, unknown> = { on: false, projects: "all", ceiling: "edits", concurrent: 1 };
  a.cloud.describeDevice("accept", () => accept);
  await a.cloud.sync();
  expect(cloud.registered.at(-1)!.facts).toMatchObject({ accept });
  const b = await machine("win-0001");
  await b.cloud.sync();
  expect(b.cloud.devices().find((d) => d.id === "mac-0001")!.accept).toEqual(accept);
  expect(b.cloud.devices().find((d) => d.self)!.accept).toBeUndefined();

  accept = { on: true, projects: ["p-0001"], ceiling: "full", concurrent: 2, secret: "/Users/alice" };
  a.cloud.refreshDevice();
  await a.cloud.sync();
  expect(cloud.registered.at(-1)!.facts).toMatchObject({ accept: { on: true, projects: ["p-0001"], ceiling: "full", concurrent: 2 } });
  expect(JSON.stringify(cloud.registered.at(-1))).not.toMatch(/secret|alice/);
  // A description the database would refuse is left out, not sent.
  accept = { on: true, projects: ["/Users/alice/code"], ceiling: "full", concurrent: 2 };
  const sent = cloud.registered.length;
  await a.cloud.sync();
  expect(cloud.registered).toHaveLength(sent + 1);
  expect(cloud.registered.at(-1)!.facts).not.toHaveProperty("accept");
});

it("an account server from before machines said whether they take work still registers this one", async () => {
  cloud.noAccept = true;
  const a = await machine("mac-0001");
  a.cloud.describeDevice("accept", () => ({ on: true, projects: "all", ceiling: "edits", concurrent: 1 }));
  for (let i = 0; i < 3; i++) await a.cloud.sync();
  expect(a.cloud.devicesInfo().state).toBe("ready");
  expect(cloud.registered).toHaveLength(1);
  expect(cloud.registered[0]!.facts).not.toHaveProperty("accept");
});
