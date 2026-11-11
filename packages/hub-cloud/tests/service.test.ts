import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomradex/testkit";
import { Storage, readArtifact, readHubManifest } from "@tomradex/storage";
import Settings from "@tomradex/settings";
import { CloudHub, TERMS_VERSION, type LocalAccounts } from "../src/service.js";
import { CloudCache, type CloudRecord, type Mutation } from "../src/cache.js";
import { THEME_TYPOGRAPHY_NAMES, THEME_TOKEN_NAMES, type CustomTheme } from "@tomradex/domain";

const remote = vi.hoisted(() => ({
  offline: false, loseReply: false, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", hubId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  records: new Map<string, CloudRecord>(), receipts: new Map<string, unknown>(), requests: [] as Mutation[], forgotten: [] as string[],
  /** Who the next sign-in or sign-up turns out to be; the owner when null. */
  as: null as { id: string; email: string } | null, confirm: false, signUps: 0, adopted: [] as unknown[],
  /** Emails asked for, with where their link lands. `taken` answers sign-up as for an existing address. */
  mails: [] as { type: string; email: string; to?: string }[], taken: false, mailWait: 0,
  /** The account's user_metadata, what sign-up sent as metadata, and each metadata update in order. */
  meta: {} as Record<string, unknown>, signUpData: null as Record<string, unknown> | null, metaUpdates: [] as Record<string, unknown>[],
  /** Accounts deleted through the RPC. */
  deleted: [] as string[],
  /** Each read of the Hub's records: from when, or null for all of them. */
  reads: [] as (string | null)[],
  /** Whether this machine starts with a stored session. */
  signedIn: true,
  /** How long each write to the Hub takes to answer. */
  rpcWait: 0,
  /** Records the database refuses with a code of its own, by kind:key. */
  refuse: new Set<string>(),
  /** How many passes asked for the Hub, reachable or not. */
  passes: 0,
  /** The account's machines, by id. */
  devices: new Map<string, { device_id: string; name: string; facts: unknown; last_seen_at: string; updated_at: string }>()
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => {
  const mail = async (type: string, email: string, to?: string) => {
    if (remote.mailWait) return { data: {}, error: { code: "over_email_send_rate_limit", message: `For security purposes, you can only request this after ${remote.mailWait} seconds.` } };
    remote.mails.push({ type, email, to });
    return { data: {}, error: null };
  };
  const user = () => ({ id: remote.userId, email: "user@example.test", user_metadata: { ...remote.meta } });
  const session = () => { const u = remote.as ?? user(); return { access_token: `access-${u.id}`, refresh_token: `refresh-${u.id}`, user: u }; };
  return {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: remote.signedIn ? { user: user() } : null }, error: null }),
      stopAutoRefresh() {}, signOut: async () => ({ error: remote.offline ? { message: "fetch failed" } : null }),
      signInWithPassword: async ({ password }: { password: string }) => password === "wrong"
        ? { data: { user: null, session: null }, error: { message: "Invalid login credentials", code: "invalid_credentials" } }
        : { data: { user: session().user, session: session() }, error: null },
      signUp: async ({ email, options }: { email: string; options?: { emailRedirectTo?: string; data?: Record<string, unknown> } }) => {
        remote.signUps++;
        remote.signUpData = options?.data ?? null;
        if (remote.taken) return { data: { user: { ...session().user, identities: [] }, session: null }, error: null };
        if (remote.confirm) remote.mails.push({ type: "signup", email, to: options?.emailRedirectTo });
        return { data: { user: session().user, session: remote.confirm ? null : session() }, error: null };
      },
      resend: async ({ type, email, options }: { type: string; email: string; options?: { emailRedirectTo?: string } }) => mail(type, email, options?.emailRedirectTo),
      resetPasswordForEmail: async (email: string, options?: { redirectTo?: string }) => mail("recovery", email, options?.redirectTo),
      setSession: async (s: { user?: unknown }) => { remote.adopted.push(s); return { data: { session: s, user: s.user }, error: null }; },
      updateUser: async ({ data }: { data: Record<string, unknown> }) => {
        if (remote.offline) return { data: { user: null }, error: { message: "fetch failed" } };
        remote.metaUpdates.push(data);
        remote.meta = { ...remote.meta, ...data };
        return { data: { user: user() }, error: null };
      }
    },
    channel: () => {
      const channel = { on: () => channel, subscribe: () => channel, presenceState: () => ({}), track: async () => "ok", untrack: async () => "ok" };
      return channel;
    },
    removeChannel: async () => "ok",
    rpc: async (name: string, args?: { p_mutation: Mutation; p_device?: string; p_name?: string; p_facts?: unknown }) => {
      if (name === "tomrade_register_device" || name === "tomrade_device_seen") {
        if (remote.offline) return { data: null, error: { message: "offline" } };
        if (name === "tomrade_device_seen") return { data: null, error: null };
        const at = "2026-11-11T00:00:00.000Z";
        remote.devices.set(args!.p_device!, { device_id: args!.p_device!, name: remote.devices.get(args!.p_device!)?.name ?? args!.p_name!, facts: args!.p_facts, last_seen_at: at, updated_at: at });
        return { data: { state: "registered" }, error: null };
      }
      if (name === "tomrade_delete_account") {
        if (remote.offline) return { data: null, error: { message: "TypeError: fetch failed" } };
        remote.deleted.push((remote.as ?? user()).id);
        return { data: null, error: null };
      }
      if (name === "tomrade_ensure_hub") remote.passes++;
      if (remote.offline) return { data: null, error: { message: "offline" } };
      if (name === "tomrade_ensure_hub") return { data: remote.hubId, error: null };
      if (remote.rpcWait) await new Promise((resolve) => setTimeout(resolve, remote.rpcWait));
      const op = args!.p_mutation;
      if (remote.refuse.has(`${op.kind}:${op.key}`)) return { data: null, error: { message: "Mutation id reused", code: "P0001" } };
      remote.requests.push(structuredClone(op));
      if (remote.receipts.has(op.id)) return { data: remote.receipts.get(op.id), error: null };
      const key = `${op.kind}:${op.key}`;
      const old = remote.records.get(key);
      if ((old?.version ?? 0) !== op.base_version) return { data: { ok: false, record: old }, error: null };
      const record = { kind: op.kind, key: op.key, value: op.value, version: op.base_version + 1 };
      const result = { ok: true, record };
      remote.records.set(key, record); remote.receipts.set(op.id, result);
      if (remote.loseReply) { remote.loseReply = false; return { data: null, error: { message: "response lost" } }; }
      return { data: result, error: null };
    },
    from: (table: string) => {
      // A row without its own change time reads as changed just now, as a newly written one would.
      let since: string | null = null;
      const query = { select: () => query, eq: () => query, order: () => query, is: () => query,
        limit: async () => (remote.offline ? { data: null, error: { message: "offline" } } : { data: table === "tomrade_devices" ? [...remote.devices.values()] : [], error: null }),
        gt: (_column: string, at: string) => { since = at; return query; },
        range: async (a: number, b: number) => {
          if (a === 0) remote.reads.push(since);
          const rows = [...remote.records.values()].map((r) => ({ updated_at: new Date().toISOString(), ...r }));
          return { data: rows.filter((r) => !since || r.updated_at > since).slice(a, b + 1), error: null };
        } };
      return query;
    }
  };
} }));

