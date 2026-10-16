import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk, settle } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { definePlugin, type ImAdapter, type ImCapabilities, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const CARDS: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0, cards: true, cardUpdate: true, textInput: true, markdown: "markdown" };

const hello = (id = "m1", text = "go"): ImInbound => ({ kind: "message", eventId: id, messageId: id, text, activation: "dm",
  actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "chat" } });
const press = (id: string, token: string, actor = "owner", value?: string): ImInbound => ({ kind: "action", eventId: id, token, ...(value !== undefined ? { value } : {}),
  actor: { id: actor, isBot: false }, address: { tenantId: "team", conversationId: "chat" } });

const creates: Engine["turn"] = async (_input, io) => {
  await io.tools.execute("create_item", { title: "Write the launch note", status: "doing", priority: 3 });
  io.emit({ type: "text", text: "Filed it." });
  return { stop: "end" };
};

/** Boots IM without code link: a delivery card needs only the ticket. */
async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-im-delivery-"));
  const delivered: ImDelivery[] = [];
  const ios = new Map<string, AdapterIO>();
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities: CARDS, async open(id, io) {
    ios.set(id, io);
    return { close: () => {}, deliver: async d => { delivered.push(structuredClone(d)); return { messageId: d.replaceMessageId ?? `m-${delivered.length}` }; } };
  } };
  const world = await fresh({ hubDir: dir, plugins: [[Settings, { path: path.join(dir, "settings.json") }],
    [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }], Tools, [Agent, { mediaDir: path.join(dir, "media") }],
    [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  await settle();
  await world.ctx.storage.ready;
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn: creates });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    identities: [{ connectionId: "bot", tenantId: "team", actorId: "partner", name: "Pat", pairedAt: 1 }],
    routes: [{ id: "route", connectionId: "bot", tenantId: "team", conversationId: "chat", projectId: world.project.id, engine: "test", allowedActors: ["owner", "partner", "guest"] }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  // Files a ticket from IM and waits for its card: the conversation now watches that ticket.
  await receive(hello());
  await expect.poll(() => delivered.some(d => d.content.elements?.some(e => e.type === "section")), { timeout: 5000 }).toBe(true);
  const item = world.ctx.items.list({ projectId: world.project.id })[0];
  const submit = (report = "Drafted the note; it covers pricing and dates.") => world.ctx.items.submitDelivery(world.project.id, item.id, { report }, "ai:desktop");
  const card = async () => {
    await expect.poll(() => delivered.find(d => d.content.text.startsWith(`${item.key} is ready for your review`)), { timeout: 5000 }).toBeDefined();
    return delivered.filter(d => d.content.text.startsWith(`${item.key} is ready for your review`)).at(-1)!;
  };
  const reviews = () => world.ctx.items.get(world.project.id, item.id)!.evidence.reviews;
  return { ...world, delivered, receive, item, submit, card, reviews };
}

describe("delivery review in IM", () => {
  it("sends a submitted delivery to the conversation that saw the ticket, with its report and buttons", async () => {
    const w = await boot();
    w.submit();
    const card = await w.card();
    expect(card.content.text).toBe(`${w.item.key} is ready for your review\n\nDrafted the note; it covers pricing and dates.`);
    expect(card.content.elements?.[0]).toMatchObject({ type: "section", title: `${w.item.key} Write the launch note`, fields: [{ label: "Status", value: "Verifying" }, { label: "Priority", value: "High" }] });
    expect(card.content.actions!.map(a => a.label)).toEqual(["Accept", "Request changes"]);
  });

  it("accepts from the card as the desktop would, and spends its buttons", async () => {
    const w = await boot();
    w.submit();
    const card = await w.card();
    await w.receive(press("a1", card.content.actions![0].token));
    await expect.poll(() => w.ctx.items.get(w.project.id, w.item.id)!.status, { timeout: 5000 }).toBe("done");
    expect(w.reviews()).toMatchObject([{ decision: "accepted", reviewedBy: "human", comment: "Accepted in IM by owner" }]);
    await expect.poll(() => w.delivered.find(d => d.replaceMessageId && d.content.text.endsWith("Accepted by owner")), { timeout: 5000 }).toBeDefined();
    await w.receive(press("a2", card.content.actions![1].token));
    await expect.poll(() => w.delivered.some(d => d.content.text.includes("expired or isn't yours")), { timeout: 5000 }).toBe(true);
  });

  it("sends it back with what the person wrote", async () => {
    const w = await boot();
    w.submit();
    const card = await w.card();
    await w.receive(press("c1", card.content.actions![1].token));
    await expect.poll(() => w.delivered.find(d => d.content.elements?.some(e => e.type === "input")), { timeout: 5000 }).toBeDefined();
    const ask = w.delivered.find(d => d.content.elements?.some(e => e.type === "input"))!;
    expect(ask.content.text).toBe(`What should change in ${w.item.key}?`);
    const input = ask.content.elements!.find(e => e.type === "input")!;
    await w.receive(press("c2", (input as { token: string }).token, "owner", "Add the launch time zone"));
    await expect.poll(() => w.ctx.items.get(w.project.id, w.item.id)!.status, { timeout: 5000 }).toBe("doing");
    expect(w.reviews()).toMatchObject([{ decision: "changes-requested", comment: "Add the launch time zone\n\nRequested in IM by owner" }]);
    await expect.poll(() => w.delivered.find(d => d.replaceMessageId && d.content.text.endsWith("Sent back for changes by owner: Add the launch time zone")), { timeout: 5000 }).toBeDefined();
  });

  it("takes the buttons off a delivery reviewed on the desktop", async () => {
    const w = await boot();
    const item = w.submit();
    await w.card();
    w.ctx.items.reviewDelivery(w.project.id, w.item.id, { submissionId: item.evidence.submissions.at(-1)!.id, decision: "accepted", comment: "" }, item.version);
    await expect.poll(() => w.delivered.find(d => d.replaceMessageId && d.content.text === `${w.item.key} is ready for your review\nAccepted`), { timeout: 5000 }).toBeDefined();
  });

  it("lets a paired person review, and no one else", async () => {
    const w = await boot();
    w.submit();
    const card = await w.card();
    await w.receive(press("g1", card.content.actions![0].token, "guest"));
    await expect.poll(() => w.delivered.some(d => d.content.text.includes("expired or isn't yours")), { timeout: 5000 }).toBe(true);
    expect(w.reviews()).toEqual([]);
    await w.receive(press("p1", card.content.actions![0].token, "partner"));
    await expect.poll(() => w.reviews(), { timeout: 5000 }).toMatchObject([{ decision: "accepted", comment: "Accepted in IM by Pat (partner)" }]);
  });
});
