import { expect, it, vi } from "vitest";
import { Context } from "cordis";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fresh, settle } from "@tomradex/testkit";
import { Storage } from "@tomradex/storage";
import Settings from "@tomradex/settings";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false }, app: { getPath: () => "/nonexistent/tomrade-machine" } }));
import hubCloud from "../src/hub-cloud.js";

it("boots the configured desktop adapter with the real Supabase client without credentials or network requests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cloud-boot-"));
  const originalFetch = globalThis.fetch;
  const network = vi.fn(() => Promise.reject(new Error("No network expected before sign-in")));
  globalThis.fetch = network;
  const bag = await fresh({ hubDir: path.join(dir, "hub"), plugins: [
    [Settings, { path: path.join(dir, "settings.json") }],
    [Storage, { watch: false, reconcileMs: 0 }]
  ] });
  try {
    await bag.ctx.plugin(hubCloud, { userData: dir, url: "https://example.supabase.co", publishableKey: "sb_publishable_test" });
    await settle();
    await bag.ctx.cloudHub.ready;
    expect(bag.hub.info().cloudEnabled).toBe(true);
    expect(bag.ctx.cloudHub.info()).toMatchObject({ user: null, offlineAccess: false });
    expect(network).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, "account.enc"))).toBe(false);
  } finally {
    await bag.ctx.fiber.dispose();
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("lets a new person work without an account while the server is unreachable, and remembers the choice", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cloud-local-"));
  const originalFetch = globalThis.fetch;
  const network = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
  globalThis.fetch = network;
  const start = async () => {
    const bag = await fresh({ hubDir: path.join(dir, "hub"), plugins: [
      [Settings, { path: path.join(dir, "settings.json") }],
      [Storage, { watch: false, reconcileMs: 0 }]
    ] });
    await bag.ctx.plugin(hubCloud, { userData: dir, url: "https://example.supabase.co", publishableKey: "sb_publishable_test" });
    await settle();
    await bag.ctx.cloudHub.ready;
    return bag;
  };
  let bag = await start();
  try {
    expect(bag.ctx.cloudHub.useLocally()).toMatchObject({ user: null, localOnly: true });
    const project = bag.projects.create({ name: "Offline", keyPrefix: "OF" });
    bag.items.create({ projectId: project.id, boardId: bag.boards.defaultFor(project.id).id, title: "Works offline", by: "human" });
    await bag.ctx.storage.writeHub();
    await bag.ctx.cloudHub.sync();
    expect(bag.ctx.cloudHub.info().pending).toBeGreaterThan(0);
    expect(network).not.toHaveBeenCalled();
    await bag.ctx.fiber.dispose();
    bag = await start();
    expect(bag.ctx.cloudHub.info()).toMatchObject({ user: null, localOnly: true });
    expect(network).not.toHaveBeenCalled();
  } finally {
    await bag.ctx.fiber.dispose();
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