const dirs: string[] = [];
const contexts: { fiber: { dispose(): Promise<unknown> } }[] = [];
beforeEach(() => {
  remote.offline = false; remote.loseReply = false; remote.records.clear(); remote.receipts.clear(); remote.requests = []; remote.forgotten = [];
  remote.as = null; remote.confirm = false; remote.signUps = 0; remote.adopted = [];
  remote.mails = []; remote.taken = false; remote.mailWait = 0;
  remote.meta = {}; remote.signUpData = null; remote.metaUpdates = []; remote.deleted = []; remote.signedIn = true; remote.reads = []; remote.rpcWait = 0; remote.refuse.clear(); remote.passes = 0; remote.devices.clear();
});
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function machine({ used = true, accounts, syncMs = 60_000 }: { used?: boolean; accounts?: LocalAccounts; syncMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cloud-service-")); dirs.push(dir);
  const hubDir = path.join(dir, "hub");
  const bag = await fresh({ hubDir, plugins: [
    [Settings, { path: path.join(dir, "settings.json") }],
    [Storage, { watch: false, reconcileMs: 0, snapshotIdleMs: 60_000, snapshotMaxMs: 60_000 }]
  ] });
  contexts.push(bag.ctx);
  await bag.ctx.storage.ready;
  // Used here, so it is the account's project and not the first run's placeholder.
  if (used) bag.projects.update(bag.project.id, { description: "Worked on this machine" });
  bag.ctx.settings.register({ id: "secret", title: "Secret", schema: z.object({ nested: z.object({ token: z.string().meta({ format: "password" }) }) }), defaults: { nested: { token: "" } }, scope: "user" });
  bag.ctx.settings.set({ ...bag.ctx.settings.get(), theme: "dark", secret: { nested: { token: "never-upload" } } });
  await bag.ctx.storage.writeHub();
  const legacy = fs.readFileSync(path.join(hubDir, "hub.json"), "utf8");
  await bag.ctx.plugin(CloudHub, {
    url: "https://example.supabase.co", publishableKey: "sb_publishable_test", cacheFile: path.join(dir, "hub-cloud.json"),
    sessionStorage: { getItem: () => null, setItem() {}, removeItem: (key: string) => { remote.forgotten.push(key); } }, syncMs, accounts
  });
  await settle();
  await bag.ctx.cloudHub.ready;
  return { ...bag, dir, hubDir, legacy, cloud: bag.ctx.cloudHub };
}

it("reads only what changed in the cloud after the first read, and tells no window of a pass that changed nothing", async () => {
  const { ctx, cloud, dir } = await machine();
  await cloud.sync();
  const refreshed = vi.spyOn(ctx.settings, "refreshUserStore");
  remote.reads = [];
  await cloud.sync();
  expect(remote.reads).toHaveLength(1);
  expect(remote.reads[0]).not.toBeNull();
  expect(refreshed).not.toHaveBeenCalled();
  remote.records.set("project:elsewhere", { kind: "project", key: "elsewhere", value: { id: "elsewhere", name: "Elsewhere", keyPrefix: "ELS" }, version: 1 });
  await cloud.sync();
  expect(refreshed).toHaveBeenCalledTimes(1);
  // Laid over what was read before, not in its place.
  const keys = (JSON.parse(fs.readFileSync(path.join(dir, "hub-cloud.json"), "utf8")) as { records: { key: string }[] }).records.map((r) => r.key);
  expect(keys).toContain("elsewhere");
  expect(keys).toContain("settings");
});

it("takes a record the database hands back with its keys in its own order as the same record: nothing is changed, sent or told", async () => {
  const { ctx, cloud, project } = await machine();
  await cloud.sync();
  const key = `project:${project.id}`;
  const record = remote.records.get(key)!;
  const value = record.value as Record<string, unknown>;
  // jsonb gives keys back shortest first, then in byte order.
  const reordered = Object.fromEntries(Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).map((k) => [k, value[k]]));
  expect(Object.keys(reordered)).not.toEqual(Object.keys(value));
  remote.records.set(key, { ...record, value: reordered, updated_at: new Date().toISOString() } as CloudRecord);
  await cloud.sync();
  // Unchanged in the cloud from now on: later reads leave it out.
  remote.records.set(key, { ...record, value: reordered, updated_at: "2000-01-01T00:00:00.000Z" } as CloudRecord);
  const held = JSON.stringify(cloud.manifest());
  const refreshed = vi.spyOn(ctx.settings, "refreshUserStore");
  const sent = remote.requests.length;
  await cloud.sync();
  await cloud.sync();
  expect(refreshed).not.toHaveBeenCalled();
  expect(remote.requests).toHaveLength(sent);
  expect(JSON.stringify(cloud.manifest())).toBe(held);
});

