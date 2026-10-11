import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomradex/testkit";
import { Storage, readArtifact, readHubManifest } from "@tomradex/storage";
import Settings from "@tomradex/settings";
import { CloudHub, type LocalAccounts } from "../src/service.js";
import type { CloudRecord, Mutation } from "../src/cache.js";
import { THEME_TYPOGRAPHY_NAMES, THEME_TOKEN_NAMES, type CustomTheme } from "@tomradex/domain";

const remote = vi.hoisted(() => ({
  offline: false, loseReply: false, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", hubId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  records: new Map<string, CloudRecord>(), receipts: new Map<string, unknown>(), requests: [] as Mutation[], forgotten: [] as string[],
  /** Who the next sign-in or sign-up turns out to be; the owner when null. */
  as: null as { id: string; email: string } | null, confirm: false, signUps: 0, adopted: [] as unknown[],
  /** Emails asked for, with where their link lands. `taken` answers sign-up as for an existing address. */
  mails: [] as { type: string; email: string; to?: string }[], taken: false, mailWait: 0
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => {
  const mail = async (type: string, email: string, to?: string) => {
    if (remote.mailWait) return { data: {}, error: { code: "over_email_send_rate_limit", message: `For security purposes, you can only request this after ${remote.mailWait} seconds.` } };
    remote.mails.push({ type, email, to });
    return { data: {}, error: null };
  };
  const user = () => ({ id: remote.userId, email: "user@example.test" });
  const session = () => { const u = remote.as ?? user(); return { access_token: `access-${u.id}`, refresh_token: `refresh-${u.id}`, user: u }; };
  return {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: { user: user() } }, error: null }),
      stopAutoRefresh() {}, signOut: async () => ({ error: remote.offline ? { message: "fetch failed" } : null }),
      signInWithPassword: async ({ password }: { password: string }) => password === "wrong"
        ? { data: { user: null, session: null }, error: { message: "Invalid login credentials", code: "invalid_credentials" } }
        : { data: { user: session().user, session: session() }, error: null },
      signUp: async ({ email, options }: { email: string; options?: { emailRedirectTo?: string } }) => {
        remote.signUps++;
        if (remote.taken) return { data: { user: { ...session().user, identities: [] }, session: null }, error: null };
        if (remote.confirm) remote.mails.push({ type: "signup", email, to: options?.emailRedirectTo });
        return { data: { user: session().user, session: remote.confirm ? null : session() }, error: null };
      },
      resend: async ({ type, email, options }: { type: string; email: string; options?: { emailRedirectTo?: string } }) => mail(type, email, options?.emailRedirectTo),
      resetPasswordForEmail: async (email: string, options?: { redirectTo?: string }) => mail("recovery", email, options?.redirectTo),
      setSession: async (s: { user?: unknown }) => { remote.adopted.push(s); return { data: { session: s, user: s.user }, error: null }; }
    },
    rpc: async (name: string, args?: { p_mutation: Mutation }) => {
      if (remote.offline) return { data: null, error: { message: "offline" } };
      if (name === "tomrade_ensure_hub") return { data: remote.hubId, error: null };
      const op = args!.p_mutation;
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
    from: () => {
      const query = { select: () => query, eq: () => query, order: () => query,
        range: async (a: number, b: number) => ({ data: [...remote.records.values()].slice(a, b + 1), error: null }) };
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
});
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function machine({ used = true, accounts }: { used?: boolean; accounts?: LocalAccounts } = {}) {
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
    sessionStorage: { getItem: () => null, setItem() {}, removeItem: (key: string) => { remote.forgotten.push(key); } }, syncMs: 60_000, accounts
  });
  await settle();
  await bag.ctx.cloudHub.ready;
  return { ...bag, dir, hubDir, legacy, cloud: bag.ctx.cloudHub };
}

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
  const accounts: LocalAccounts = {
    elsewhere: id => elsewhere.includes(id),
    claim: user => { claimed.push(user); },
    open: async (user, session) => { opened.push({ user, session }); }
  };
  return { accounts, opened, claimed };
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
  expect(await cloud.signUp(other.email, "long enough")).toEqual({ confirmationRequired: true });
  expect(opened).toEqual([]);
  remote.confirm = false;
  expect(await cloud.signUp(other.email, "long enough")).toEqual({ confirmationRequired: false });
  expect(opened.map(o => o.user.id)).toEqual([other.id]);

  const alone = await machine();
  await alone.cloud.sync();
  await alone.cloud.signOut();
  const before = remote.signUps;
  await expect(alone.cloud.signUp(other.email, "long enough")).rejects.toThrow(/^\[other_account\] .*user@example\.test/);
  expect(remote.signUps).toBe(before);
});

it("links confirmation and reset emails to the site's pages, in the reader's language", async () => {
  const { cloud } = await machine();
  remote.confirm = true;
  expect(await cloud.signUp("new@example.test", "long enough", "zh")).toEqual({ confirmationRequired: true });
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
  await expect(cloud.signUp("user@example.test", "long enough")).rejects.toThrow(/^\[user_already_exists\] /);
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
