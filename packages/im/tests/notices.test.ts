import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, ImDeliveryError, type ImAdapter, type ImAddress, type ImCapabilities, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const CAPS: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0 };
const INSTALL = { label: { en: "Add the bot to a server", zh: "把机器人加到服务器" }, url: "https://example.com/install" };
const GROUP: ImAddress = { tenantId: "team", conversationId: "dev" };

/** A connection whose session offers an install link once it is up; `ready` holds the connect back. */
async function boot(opts: { refuse?: (d: ImDelivery) => boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-notices-"));
  const sent: ImDelivery[] = [];
  const ios = new Map<string, AdapterIO>();
  let up!: () => void;
  const ready = new Promise<void>(r => { up = r; });
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities: CAPS, async open(id, io) {
    ios.set(id, io);
    await ready;
    return { close: () => {}, links: [INSTALL],
      deliver: async d => {
        if (opts.refuse?.(d)) throw new ImDeliveryError("Missing Permissions", "permanent");
        sent.push(structuredClone(d));
        return { messageId: `m-${sent.length}` };
      } };
  } };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], [Im, { pollMs: 10, retryMs: 10, sweepMs: 50 }]] });
  cleanups.push(async () => { up(); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    identities: [{ connectionId: "bot", tenantId: "@me", actorId: "owner", pairedAt: 1 }],
    routes: [{ id: "dm", connectionId: "bot", tenantId: "@me", conversationId: "owner-dm", projectId: world.project.id, allowedActors: ["owner"] },
      { id: "dev", connectionId: "bot", tenantId: "team", conversationId: "dev", projectId: world.project.id, allowedActors: ["owner"], allowGroups: true }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const view = () => world.ctx.im.views()[0];
  const io = () => ios.get("bot")!;
  return { ...world, sent, view, io, up, to: (conversationId: string) => sent.filter(d => d.address.conversationId === conversationId).map(d => d.content.text) };
}

describe("what an adapter tells the person about its connection", () => {
  it("shows its links once connected, and in the pairing reply", async () => {
    const w = await boot();
    expect(w.view().links).toBeUndefined();
    w.up();
    await expect.poll(() => w.view().state).toBe("connected");
    expect(w.view().links).toEqual([{ label: "Add the bot to a server", url: "https://example.com/install" }]);

    const { code } = w.ctx.im.pairStart("bot", w.project.id);
    const pair: ImInbound = { kind: "message", eventId: "p1", messageId: "p1", text: `/pair ${code}`, activation: "dm", actor: { id: "ann", isBot: false }, address: { tenantId: "@me", conversationId: "ann-dm" } };
    await w.io().receive(pair);
    expect(w.ctx.im.pairConfirm("bot")).toBe(true);
    await expect.poll(() => w.to("ann-dm").at(-1)).toBe("Paired with Tomrade. Send a message to start.\nAdd the bot to a server: https://example.com/install");
  });

  it("says a notice once where it happened and on the connection, and again only after it was cleared", async () => {
    const w = await boot();
    w.up();
    await expect.poll(() => w.view().state).toBe("connected");
    const notice = { key: "perm:dev:Create Public Threads", text: { en: "I can't open threads here: Create Public Threads is missing.", zh: "缺少权限" }, address: GROUP, link: INSTALL };
    w.io().notice!(notice);
    w.io().notice!(notice);
    await expect.poll(() => w.to("dev")).toEqual(["I can't open threads here: Create Public Threads is missing.\nAdd the bot to a server: https://example.com/install"]);
    expect(w.view().notices).toMatchObject([{ key: notice.key, text: notice.text.en, link: { label: "Add the bot to a server", url: INSTALL.url } }]);

    w.io().clearNotice!(notice.key);
    expect(w.view().notices).toEqual([]);
    w.io().notice!(notice);
    await expect.poll(() => w.to("dev")).toHaveLength(2);
    expect(w.to("owner-dm")).toEqual([]);
  });

  it("tells the paired person's direct chat when it cannot be said where it happened", async () => {
    const w = await boot({ refuse: d => d.address.conversationId === "dev" });
    w.up();
    await expect.poll(() => w.view().state).toBe("connected");
    w.io().notice!({ key: "perm:dev:Send Messages", text: "I can't post in #dev: Send Messages is missing.", address: GROUP });
    await expect.poll(() => w.to("owner-dm")).toEqual(["I can't post in #dev: Send Messages is missing."]);
  });
});