it("sends a change queued while a pass is already sending right after that pass, not at the next sweep", async () => {
  const { ctx, cloud } = await machine();
  await cloud.sync();
  remote.rpcWait = 1_500;
  ctx.settings.set({ ...ctx.settings.get(), theme: "matcha" });
  // The first change's pass starts a second later and is still waiting on the cloud when the next change comes.
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  ctx.settings.set({ ...ctx.settings.get(), theme: "light" });
  const theme = () => (remote.records.get("preference:settings")?.value as { sections?: { theme?: { value?: string } } } | undefined)?.sections?.theme?.value;
  for (let i = 0; i < 120 && theme() !== "light"; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(theme()).toBe("light");
}, 15_000);

it("migrates only portable metadata, preserves legacy files, and continues the project write path", async () => {
  const { ctx, cloud, hubDir, legacy, project, board, items, hub } = await machine();
  await cloud.sync();
  expect(cloud.info().status.state).toBe("synced");
  expect(remote.records.get(`project:${project.id}`)?.value).toMatchObject({ name: project.name });
  expect(remote.records.get("preference:settings")?.value).toMatchObject({ sections: { theme: { value: "dark" } } });
  const uploaded = JSON.stringify(remote.requests);
  expect(uploaded).not.toContain("never-upload");
  expect(uploaded).not.toContain(hubDir);
  expect(fs.readFileSync(path.join(hubDir, "hub.json"), "utf8")).toBe(legacy);
  expect(readHubManifest(hubDir)?.projects).toHaveLength(1);
  const item = items.create({ projectId: project.id, boardId: board.id, title: "Local content", by: "human" });
  await ctx.storage.publish(project.id);
  expect(readArtifact(hub.catalog.project(project.id)!.dir!)?.tables.items[0].id).toBe(item.id);
  expect(JSON.stringify(remote.requests)).not.toContain("Local content");
  ctx.settings.set({ ...ctx.settings.get(), theme: "matcha" });
  await cloud.sync();
  expect(remote.records.get("preference:settings")?.value).toMatchObject({ sections: { theme: { value: "matcha" } } });
  const custom = {
    id: "custom:test-theme", name: "Test theme", base: "dark",
    tokens: Object.fromEntries(THEME_TOKEN_NAMES.map(name => [name, "#123456"])),
    fonts: Object.fromEntries(THEME_TYPOGRAPHY_NAMES.map(name => [name, "Test Font"]))
  } as CustomTheme;
  ctx.settings.set({ ...ctx.settings.get(), theme: custom.id, customThemes: [custom], themeAutomation: { mode: "schedule", defaultTheme: "light", schedule: [{ start: "18:00", end: "23:00", theme: custom.id }], shuffleMinutes: 30 } });
  await cloud.sync();
  expect(remote.records.get("preference:settings")?.value).toMatchObject({ sections: {
    theme: { value: custom.id }, customThemes: { value: [{ name: "Test theme", tokens: { accent: "#123456" }, fonts: { "font-body": "Test Font" } }] },
    themeAutomation: { value: { mode: "schedule", schedule: [{ start: "18:00", end: "23:00", theme: custom.id }] } }
  } });
  expect(JSON.parse(fs.readFileSync(path.join(hubDir, "settings.json"), "utf8")).sections.theme.value).toBe("dark");
});

it("keeps offline edits and replays the exact request after the server committed but the reply was lost", async () => {
  remote.offline = true;
  const { cloud, dir } = await machine();
  await cloud.sync();
  expect(cloud.info().pending).toBeGreaterThan(0);
  expect(cloud.info().status.detail).toBe("offline");
  const first = cloud.cache.data.outbox[0];
  expect(JSON.parse(fs.readFileSync(path.join(dir, "hub-cloud.json"), "utf8")).outbox[0]).toEqual(first);
  remote.offline = false; remote.loseReply = true;
  await cloud.sync();
  expect(cloud.cache.data.outbox[0]).toEqual(first);
  await cloud.sync();
  expect(remote.requests.filter(r => r.id === first.id)).toHaveLength(2);
  expect(cloud.info().pending).toBe(0);
  expect(remote.records.get(`${first.kind}:${first.key}`)?.version).toBe(1);
});

it("pulls cloud-only projects without creating local placements, and refuses remote secret sections", async () => {
  const { cloud, hub, ctx } = await machine();
  await cloud.sync();
  remote.records.set("project:elsewhere", { kind: "project", key: "elsewhere", version: 1, value: { id: "elsewhere", name: "Remote project", keyPrefix: "REM", remote: null, hint: null, updatedAt: 0 } });
  remote.records.set("preference:settings", { kind: "preference", key: "settings", version: 2, value: {
    v: 1,
    sections: {
      theme: { value: "light", updatedAt: 1 },
      secret: { value: { nested: { token: "injected" } }, updatedAt: 9999999999999 }
    }
  } });
  await cloud.sync();
  expect(cloud.manifest().projects.map(p => p.id)).toContain("elsewhere");
  await ctx.storage.restoreMissing();
  expect(hub.catalog.project("elsewhere")).toBeNull();
  expect(ctx.storage.restores().entries).toEqual([expect.objectContaining({ projectId: "elsewhere", name: "Remote project", state: "not-backed-up" })]);
  // Nobody can find its folder: taking it out of the account is a tombstone every machine receives.
  ctx.storage.removeFromHub("elsewhere");
  await cloud.sync();
  expect(remote.records.get("project:elsewhere")).toMatchObject({ value: null, version: 2 });
  expect(cloud.manifest().projects.map(p => p.id)).not.toContain("elsewhere");
  expect(ctx.storage.restores().entries).toEqual([]);
  expect(ctx.settings.get().theme).toBe("light");
  expect(ctx.settings.get().secret).toEqual({ nested: { token: "never-upload" } });
});

it("resolves the single settings document as one conflict boundary", async () => {
  const { cloud, ctx } = await machine();
  await cloud.sync();
  ctx.settings.set({ ...ctx.settings.get(), theme: "matcha", language: "zh" });
  remote.records.set("preference:settings", { kind: "preference", key: "settings", version: 2, value: {
    v: 1, sections: { theme: { value: "light", updatedAt: 1 }, language: { value: "en", updatedAt: 1 } }
  } });
  await cloud.sync();
  expect(cloud.info().conflicts[0].id).toBe("preference:settings");
  cloud.cache.resolve("preference:settings", "local");
  await cloud.sync();
  expect(remote.records.get("preference:settings")).toMatchObject({
    version: 3,
    value: { sections: { theme: { value: "matcha" }, language: { value: "zh" } } }
  });
  expect(cloud.info().pending).toBe(0);
});

type Sections = Record<string, { value: unknown; updatedAt: number }>;
const cloudSettings = () => (remote.records.get("preference:settings")?.value as { sections: Sections }).sections;

it("a machine joining an account that has settings takes what only the account set, with no conflict, and later keeps what it cannot read", async () => {
  const { ctx, cloud } = await machine();
  // Set elsewhere: the same choices this machine made, stamped at other times, and a section no plugin here knows.
  const theirs: Sections = Object.fromEntries(Object.entries(ctx.settings.exportUser().sections).map(([id, e]) => [id, { value: e.value, updatedAt: 1 }]));
  theirs.elsewhere = { value: { kept: true }, updatedAt: 1 };
  remote.records.set("preference:settings", { kind: "preference", key: "settings", version: 4, value: { v: 1, sections: theirs } });
  await cloud.sync();
  await cloud.sync();
  expect(cloud.info().conflicts).toEqual([]);
  expect(cloud.info().pending).toBe(0);
  expect(cloud.info().status.state).toBe("synced");
  expect(cloudSettings().elsewhere?.value).toEqual({ kept: true });
  expect(cloudSettings().theme?.value).toBe("dark");

  ctx.settings.set({ ...ctx.settings.get(), theme: "matcha" });
  await cloud.sync();
  expect(cloudSettings().theme?.value).toBe("matcha");
  expect(cloudSettings().elsewhere?.value).toEqual({ kept: true });
});

it("a machine joining an account that set a section differently leaves that one for the person, with the account's other sections beside it", async () => {
  const { ctx, cloud } = await machine();
  remote.records.set("preference:settings", { kind: "preference", key: "settings", version: 2, value: { v: 1, sections: {
    theme: { value: "light", updatedAt: 1 },
    elsewhere: { value: { kept: true }, updatedAt: 1 }
  } } });
  await cloud.sync();
  const [conflict] = cloud.info().conflicts;
  expect(conflict?.id).toBe("preference:settings");
  expect((conflict?.local as { sections: Sections }).sections.theme?.value).toBe("dark");
  expect((conflict?.local as { sections: Sections }).sections.elsewhere?.value).toEqual({ kept: true });
  expect(ctx.settings.get().theme).toBe("dark");
  cloud.cache.resolve("preference:settings", "local");
  await cloud.sync();
  expect(cloud.info().conflicts).toEqual([]);
  expect(cloudSettings().theme?.value).toBe("dark");
  expect(cloudSettings().elsewhere?.value).toEqual({ kept: true });
});

it("a clash waiting for the person follows the cloud: taking the cloud's side takes its newest version", async () => {
  const { cloud, ctx } = await machine();
  await cloud.sync();
  ctx.settings.set({ ...ctx.settings.get(), theme: "matcha" });
  remote.records.set("preference:settings", { kind: "preference", key: "settings", version: 2, value: { v: 1, sections: { theme: { value: "light", updatedAt: 1 } } } });
  await cloud.sync();
  expect(cloud.info().conflicts).toHaveLength(1);
  // Another machine writes again before the person chooses.
  remote.records.set("preference:settings", { kind: "preference", key: "settings", version: 3, value: { v: 1, sections: { theme: { value: "sunrise", updatedAt: 2 } } } });
  await cloud.sync();
  expect(cloud.info().conflicts[0]?.cloud).toMatchObject({ sections: { theme: { value: "sunrise" } } });
  cloud.cache.resolve("preference:settings", "cloud");
  expect(cloud.cache.view().find((r) => r.kind === "preference")).toMatchObject({ version: 3 });
});

it("a request the database refuses holds up only its own record: the others are sent, the Hub is read, and the status says why", async () => {
  const { ctx, cloud, project } = await machine();
  await cloud.sync();
  remote.refuse.add(`project:${project.id}`);
  ctx.projects.update(project.id, { name: "Renamed" });
  await ctx.storage.writeHub();
  ctx.settings.set({ ...ctx.settings.get(), theme: "matcha" });
  remote.records.set("project:elsewhere", { kind: "project", key: "elsewhere", value: { id: "elsewhere", name: "Elsewhere", keyPrefix: "ELS" }, version: 1 });
  await cloud.sync();
  expect((remote.records.get("preference:settings")?.value as { sections: Record<string, { value: unknown }> }).sections.theme?.value).toBe("matcha");
  expect(cloud.manifest().projects.map((p) => p.id)).toContain("elsewhere");
  expect(cloud.info().status).toMatchObject({ state: "error", detail: "Mutation id reused" });
  expect(cloud.info().pending).toBe(1);
  remote.refuse.clear();
  await cloud.sync();
  expect(cloud.info().status.state).toBe("synced");
  expect(remote.records.get(`project:${project.id}`)?.value).toMatchObject({ name: "Renamed" });
});

it("waits longer after each pass that could not reach the cloud, and a change still goes at once", async () => {
  const { ctx, cloud } = await machine({ syncMs: 1_000 });
  await cloud.sync();
  remote.offline = true;
  await cloud.sync();
  remote.passes = 0;
  // Every second, asked again at once, the cloud would be asked about six times; waiting 1, 2, then 4 s, two or three.
  await new Promise((resolve) => setTimeout(resolve, 6_500));
  expect(remote.passes).toBeLessThanOrEqual(3);
  remote.offline = false;
  ctx.settings.set({ ...ctx.settings.get(), theme: "matcha" });
  const theme = () => (remote.records.get("preference:settings")?.value as { sections: Record<string, { value: unknown }> }).sections.theme?.value;
  for (let i = 0; i < 60 && theme() !== "matcha"; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(theme()).toBe("matcha");
}, 15_000);

it("a project removed while the catalog is being written is not listed again after its removal", async () => {
  const { ctx, cloud, dir } = await machine();
  await cloud.sync();
  const other = ctx.projects.create({ name: "Second", keyPrefix: "SEC" });
  // In a checkout of its own, so writing the catalog waits on git for it.
  const checkout = path.join(dir, "second-checkout");
  fs.mkdirSync(checkout, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout });
  await ctx.storage.setFolder(other.id, checkout);
  await ctx.storage.writeHub();
  await cloud.sync();
  const writing = ctx.storage.writeHub();
  ctx.projects.remove(other.id);
  await writing;
  // What is queued last for it is what the cloud keeps, even if the app quits before the next write.
  expect(cloud.cache.data.outbox.filter((op) => op.key === other.id).at(-1)).toMatchObject({ value: null });
});

it("two machines on one account agree on its projects and settings, and then their passes send nothing and tell no window", async () => {
  const a = await machine();
  await a.cloud.sync();
  const b = await machine();
  await b.cloud.sync();
  expect(b.cloud.info().conflicts).toEqual([]);
  const made = a.ctx.projects.create({ name: "Made on A", keyPrefix: "MOA" });
  await a.ctx.storage.writeHub();
  b.ctx.settings.set({ ...b.ctx.settings.get(), theme: "matcha" });
  for (let round = 0; round < 2; round++) for (const m of [a, b]) await m.cloud.sync();
  a.ctx.settings.set({ ...a.ctx.settings.get(), language: "zh" });
  for (let round = 0; round < 2; round++) for (const m of [a, b]) await m.cloud.sync();

  for (const m of [a, b]) {
    expect(m.cloud.info().conflicts).toEqual([]);
    expect(m.cloud.info().status.state).toBe("synced");
    expect(m.cloud.manifest().projects.map((p) => p.id).sort()).toEqual([a.project.id, b.project.id, made.id].sort());
    expect(m.ctx.settings.get()).toMatchObject({ theme: "matcha", language: "zh" });
  }

  const sent = remote.requests.length;
  const told = [vi.spyOn(a.ctx.settings, "refreshUserStore"), vi.spyOn(b.ctx.settings, "refreshUserStore")];
  for (let round = 0; round < 3; round++) {
    for (const m of [a, b]) {
      await m.ctx.storage.writeHub();
      await m.cloud.sync();
    }
  }
  expect(remote.requests).toHaveLength(sent);
  for (const spy of told) expect(spy).not.toHaveBeenCalled();
});

it("two machines left to their own timers pass a change on, and then send nothing", async () => {
  const a = await machine({ syncMs: 1_000 });
  const b = await machine({ syncMs: 1_000 });
  await a.cloud.sync();
  await b.cloud.sync();
  // Nobody syncs by hand from here on: a change is queued, sent, and read on the other machine by the timers.
  a.ctx.settings.set({ ...a.ctx.settings.get(), theme: "matcha" });
  for (let i = 0; i < 80 && b.ctx.settings.get().theme !== "matcha"; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(b.ctx.settings.get().theme).toBe("matcha");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const sent = remote.requests.length;
  const told = [vi.spyOn(a.ctx.settings, "refreshUserStore"), vi.spyOn(b.ctx.settings, "refreshUserStore")];
  // Several passes on each.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  expect(remote.requests).toHaveLength(sent);
  for (const spy of told) expect(spy).not.toHaveBeenCalled();
  for (const m of [a, b]) expect(m.cloud.info().status.state).toBe("synced");
}, 30_000);

it("persists a removal before the debounce timer or process exit, and explicit sign-out locks offline access", async () => {
  const { cloud, ctx, project, dir } = await machine();
  await cloud.sync();
  expect(cloud.info().offlineAccess).toBe(true);
  ctx.projects.remove(project.id);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, "hub-cloud.json"), "utf8"));
  expect(disk.outbox.at(-1)).toMatchObject({ kind: "project", key: project.id, value: null });
  await cloud.signOut();
  expect(cloud.info().offlineAccess).toBe(false);
  expect(cloud.info().user).toBeNull();
  expect(cloud.info().pending).toBeGreaterThan(0);
});

