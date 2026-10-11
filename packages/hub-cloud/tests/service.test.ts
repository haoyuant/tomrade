import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomradex/testkit";
import { Storage, readArtifact, readHubManifest } from "@tomradex/storage";
import Settings from "@tomradex/settings";
import { CloudHub } from "../src/service.js";
import type { CloudRecord, Mutation } from "../src/cache.js";
import { THEME_TYPOGRAPHY_NAMES, THEME_TOKEN_NAMES, type CustomTheme } from "@tomradex/domain";

const remote = vi.hoisted(() => ({
  offline: false, loseReply: false, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", hubId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  records: new Map<string, CloudRecord>(), receipts: new Map<string, unknown>(), requests: [] as Mutation[], forgotten: [] as string[]
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => {
  const user = () => ({ id: remote.userId, email: "user@example.test" });
  return {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: { user: user() } }, error: null }),
      stopAutoRefresh() {}, signOut: async () => ({ error: remote.offline ? { message: "fetch failed" } : null }),
      signInWithPassword: async () => ({ data: { user: user() }, error: null })
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
beforeEach(() => { remote.offline = false; remote.loseReply = false; remote.records.clear(); remote.receipts.clear(); remote.requests = []; remote.forgotten = []; });
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function machine({ used = true } = {}) {
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
    sessionStorage: { getItem: () => null, setItem() {}, removeItem: (key: string) => { remote.forgotten.push(key); } }, syncMs: 60_000
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
