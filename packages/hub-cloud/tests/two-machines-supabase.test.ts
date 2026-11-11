/**
 * Two machines on one account Hub, against a whole Supabase: GoTrue's sign-in and sessions, PostgREST and Postgres,
 * reached by the real supabase-js client. Opt-in, and only ever a local `supabase start` with this repository's
 * migrations — never production:
 *
 *   TOMRADE_E2E_SUPABASE_URL=http://127.0.0.1:54321 TOMRADE_E2E_SUPABASE_KEY=<anon or publishable>
 *   TOMRADE_E2E_SUPABASE_SERVICE_KEY=<service role, to make and remove the test account> pnpm test <this file>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Storage } from "@tomradex/storage";
import Settings from "@tomradex/settings";
import { CloudHub } from "../src/service.js";

const URL = process.env.TOMRADE_E2E_SUPABASE_URL ?? "";
const KEY = process.env.TOMRADE_E2E_SUPABASE_KEY ?? "";
const SERVICE = process.env.TOMRADE_E2E_SUPABASE_SERVICE_KEY ?? "";
const enabled = !!(URL && KEY && SERVICE);
if (enabled && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(URL)) throw new Error("TOMRADE_E2E_SUPABASE_URL must be a local Supabase");

const account = { email: `two-machines-${randomUUID()}@example.test`, password: `pw-${randomUUID()}`, id: "" };
/** A second account, on the free plan. */
const free = { email: `free-plan-${randomUUID()}@example.test`, password: `pw-${randomUUID()}`, id: "" };
const admin = () => createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

/** Mutations sent to the Hub, counted where every request leaves. */
let mutations = 0;
const realFetch = globalThis.fetch;
const dirs: string[] = [];
const contexts: { fiber: { dispose(): Promise<unknown> } }[] = [];

beforeAll(async () => {
  if (!enabled) return;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("/rpc/tomrade_mutate_hub")) mutations++;
    return realFetch(input, init);
  }) as typeof fetch;
  const { data, error } = await admin().auth.admin.createUser({ email: account.email, password: account.password, email_confirm: true });
  if (error) throw error;
  account.id = data.user.id;
  // The first tests play four machines on it: more than the free plan allows.
  const { error: unpaid } = await admin().from("tomrade_entitlements").insert({ user_id: account.id, plan: "placeholder_plus", device_limit: null });
  if (unpaid) throw unpaid;
  const made = await admin().auth.admin.createUser({ email: free.email, password: free.password, email_confirm: true });
  if (made.error) throw made.error;
  free.id = made.data.user.id;
}, 60_000);

afterAll(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = realFetch;
  if (account.id) await admin().auth.admin.deleteUser(account.id);
  if (free.id) await admin().auth.admin.deleteUser(free.id);
});

/** Each machine keeps its own session, as each app's keychain does. */
const memoryStorage = (): SupportedStorage => {
  const kept = new Map<string, string>();
  return { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: (k) => void kept.delete(k) };
};

async function machine(device: string, as = account) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hub-supabase-"));
  dirs.push(dir);
  const bag = await fresh({ hubDir: path.join(dir, "hub"), device, plugins: [
    [Settings, { path: path.join(dir, "settings.json") }],
    [Storage, { watch: false, reconcileMs: 0, snapshotIdleMs: 60_000, snapshotMaxMs: 60_000 }]
  ] });
  contexts.push(bag.ctx);
  await bag.ctx.storage.ready;
  bag.projects.update(bag.project.id, { description: `Worked on ${device}` });
  await bag.ctx.plugin(CloudHub, { url: URL, publishableKey: KEY, cacheFile: path.join(dir, "hub-cloud.json"), sessionStorage: memoryStorage(), syncMs: 60_000 });
  await settle();
  await bag.ctx.cloudHub.ready;
  await bag.ctx.cloudHub.signIn(as.email, as.password, true);
  return { ...bag, cloud: bag.ctx.cloudHub };
}