it("works without an account, sends nothing, and the first account to sign in takes what was made meanwhile", async () => {
  remote.signedIn = false;
  const { cloud, ctx, project, dir } = await machine();
  expect(cloud.info()).toMatchObject({ user: null, owner: null, offlineAccess: false, localOnly: false });
  expect(cloud.useLocally()).toMatchObject({ user: null, localOnly: true });
  const made = ctx.projects.create({ name: "Made offline", keyPrefix: "MO" });
  await ctx.storage.writeHub();
  await cloud.sync();
  expect(remote.requests).toEqual([]);
  expect(cloud.info().pending).toBeGreaterThan(0);
  // The choice is this local Hub's, so the next start opens straight into the app.
  expect(new CloudCache(path.join(dir, "hub-cloud.json"), "https://example.supabase.co").data).toMatchObject({ localOnly: true, userId: null });

  const info = await cloud.signIn("user@example.test", "password");
  expect(info).toMatchObject({ user: { id: remote.userId }, owner: { email: "user@example.test" }, offlineAccess: true, localOnly: false, pending: 0 });
  expect(remote.records.get(`project:${made.id}`)?.value).toMatchObject({ id: made.id, name: "Made offline" });
  expect(remote.records.get(`project:${project.id}`)?.value).toMatchObject({ id: project.id });
  expect(ctx.projects.list().map(p => p.id).sort()).toEqual([project.id, made.id].sort());

  // Signing out returns to the sign-in page, which offers local use again.
  await cloud.signOut();
  expect(cloud.info()).toMatchObject({ user: null, offlineAccess: false, localOnly: false });
  expect(cloud.useLocally()).toMatchObject({ localOnly: true, owner: { email: "user@example.test" } });
});

