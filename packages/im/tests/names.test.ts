import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, type ImAdapter, type ImAddress, type ImCapabilities } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const CAPS: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0 };

/** A connection with a group route; the platform names its channels from `names`, or not at all without `describe`. */
async function boot(opts: { describe?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-names-"));
  const ios = new Map<string, AdapterIO>();
  const names = new Map<string, string>([["dev", "#tomrade-work"], ["lobby", "#lobby"]]);
  const asked: string[] = [];
  let opened = 0;
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities: CAPS, async open(id, io) {
    ios.set(id, io);
    opened++;
    return { close: () => {}, deliver: async () => ({ messageId: `m-${Math.random()}` }),
      ...(opts.describe === false ? {} : { describe: async (a: ImAddress) => { asked.push(a.conversationId); return names.has(a.conversationId) ? { name: names.get(a.conversationId)! } : null; } }) };
  } };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], [Im, { pollMs: 10, retryMs: 10, sweepMs: 50 }]] });
  cleanups.push(async () => { await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  let writes = 0;
  world.ctx.on("settings/changed", () => { writes++; });
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    identities: [{ connectionId: "bot", tenantId: "@me", actorId: "owner", pairedAt: 1 }],
    routes: [{ id: "group-dev", connectionId: "bot", tenantId: "team", conversationId: "dev", projectId: world.project.id, allowedActors: ["owner"], allowGroups: true, allowDirectMessages: false }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const routes = () => ImSettings.parse(world.ctx.settings.get().im).routes;
  const io = () => ios.get("bot")!;
  /** The connection drops and comes back, as a new session. */
  const reconnect = async () => { const before = opened; io().status("error"); await expect.poll(() => opened).toBeGreaterThan(before); await expect.poll(() => world.ctx.im.views()[0]?.state).toBe("connected"); };
  return { ...world, names, asked, routes, io, reconnect, writes: () => writes };
}

describe("conversations by their names", () => {
  it("keeps the platform's name on a route, asked once a session, and writes settings only when it changed", async () => {
    const w = await boot();
    await expect.poll(() => w.routes()[0]?.label).toBe("#tomrade-work");
    await new Promise(r => setTimeout(r, 150));
    expect(w.asked).toEqual(["dev"]);
    const writes = w.writes();

    await w.reconnect();
    await expect.poll(() => w.asked).toEqual(["dev", "dev"]);
    await new Promise(r => setTimeout(r, 150));
    expect(w.writes()).toBe(writes);

    w.names.set("dev", "#tomrade-tickets");
    await w.reconnect();
    await expect.poll(() => w.routes()[0]?.label).toBe("#tomrade-tickets");
  });

  it("leaves the id when the adapter cannot name it", async () => {
    const w = await boot({ describe: false });
    await new Promise(r => setTimeout(r, 200));
    expect(w.routes()[0]?.label).toBeUndefined();
  });

  it("names a conversation an adapter's setup allows, and an ignored group message's", async () => {
    const w = await boot();
    expect(w.io().allow!({ actorId: "owner", address: { tenantId: "team", conversationId: "status" }, kind: "status", projectId: w.project.id, name: "#tomrade-status" })).toBe(true);
    await expect.poll(() => w.routes().find(r => r.conversationId === "status")?.label).toBe("#tomrade-status");
    await w.io().receive({ kind: "message", eventId: "e1", address: { tenantId: "team", conversationId: "lobby" }, actor: { id: "stranger", isBot: false }, messageId: "m1", text: "hi", activation: "mention" });
    await expect.poll(() => w.ctx.im.ignoredMessages()[0]?.conversationName).toBe("#lobby");
  });
});
