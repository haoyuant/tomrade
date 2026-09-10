import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomrade/testkit";
import { Storage, readArtifact, readHubManifest } from "@tomrade/storage";
import Settings from "@tomrade/settings";
import { CloudHub } from "../src/service.js";
import type { CloudRecord, Mutation } from "../src/cache.js";

const remote = vi.hoisted(() => ({
  offline: false, loseReply: false, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", hubId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  records: new Map<string, CloudRecord>(), receipts: new Map<string, unknown>(), requests: [] as Mutation[]
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => {
  const user = () => ({ id: remote.userId, email: "user@example.test" });
  return {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: { user: user() } }, error: null }),
      stopAutoRefresh() {}, signOut: async () => ({ error: null }),
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
beforeEach(() => { remote.offline = false; remote.loseReply = false; remote.records.clear(); remote.receipts.clear(); remote.requests = []; });
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function machine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cloud-service-")); dirs.push(dir);
  const hubDir = path.join(dir, "hub");
  const bag = await fresh({ hubDir, plugins: [
    [Settings, { path: path.join(dir, "settings.json") }],
    [Storage, { watch: false, reconcileMs: 0, snapshotIdleMs: 60_000, snapshotMaxMs: 60_000 }]
  ] });
  contexts.push(bag.ctx);
  await bag.ctx.storage.ready;
  bag.ctx.settings.register({ id: "secret", title: "Secret", schema: z.object({ nested: z.object({ token: z.string().meta({ format: "password" }) }) }), defaults: { nested: { token: "" } }, scope: "user" });
  bag.ctx.settings.set({ ...bag.ctx.settings.get(), theme: "dark", secret: { nested: { token: "never-upload" } } });
  await bag.ctx.storage.writeHub();
  const legacy = fs.readFileSync(path.join(hubDir, "hub.json"), "utf8");
  await bag.ctx.plugin(CloudHub, {
    url: "https://example.supabase.co", publishableKey: "sb_publishable_test", cacheFile: path.join(dir, "hub-cloud.json"),
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, syncMs: 60_000
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
  expect(hub.catalog.project("elsewhere")).toBeNull();
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