it("keeps the first run's untouched project out of the account until someone uses it", async () => {
  const { cloud, ctx, project, board, items } = await machine({ used: false });
  await cloud.sync();
  expect(remote.records.has(`project:${project.id}`)).toBe(false);
  items.create({ projectId: project.id, boardId: board.id, title: "Now it is real", by: "human" });
  await ctx.storage.writeHub();
  await cloud.sync();
  expect(remote.records.get(`project:${project.id}`)?.value).toMatchObject({ id: project.id, name: "Default Project" });
});

it("signs out on this device when the server cannot be reached", async () => {
  const { cloud } = await machine();
  await cloud.sync();
  remote.offline = true;
  await cloud.signOut();
  expect(remote.forgotten).toEqual(["sb-example-auth-token"]);
  expect(cloud.info()).toMatchObject({ user: null, offlineAccess: false });
});

/** The desktop's other local Hubs, as calls. */
function folders(elsewhere: string[] = []) {
  const opened: { user: { id: string; email: string }; session: { key: string; value: string } }[] = [];
  const claimed: { id: string; email: string }[] = [];
  const forgotten: string[] = [];
  const accounts: LocalAccounts = {
    elsewhere: id => elsewhere.includes(id),
    claim: user => { claimed.push(user); },
    open: async (user, session) => { opened.push({ user, session }); },
    forget: id => { forgotten.push(id); }
  };
  return { accounts, opened, claimed, forgotten };
}
const other = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", email: "other@example.test" };

