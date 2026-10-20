import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, type ImAdapter, type ImAddress, type ImCapabilities, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";
import type { CodeSummary } from "../src/rich.js";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const CAPS: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0, cards: true, cardUpdate: true, topics: true };

/** Code link as IM reads it: a summary per ticket and proposals a person settles. */
class FakeCode extends Service {
  static provide = "codeLink";
  code: CodeSummary = { links: [], session: null, proposals: [] };
  resolved: [string, boolean][] = [];
  constructor(ctx: Context) { super(ctx, "codeLink"); }
  summary(): CodeSummary { return this.code; }
  resolve(projectId: string, proposalId: string, accept: boolean) {
    this.resolved.push([proposalId, accept]);
    this.code = { ...this.code, proposals: this.code.proposals.filter(p => p.id !== proposalId) };
    this.ctx.emit("codeLink/changed", projectId);
    return { state: accept ? "accepted" : "rejected" };
  }
  set(projectId: string, code: CodeSummary) {
    this.code = code;
    this.ctx.emit("codeLink/changed", projectId);
  }
}

const STATUS: ImAddress = { tenantId: "team", conversationId: "status" };
const WORK: ImAddress = { tenantId: "team", conversationId: "work" };
const DM: ImAddress = { tenantId: "team", conversationId: "chat" };

