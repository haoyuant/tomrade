import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings, type SecretCipher } from "@tomradex/settings";
import { definePlugin, ImDeliveryError, type ImAdapter, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const keychain: SecretCipher = {
  available: () => true,
  encrypt: (value: string) => Buffer.from([...value].reverse().join("")),
  decrypt: (value: Buffer) => [...value.toString()].reverse().join("")
};

const dm = (id: string, text: string, actorId = "owner", conversationId = "dm-owner"): ImInbound => ({
  kind: "message", eventId: id, messageId: id, text, activation: "dm",
  actor: { id: actorId, name: `${actorId} name`, isBot: false }, address: { tenantId: "team", conversationId }
});
const group = (id: string, activation: "mention" | "reply" | "ambient", actorId = "owner"): ImInbound => ({
  kind: "message", eventId: id, messageId: id, text: "hi", activation,
  actor: { id: actorId, isBot: false }, address: { tenantId: "team", conversationId: "room" }
});

const turn: Engine["turn"] = async (input, io) => { io.emit({ type: "text", text: `reply:${input.input.kind === "text" ? input.input.text : ""}` }); return { stop: "end" }; };

async function boot(opts: { deliver?: (d: ImDelivery) => Promise<{ messageId: string }>; edit?: boolean; seed?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-settings-"));
  const file = path.join(dir, "settings.json");
  if (opts.seed) writeFileSync(file, JSON.stringify(opts.seed));
  const delivered: ImDelivery[] = [];
  const ios = new Map<string, AdapterIO>();
  const opened: Record<string, string>[] = [];
  const deliver = vi.fn(opts.deliver ?? (async (d: ImDelivery) => { delivered.push(structuredClone(d)); return { messageId: `m-${delivered.length}` }; }));
  const adapter: ImAdapter = {
    id: "test_im", title: "Fake IM",
    capabilities: { edit: !!opts.edit, stream: opts.edit ? "edit" : "none", buttons: false, inboundFiles: false, outboundFiles: false, maxTextLength: 2000, maxFileBytes: 0 },
    setup: {
      fields: [{ key: "appId", label: { en: "App ID", zh: "应用 ID" } }, { key: "appSecret", label: "App secret", secret: true }, { key: "region", label: "Region", optional: true }],
      steps: [{ en: "Create an app", zh: "创建应用" }], permissions: ["im:message"]
    },
    async open(id, io) {
      ios.set(id, io);
      opened.push(io.credentials);
      return { deliver, close: () => {}, identity: { id: "bot-1", name: "Tomrade Bot" } };
    }
  };
  const world = await fresh({ plugins: [Tools, [Settings, { path: file, cipher: keychain }], [Agent, { mediaDir: path.join(dir, "media") }], [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  const setIm = (im: unknown) => world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse(im) });
  const im = () => ImSettings.parse(world.ctx.settings.get().im);
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  return { ...world, file, delivered, deliver, ios, opened, setIm, im, receive, service: world.ctx.im };
}

describe("IM settings without JSON", () => {
  it("turns settings from before the shared choices into them, keeping only what a conversation changed", () => {
    const base = { connectionId: "bot", tenantId: "team", projectId: "p", allowedActors: ["owner"] };
    const old = { connections: [{ id: "bot", adapterId: "test_im" }], announcePresence: true, routes: [
      { ...base, id: "a", conversationId: "a", notify: { tickets: true, code: true, routines: false, attention: true } },
      { ...base, id: "b", conversationId: "b", notify: { tickets: false, code: true, routines: true, attention: true, presence: false } }
    ] };
    const im = ImSettings.parse(old);
    expect(im.notify).toEqual({ tickets: true, code: true, presence: true, routines: false, attention: true });
    expect(im.routes[0].notify).toBeUndefined();
    expect(im.routes[1].notify).toEqual({ tickets: false, routines: true, presence: false });
    expect(im).not.toHaveProperty("announcePresence");
    // Already in the new shape, a conversation's choice that matches the old default stays its own.
    expect(ImSettings.parse({ ...im, notify: { ...im.notify, tickets: false }, routes: [{ ...im.routes[0], notify: { tickets: true } }] }).routes[0].notify).toEqual({ tickets: true });
  });

  it("writes older IM settings back in the new shape when it starts", async () => {
    const w = await boot({ seed: { im: { connections: [{ id: "bot", adapterId: "test_im" }], announcePresence: true, routes: [] } } });
    const stored = JSON.parse(readFileSync(w.file, "utf8")).im;
    expect(stored).not.toHaveProperty("announcePresence");
    expect(stored.notify.presence).toBe(true);
  });

  it("waits for credentials, seals them, and shows who the bot signed in as", async () => {
    const w = await boot();
    w.setIm({ connections: [{ id: "bot", adapterId: "test_im" }] });
    await expect.poll(() => w.service.views()[0]).toMatchObject({ state: "unconfigured", missing: ["appId", "appSecret"] });
    expect(w.ios.has("bot")).toBe(false);
    expect(w.service.adapterViews()[0].setup).toMatchObject({ fields: [{ key: "appId", label: "App ID", secret: false }, { key: "appSecret", secret: true }, { key: "region", optional: true }], steps: ["Create an app"] });

    w.setIm({ connections: [{ id: "bot", adapterId: "test_im", credentials: { appId: "cli_a1", appSecret: "s3cret-value" } }] });
    await expect.poll(() => w.service.views()[0]).toMatchObject({ state: "connected", identity: { id: "bot-1", name: "Tomrade Bot" }, missing: [] });
    expect(w.opened.at(-1)).toEqual({ appId: "cli_a1", appSecret: "s3cret-value" });
    const text = readFileSync(w.file, "utf8");
    expect(text).not.toContain("s3cret-value");
    expect(text).not.toContain("cli_a1");
    expect(JSON.stringify(w.service.views())).not.toContain("s3cret-value");

    // New credentials reopen the connection with them.
    w.setIm({ connections: [{ id: "bot", adapterId: "test_im", credentials: { appId: "cli_a1", appSecret: "rotated" } }] });
    await expect.poll(() => w.opened.at(-1)?.appSecret).toBe("rotated");
  });

  it("pairs a person from a direct message, after the desktop confirms, and revokes them", async () => {
    const w = await boot();
    w.setIm({ connections: [{ id: "bot", adapterId: "test_im", credentials: { appId: "a", appSecret: "b" } }] });
    await expect.poll(() => w.ios.has("bot")).toBe(true);
    const { code } = w.service.pairStart("bot", w.project.id);
    expect(code).toMatch(/^\d{6}$/);

    await w.receive(dm("p0", "/pair 000000".replace("000000", code === "000000" ? "111111" : "000000")));
    await expect.poll(() => w.delivered.at(-1)?.content.text).toContain("wrong or has expired");
    await w.receive(dm("p1", `/pair ${code}`));
    expect(w.service.pairingViews()[0].claim).toMatchObject({ actorId: "owner", name: "owner name", conversationId: "dm-owner" });
    // Nothing is allowed until the desktop confirms.
    expect(w.im().routes).toEqual([]);
    expect(w.ctx.agent.store.threads(w.project.id)).toHaveLength(0);

    expect(w.service.pairConfirm("bot")).toBe(true);
    expect(w.im().identities).toMatchObject([{ connectionId: "bot", tenantId: "team", actorId: "owner", name: "owner name" }]);
    expect(w.im().routes).toMatchObject([{ conversationId: "dm-owner", projectId: w.project.id, allowedActors: ["owner"], allowDirectMessages: true }]);
    await expect.poll(() => w.delivered.at(-1)?.content.text).toContain("Paired with Tomrade");

    await w.receive(dm("m1", "hello"));
    await expect.poll(() => w.delivered.some(d => d.content.text === "reply:hello"), { timeout: 5000 }).toBe(true);

    w.service.revoke("bot", "team", "owner");
    expect(w.im().identities).toEqual([]);
    expect(w.im().routes).toEqual([]);
    await w.receive(dm("m2", "again"));
    expect(w.service.ignoredMessages()[0]).toMatchObject({ actorId: "owner", reason: "conversation" });
  });

  it("withdraws a pairing code after repeated wrong guesses", async () => {
    const w = await boot();
    w.setIm({ connections: [{ id: "bot", adapterId: "test_im", credentials: { appId: "a", appSecret: "b" } }] });
    await expect.poll(() => w.ios.has("bot")).toBe(true);
    const { code } = w.service.pairStart("bot", w.project.id);
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await w.receive(dm(`g${i}`, `/pair ${wrong}`, "stranger", "dm-stranger"));
    await w.receive(dm("late", `/pair ${code}`, "stranger", "dm-stranger"));
    expect(w.service.pairingViews()).toEqual([]);
  });

  it("lets an ignored person or group in with one click, without keeping message text", async () => {
    const w = await boot();
    w.setIm({ connections: [{ id: "bot", adapterId: "test_im", credentials: { appId: "a", appSecret: "b" } }],
      identities: [{ connectionId: "bot", tenantId: "team", actorId: "owner", pairedAt: 1 }],
      routes: [{ id: "dm", connectionId: "bot", tenantId: "team", conversationId: "dm-owner", projectId: w.project.id, engine: "test", allowedActors: ["owner"] }] });
    await expect.poll(() => w.ios.has("bot")).toBe(true);

    await w.receive({ ...group("g1", "mention"), text: "PRIVATE TEXT" });
    const [ignored] = w.service.ignoredMessages();
    expect(ignored).toMatchObject({ conversationId: "room", group: true, reason: "conversation" });
    expect(JSON.stringify(w.service.ignoredMessages())).not.toContain("PRIVATE");
    expect(w.service.allow({ ignoredId: ignored.id, scope: "group" })).toBe(true);
    expect(w.im().routes.find(r => r.conversationId === "room")).toMatchObject({ projectId: w.project.id, allowGroups: true, allowedActors: ["owner"] });
    expect(w.service.ignoredMessages()).toEqual([]);

    await w.receive(group("g2", "mention", "teammate"));
    const [stranger] = w.service.ignoredMessages();
    expect(stranger).toMatchObject({ actorId: "teammate", reason: "actor" });
    expect(w.service.allow({ ignoredId: stranger.id, scope: "person" })).toBe(true);
    expect(w.im().routes.find(r => r.conversationId === "room")!.allowedActors).toEqual(["owner", "teammate"]);
  });

  it("wakes in a group the way the route says", async () => {
    const w = await boot();
    const route = { id: "room", connectionId: "bot", tenantId: "team", conversationId: "room", projectId: w.project.id, engine: "test", allowedActors: ["owner"], allowGroups: true };
    w.setIm({ connections: [{ id: "bot", adapterId: "test_im", credentials: { appId: "a", appSecret: "b" } }], routes: [{ ...route, groupActivation: "mention" }] });
    await expect.poll(() => w.ios.has("bot")).toBe(true);
    expect((await w.receive(group("r1", "reply"))).receiptId).toMatch(/^ignored:/);
    expect(w.service.ignoredMessages()[0]).toMatchObject({ reason: "activation" });
    expect((await w.receive(group("a1", "ambient"))).receiptId).toMatch(/^ignored:/);
    expect((await w.receive(group("m1", "mention"))).receiptId).not.toMatch(/^ignored:/);

    w.setIm({ ...w.im(), routes: [{ ...route, groupActivation: "all" }] });
    expect((await w.receive(group("a2", "ambient"))).receiptId).not.toMatch(/^ignored:/);
  });

  it("sends only the answer when the route asks for final output", async () => {
    const w = await boot({ edit: true });
    w.ctx.agent.engine({ id: "chatty", title: "Chatty", author: "ai:test", available: async () => ({ ok: true }), turn: async (_input, io) => {
      for (const piece of ["par", "tial", " more"]) { io.delta(piece); await new Promise(r => setTimeout(r, 150)); }
      io.emit({ type: "text", text: "the answer" });
      return { stop: "end" };
    } });
    w.setIm({ connections: [{ id: "bot", adapterId: "test_im", credentials: { appId: "a", appSecret: "b" } }],
      routes: [{ id: "dm", connectionId: "bot", tenantId: "team", conversationId: "dm-owner", projectId: w.project.id, engine: "chatty", allowedActors: ["owner"], output: "final" }] });
    await expect.poll(() => w.ios.has("bot")).toBe(true);
    await w.receive(dm("q", "go"));
    await expect.poll(() => w.delivered.some(d => d.content.text === "the answer"), { timeout: 5000 }).toBe(true);
    expect(w.delivered.map(d => d.content.text)).toEqual(["the answer"]);
  });

  it("lists uncertain deliveries for a person to retry or discard", async () => {
    let fail = true;
    const sent: string[] = [];
    const w = await boot({ deliver: async d => {
      if (fail) throw new ImDeliveryError("timeout", "uncertain");
      sent.push(d.content.text);
      return { messageId: `m-${sent.length}` };
    } });
    w.setIm({ connections: [{ id: "bot", adapterId: "test_im", credentials: { appId: "a", appSecret: "b" } }],
      routes: [{ id: "dm", connectionId: "bot", tenantId: "team", conversationId: "dm-owner", projectId: w.project.id, engine: "test", allowedActors: ["owner"] }] });
    await expect.poll(() => w.ios.has("bot")).toBe(true);
    await w.receive(dm("a", "one"));
    await expect.poll(() => w.service.deliveries(), { timeout: 5000 }).toMatchObject([{ state: "uncertain", conversationId: "dm-owner", preview: "reply:one" }]);
    expect(w.service.views()[0].uncertain).toBe(1);
    fail = false;
    expect(w.service.retry(w.service.deliveries()[0].id)).toBe(true);
    await expect.poll(() => sent).toEqual(["reply:one"]);
    expect(w.service.deliveries()).toEqual([]);

    fail = true;
    await w.receive(dm("b", "two"));
    await expect.poll(() => w.service.deliveries().length, { timeout: 5000 }).toBe(1);
    expect(w.service.discard(w.service.deliveries()[0].id)).toBe(true);
    expect(w.service.deliveries()).toEqual([]);
  });
});