it("hands another account's sign-in to that account's own local Hub and leaves this one as it was", async () => {
  const { accounts, opened, claimed } = folders();
  const { cloud } = await machine({ accounts });
  await cloud.sync();
  expect(claimed.at(-1)).toEqual({ id: remote.userId, email: "user@example.test" });
  await cloud.signOut();
  remote.as = other;
  const info = await cloud.signIn(other.email, "password");
  expect(opened).toEqual([{ user: other, session: { key: "sb-example-auth-token", value: expect.stringContaining(`refresh-${other.id}`) } }]);
  expect(info).toMatchObject({ user: null, switchingTo: other.email, owner: { email: "user@example.test" } });
  expect(remote.adopted).toEqual([]);
  expect(cloud.cache.data.userId).toBe(remote.userId);
});

it("signs the owner back in here, and a machine nobody owns yet belongs to whoever signs in first", async () => {
  const { accounts, opened } = folders();
  const { cloud } = await machine({ accounts });
  await cloud.sync();
  await cloud.signOut();
  const info = await cloud.signIn("user@example.test", "password");
  expect(opened).toEqual([]);
  expect(remote.adopted).toHaveLength(1);
  expect(info).toMatchObject({ user: { id: remote.userId }, offlineAccess: true, switchingTo: null });

  const { accounts: none, opened: nowhere } = folders();
  const fresh = await machine({ accounts: none });
  expect(fresh.cloud.cache.data.userId).toBeNull();
  remote.as = other;
  await fresh.cloud.signIn(other.email, "password");
  expect(nowhere).toEqual([]);
  expect(remote.adopted).toHaveLength(2);
});