/** Three conversations allowed in settings, none of which anyone has written in yet. */
async function boot(opts: { presence?: Record<string, boolean>; shared?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-allowed-"));
  const log: ({ kind: "deliver"; d: ImDelivery } | { kind: "open"; address: ImAddress; title: string })[] = [];
  const ios = new Map<string, AdapterIO>();
  const turn: Engine["turn"] = async (input, io) => {
    io.emit({ type: "text", text: `re:${input.input.kind === "text" ? input.input.text.split("\n").at(-1) : ""}` });
    return { stop: "end" };
  };
  let topics = 0;
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities: CAPS, async open(id, io) {
    ios.set(id, io);
    return { close: () => {},
      deliver: async d => { log.push({ kind: "deliver", d: structuredClone(d) }); return { messageId: d.replaceMessageId ?? `m-${log.length}` }; },
      topics: { open: async c => { log.push({ kind: "open", address: c.address, title: c.title }); return { topicId: `topic-${++topics}` }; }, update: async () => {} } };
  } };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], FakeCode, [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  const route = { connectionId: "bot", tenantId: "team", projectId: world.project.id, engine: "test", allowedActors: ["owner"] };
  const group = (id: string, ticketTopics: boolean) => ({ ...route, id, conversationId: id, allowGroups: true, groupActivation: "all" as const, ticketTopics,
    ...(opts.presence?.[id] !== undefined ? { notify: { presence: opts.presence[id] } } : {}) });
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    ...(opts.shared ? { notify: { presence: true } } : {}),
    routes: [group("status", false), group("work", true), { ...route, id: "dm", conversationId: "chat" }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const item = world.ctx.items.create({ projectId: world.project.id, boardId: world.board.id, title: "Fix the login page", workType: "coding", status: "todo", by: "human" });
  const code = world.ctx.get("codeLink") as unknown as FakeCode;
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  const delivered = () => log.flatMap(l => l.kind === "deliver" ? [l.d] : []);
  const to = (where: ImAddress) => delivered().filter(d => d.address.conversationId === where.conversationId && (d.address.topicId ?? null) === (where.topicId ?? null)).map(d => d.content.text);
  const binding = (where: ImAddress) => world.ctx.im.store.bindings().find(b => b.address_json === JSON.stringify(where));
  return { ...world, log, delivered, to, binding, code, item, receive };
}

describe("conversations allowed in IM settings", () => {
  it("hear their project's news before anyone writes there, without an empty conversation on the desktop", async () => {
    const w = await boot();
    w.ctx.items.update(w.project.id, w.item.id, { status: "backlog" }, "human");
    await expect.poll(() => w.to(STATUS), { timeout: 5000 }).toContain(`${w.item.key}: Todo → Backlog`);
    await expect.poll(() => w.to(DM), { timeout: 5000 }).toContain(`${w.item.key}: Todo → Backlog`);
    expect(w.ctx.agent.store.threads(w.project.id)).toEqual([]);
    expect(w.binding(DM)).toMatchObject({ actor_id: "owner", grp: 0, thread_id: "" });
    expect(w.binding(STATUS)).toMatchObject({ grp: 1, thread_id: "" });
  });

  it("opens a ticket's topic in a group nobody wrote in, and a message there talks in it", async () => {
    const w = await boot();
    w.ctx.items.update(w.project.id, w.item.id, { status: "doing" }, "human");
    await expect.poll(() => w.to({ ...WORK, topicId: "topic-1" }).some(t => t.startsWith("This thread follows")), { timeout: 5000 }).toBe(true);
    expect(w.log.filter(l => l.kind === "open")).toEqual([{ kind: "open", address: WORK, title: `${w.item.key} · Doing · Fix the login page` }]);
    await w.receive({ kind: "message", eventId: "q", messageId: "q", text: "what is left?", activation: "mention", actor: { id: "owner", isBot: false }, address: { ...WORK, topicId: "topic-1" } });
    await expect.poll(() => w.to({ ...WORK, topicId: "topic-1" }), { timeout: 5000 }).toContain("re:what is left?");
    expect(w.ctx.agent.store.threads(w.project.id).map(t => t.title)).toEqual([`${w.item.key} Fix the login page`]);
  });

  it("gives the conversation its own Agent conversation once someone writes, in the same binding", async () => {
    const w = await boot();
    const before = w.binding(STATUS)!;
    await w.receive({ kind: "message", eventId: "hi", messageId: "hi", text: "hello", activation: "mention", actor: { id: "owner", isBot: false }, address: STATUS });
    await expect.poll(() => w.to(STATUS), { timeout: 5000 }).toContain("re:hello");
    const after = w.binding(STATUS)!;
    expect(after.id).toBe(before.id);
    expect(after.thread_id).not.toBe("");
    expect(w.ctx.agent.store.threads(w.project.id).map(t => t.id)).toEqual([after.thread_id]);
    expect(w.ctx.im.store.bindings()).toHaveLength(3);
  });

  it("takes a press on a card in a conversation nobody wrote in", async () => {
    const w = await boot();
    w.ctx.items.update(w.project.id, w.item.id, { status: "backlog" }, "human");
    await expect.poll(() => w.to(STATUS), { timeout: 5000 }).toContain(`${w.item.key}: Todo → Backlog`);
    // A conversation that saw the ticket hears its code: the direct chat is made to watch it.
    w.ctx.im.store.run("INSERT INTO plugin_im_watch (binding_id, project_id, item_id, seen_json, at) VALUES (?, ?, ?, ?, ?)",
      w.binding(DM)!.id, w.project.id, w.item.id, JSON.stringify({ pr: null, merged: false, blocked: false, proposals: [] }), Date.now());
    w.code.set(w.project.id, { links: [], session: null, proposals: [{ id: "p1", kind: "propose", toStatus: "done", reason: "merged into main" }] });
    await expect.poll(() => w.delivered().find(d => d.address.conversationId === "chat" && d.content.actions?.length), { timeout: 5000 }).toBeDefined();
    const card = w.delivered().find(d => d.address.conversationId === "chat" && d.content.actions?.length)!;
    await w.receive({ kind: "action", eventId: "yes", token: card.content.actions![0].token, actor: { id: "owner", isBot: false }, address: DM });
    await expect.poll(() => w.code.resolved).toEqual([["p1", true]]);
    await expect.poll(() => w.to(DM).some(t => t.endsWith("Accepted")), { timeout: 5000 }).toBe(true);
  });

  it("tells a group that Tomrade came online only when the group's own conversation asks, and direct chats as shared", async () => {
    const w = await boot({ shared: true, presence: { status: true } });
    await expect.poll(() => w.to(STATUS), { timeout: 5000 }).toContain("Tomrade is online on your computer.");
    await expect.poll(() => w.to(DM), { timeout: 5000 }).toContain("Tomrade is online on your computer.");
    expect(w.to(WORK)).toEqual([]);
  });
});