it.skipIf(!enabled)("two machines signed in to one account agree through Supabase, settle a clash once chosen, and then send nothing", async () => {
  const a = await machine("supabase-a");
  const b = await machine("supabase-b");
  const both = [a, b];
  for (const m of both) {
    expect(m.cloud.info().user?.email).toBe(account.email);
    expect(m.cloud.info().conflicts).toEqual([]);
  }

  const made = a.ctx.projects.create({ name: "Made on A", keyPrefix: "MOA" });
  await a.ctx.storage.writeHub();
  a.ctx.settings.set({ ...a.ctx.settings.get(), theme: "matcha" });
  await a.cloud.sync();
  for (let i = 0; i < 2; i++) await b.cloud.sync();
  b.ctx.settings.set({ ...b.ctx.settings.get(), language: "zh" });
  await b.cloud.sync();
  for (let i = 0; i < 2; i++) await a.cloud.sync();
  for (const m of both) {
    expect(m.cloud.info().conflicts).toEqual([]);
    expect(m.cloud.info().status.state).toBe("synced");
    expect(m.cloud.manifest().projects.map((p) => p.id).sort()).toEqual([a.project.id, b.project.id, made.id].sort());
    expect(m.ctx.settings.get()).toMatchObject({ theme: "matcha", language: "zh" });
  }

  a.ctx.settings.set({ ...a.ctx.settings.get(), theme: "light" });
  b.ctx.settings.set({ ...b.ctx.settings.get(), theme: "dark" });
  await a.cloud.sync();
  await b.cloud.sync();
  expect(b.cloud.info().conflicts.map((c) => c.id)).toEqual(["preference:settings"]);
  // As the account panel's choice does (account.resolve): settle, apply, sync.
  b.cloud.cache.resolve("preference:settings", "cloud");
  b.ctx.settings.refreshUserStore();
  await b.cloud.sync();
  await a.cloud.sync();
  for (const m of both) {
    expect(m.cloud.info().conflicts).toEqual([]);
    expect(m.cloud.info().status.state).toBe("synced");
    expect(m.ctx.settings.get()).toMatchObject({ theme: "light", language: "zh" });
  }

  const sent = mutations;
  const told = both.map((m) => vi.spyOn(m.ctx.settings, "refreshUserStore"));
  for (let i = 0; i < 3; i++) {
    for (const m of both) {
      await m.ctx.storage.writeHub();
      await m.cloud.sync();
    }
  }
  expect(mutations).toBe(sent);
  for (const spy of told) expect(spy).not.toHaveBeenCalled();
  for (const m of both) expect(m.cloud.info()).toMatchObject({ pending: 0, conflicts: [] });
}, 120_000);

it.skipIf(!enabled)("each machine sees the other among the account's machines, online over the real presence channel", async () => {
  const a = await machine("supabase-c");
  const b = await machine("supabase-d");
  await a.cloud.sync();
  const other = () => a.cloud.devices().find((d) => d.id === "supabase-d");
  // B registered after A last read: its presence is what makes A read again.
  await vi.waitFor(() => expect(other()).toMatchObject({ self: false, online: true, platform: process.platform }), { timeout: 30_000, interval: 250 });
  expect(b.cloud.devices().find((d) => d.id === "supabase-c")).toMatchObject({ self: false, online: true });
  expect(a.cloud.devices().find((d) => d.self)).toMatchObject({ id: "supabase-c", online: true });

  await a.cloud.renameDevice("supabase-d", "The other one");
  await b.cloud.sync();
  expect(b.cloud.devices().find((d) => d.self)).toMatchObject({ name: "The other one" });

  await b.cloud.goOffline();
  await vi.waitFor(() => expect(other()).toMatchObject({ online: false }), { timeout: 30_000, interval: 250 });

  await a.cloud.removeDevice("supabase-d");
  await b.cloud.sync();
  expect(b.cloud.devicesInfo()).toMatchObject({ state: "removed", devices: [] });
  expect(a.cloud.devices().map((d) => d.id)).not.toContain("supabase-d");
}, 120_000);

it.skipIf(!enabled)("three machines racing for a free account's two places: two take them, the third has none until one is removed", async () => {
  // Each machine's sign-in registers it: all three ask at once.
  const three = await Promise.all(["free-a", "free-b", "free-c"].map((device) => machine(device, free)));
  for (const m of three) await m.cloud.sync();
  const states = three.map((m) => m.cloud.devicesInfo().state).sort();
  expect(states).toEqual(["over-limit", "ready", "ready"]);
  const out = three.find((m) => m.cloud.devicesInfo().state === "over-limit")!;
  expect(out.cloud.devicesInfo()).toMatchObject({ plan: { id: "free", limit: 2 } });
  expect(out.cloud.devices()).toHaveLength(2);
  expect(out.cloud.info().status.state).toBe("synced");
  const { data } = await admin().from("tomrade_devices").select("device_id").eq("user_id", free.id).is("removed_at", null);
  expect(data).toHaveLength(2);

  await out.cloud.removeDevice(out.cloud.devices()[0]!.id);
  await out.cloud.sync();
  expect(out.cloud.devicesInfo().state).toBe("ready");
}, 120_000);