it("sends an account that already has a local Hub elsewhere back to it, even from a machine nobody owns", async () => {
  const { accounts, opened } = folders([other.id]);
  const { cloud } = await machine({ accounts });
  remote.as = other;
  await cloud.signIn(other.email, "password");
  expect(opened.map(o => o.user.id)).toEqual([other.id]);
  expect(cloud.cache.data.userId).toBeNull();
});

it("creates another account beside the owner's, and refuses before creating one when it cannot", async () => {
  const { accounts, opened } = folders();
  const { cloud } = await machine({ accounts });
  await cloud.sync();
  await cloud.signOut();
  remote.as = other;
  remote.confirm = true;
  expect(await cloud.signUp(other.email, "long enough", undefined, true)).toEqual({ confirmationRequired: true });
  expect(opened).toEqual([]);
  remote.confirm = false;
  expect(await cloud.signUp(other.email, "long enough", undefined, true)).toEqual({ confirmationRequired: false });
  expect(opened.map(o => o.user.id)).toEqual([other.id]);

  const alone = await machine();
  await alone.cloud.sync();
  await alone.cloud.signOut();
  const before = remote.signUps;
  await expect(alone.cloud.signUp(other.email, "long enough", undefined, true)).rejects.toThrow(/^\[other_account\] .*user@example\.test/);
  expect(remote.signUps).toBe(before);
});

it("links confirmation and reset emails to the site's pages, in the reader's language", async () => {
  const { cloud } = await machine();
  remote.confirm = true;
  expect(await cloud.signUp("new@example.test", "long enough", "zh", true)).toEqual({ confirmationRequired: true });
  await cloud.resendConfirmation("new@example.test", "en");
  await cloud.resetPassword("new@example.test", "zh");
  expect(remote.mails).toEqual([
    { type: "signup", email: "new@example.test", to: "https://tomrade.com/zh/auth/confirmed/" },
    { type: "signup", email: "new@example.test", to: "https://tomrade.com/auth/confirmed/" },
    { type: "recovery", email: "new@example.test", to: "https://tomrade.com/zh/auth/reset/" }
  ]);
});

it("says so when sign-up meets an address that already has an account", async () => {
  const { cloud } = await machine();
  remote.taken = true;
  await expect(cloud.signUp("user@example.test", "long enough", undefined, true)).rejects.toThrow(/^\[user_already_exists\] /);
  expect(remote.mails).toEqual([]);
});

it("leads each failure with a code the sign-in form can translate", async () => {
  const { cloud } = await machine();
  await expect(cloud.signIn("user@example.test", "wrong")).rejects.toThrow(/^\[invalid_credentials\] /);
  await expect(cloud.signIn("not an address", "password")).rejects.toThrow(/^\[email_address_invalid\] /);
  await expect(cloud.signUp("user@example.test", "short")).rejects.toThrow(/^\[weak_password\] /);
  await expect(cloud.resetPassword("not an address")).rejects.toThrow(/^\[email_address_invalid\] /);
  remote.mailWait = 42;
  await expect(cloud.resendConfirmation("user@example.test")).rejects.toThrow(/^\[over_email_send_rate_limit\] .* 42 seconds/);
});

it("creates an account only with the terms agreed, and records which version on it", async () => {
  const { cloud } = await machine();
  remote.confirm = true;
  await expect(cloud.signUp("new@example.test", "long enough")).rejects.toThrow(/^\[terms_required\] /);
  expect(remote.signUps).toBe(0);
  expect(await cloud.signUp("new@example.test", "long enough", "en", true)).toEqual({ confirmationRequired: true });
  expect(remote.signUpData).toMatchObject({ terms_version: TERMS_VERSION, terms_accepted_at: expect.any(String) });
});

it("carries the choice about Tomrade's email to the new account, and none unless it was made", async () => {
  const { cloud } = await machine();
  remote.confirm = true;
  await cloud.signUp("new@example.test", "long enough", "en", true, true);
  expect(remote.signUpData).toMatchObject({ marketing_emails: true });
  await cloud.signUp("new@example.test", "long enough", "en", true, false);
  expect(remote.signUpData).toMatchObject({ marketing_emails: false });
  await cloud.signUp("new@example.test", "long enough", "en", true);
  expect(remote.signUpData).toMatchObject({ marketing_emails: false });
});

it("asks an account that never agreed, and records the agreement once, even after time offline", async () => {
  const { cloud } = await machine();
  await cloud.sync();
  expect(cloud.info().terms).toEqual({ current: TERMS_VERSION, accepted: null });
  expect(remote.metaUpdates).toEqual([]);

  remote.offline = true;
  expect((await cloud.acceptTerms()).terms.accepted).toBe(TERMS_VERSION);
  expect(remote.metaUpdates).toEqual([]);
  remote.offline = false;
  await cloud.sync();
  await cloud.sync();
  expect(remote.metaUpdates).toEqual([{ terms_version: TERMS_VERSION, terms_accepted_at: expect.any(String) }]);
  expect(cloud.info().terms.accepted).toBe(TERMS_VERSION);
});

it("records the terms ticked at sign-in, and never writes over a newer version agreed elsewhere", async () => {
  const { cloud } = await machine();
  await cloud.signIn("user@example.test", "password", true);
  expect(remote.metaUpdates.map(m => m.terms_version)).toEqual([TERMS_VERSION]);

  const later = { terms_version: "2999-01-01" };
  remote.meta = later;
  await cloud.signIn("user@example.test", "password", true);
  await cloud.sync();
  expect(remote.metaUpdates).toHaveLength(1);
  expect(cloud.info().terms.accepted).toBe(later.terms_version);
});

it("deletes the account only with its password, and leaves this computer's projects to the next account", async () => {
  const { accounts, forgotten } = folders();
  const { cloud, ctx, project, dir } = await machine({ accounts });
  await cloud.sync();
  await expect(cloud.deleteAccount("wrong")).rejects.toThrow(/^\[invalid_credentials\] /);
  expect(remote.deleted).toEqual([]);
  expect(cloud.info().user?.id).toBe(remote.userId);

  const info = await cloud.deleteAccount("password");
  expect(remote.deleted).toEqual([remote.userId]);
  expect(info).toMatchObject({ user: null, owner: null, hubId: null, offlineAccess: false });
  expect(remote.forgotten).toContain("sb-example-auth-token");
  expect(forgotten).toEqual([remote.userId]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "hub-cloud.json"), "utf8"));
  expect(saved).toMatchObject({ userId: null, hubId: null, email: null, records: [], conflicts: [], migrated: true });
  expect(saved.outbox.map((op: Mutation) => op.kind)).toEqual(["preference"]);
  expect(ctx.hub.catalog.project(project.id)).toBeTruthy();

  // Whoever signs in next takes this local Hub, projects and all, as on a first run.
  remote.as = other;
  remote.requests = [];
  await cloud.signIn(other.email, "password");
  expect(cloud.cache.data.userId).toBe(other.id);
  expect(remote.requests.some(op => op.kind === "project" && op.key === project.id)).toBe(true);
});

it("keeps the account when the server can't be reached", async () => {
  const { cloud } = await machine();
  await cloud.sync();
  remote.offline = true;
  await expect(cloud.deleteAccount("password")).rejects.toThrow(/^\[network\] /);
  expect(cloud.info().user?.id).toBe(remote.userId);
  expect(cloud.cache.data.userId).toBe(remote.userId);
});
