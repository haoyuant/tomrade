import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, type ImAdapter, type ImAddress, type ImCapabilities, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const GROUP: ImAddress = { tenantId: "team", conversationId: "dev" };

/** A connection with the owner paired in their direct chat, and a group nobody allowed yet; direct chats are a tenant of their own, as on Discord. */
async function boot(opts: { select?: boolean; projects?: number } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-ask-"));
  const log: ({ kind: "deliver"; d: ImDelivery } | { kind: "open"; address: ImAddress; title: string })[] = [];
  const ios = new Map<string, AdapterIO>();
  const turn: Engine["turn"] = async (_input, io) => { io.emit({ type: "text", text: "re" }); return { stop: "end" }; };
  const caps: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0, cardUpdate: true, topics: true, select: opts.select ?? true };
  let topics = 0;
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities: caps, async open(id, io) {
    ios.set(id, io);
    return { close: () => {},
      deliver: async d => { log.push({ kind: "deliver", d: structuredClone(d) }); return { messageId: d.replaceMessageId ?? `m-${log.length}` }; },
      topics: { open: async c => { log.push({ kind: "open", address: c.address, title: c.title }); return { topicId: `topic-${++topics}` }; }, update: async () => {} } };
  } };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  const others = Array.from({ length: (opts.projects ?? 1) - 1 }, (_, i) => world.ctx.projects.create({ name: `Other ${i + 1}` }));
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    identities: [{ connectionId: "bot", tenantId: "@me", actorId: "owner", name: "Owner", pairedAt: 1 }],
    routes: [{ id: "dm", connectionId: "bot", tenantId: "@me", conversationId: "chat", projectId: world.project.id, engine: "test", allowedActors: ["owner"] }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  let n = 0;
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  const mention = (actor = "owner") => receive({ kind: "message", eventId: `e${++n}`, address: GROUP, actor: { id: actor, isBot: false }, messageId: `u${n}`, text: "hi", activation: "mention" });
  const delivered = () => log.flatMap(l => l.kind === "deliver" && l.d.address.conversationId === GROUP.conversationId ? [l.d] : []);
  const card = () => delivered().at(-1)!;
  const press = (label: string, actor = "owner") => {
    const button = card().content.actions!.find(a => a.label === label)!;
    return receive({ kind: "action", eventId: `e${++n}`, address: GROUP, actor: { id: actor, isBot: false }, token: button.token });
  };
  const choose = (value: string) => {
    const select = card().content.elements!.find(e => e.type === "select") as { token: string };
    return receive({ kind: "action", eventId: `e${++n}`, address: GROUP, actor: { id: "owner", isBot: false }, token: select.token, value });
  };
  const route = () => world.ctx.settings.get().im && ImSettings.parse(world.ctx.settings.get().im).routes.find(r => r.conversationId === GROUP.conversationId);
  const io = () => ios.get("bot")!;
  return { ...world, log, delivered, card, mention, press, choose, route, others, receive, io };
}

describe("a paired person allows a group from the group itself", () => {
  it("answers the paired person's @mention with a card; a stranger is only listed as ignored", async () => {
    const w = await boot();
    await w.mention("stranger");
    await new Promise(r => setTimeout(r, 50));
    expect(w.delivered()).toEqual([]);
    expect(w.ctx.im.ignoredMessages()).toMatchObject([{ actorId: "stranger", conversationId: "dev", group: true, reason: "conversation" }]);

    await w.mention();
    await expect.poll(() => w.delivered().length).toBe(1);
    expect(w.card().content.text).toBe(`Use this channel with project ${w.project.name} as…`);
    expect(w.card().content.actions!.map(a => a.label)).toEqual(["Work (a thread per ticket)", "Status (news only)", "Chat (talk to the assistant)", "Not here"]);
    expect(w.card().content.elements).toBeUndefined();
    expect(w.ctx.im.ignoredMessages().map(r => r.actorId).sort()).toEqual(["owner", "stranger"]);

    await w.press("Work (a thread per ticket)", "stranger");
    expect(w.route()).toBeUndefined();
  });

  it.each([
    ["Work (a thread per ticket)", { ticketTopics: true, groupActivation: "reply", notify: { tickets: true, code: true } }, "This is now the work channel for"],
    ["Status (news only)", { ticketTopics: false, groupActivation: "mention", notify: { tickets: true, code: true, routines: true, presence: true } }, "This is now the status channel for"],
    ["Chat (talk to the assistant)", { ticketTopics: false, groupActivation: "reply", notify: { tickets: false, code: false, routines: false } }, "This is now a chat channel for"]
  ])("%s makes the route with its preset, says so in the channel, and works once", async (label, fields, said) => {
    const w = await boot();
    w.ctx.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Being worked", workType: "coding", status: "doing", by: "human" });
    await w.mention();
    await expect.poll(() => w.delivered().length).toBe(1);
    const asked = w.card();
    await w.press(label);
    await expect.poll(() => w.route()).toMatchObject({ kind: "group", projectId: w.project.id, allowGroups: true, allowedActors: ["owner"], output: "progress", ...fields });
    await expect.poll(() => w.delivered().find(d => d.content.text.startsWith(said))).toMatchObject({ replaceMessageId: "m-1" });
    expect(w.ctx.im.ignoredMessages()).toEqual([]);

    const before = JSON.stringify(w.route());
    const sent = w.log.length;
    await w.receive({ kind: "action", eventId: "again", address: GROUP, actor: { id: "owner", isBot: false }, token: asked.content.actions!.find(a => a.label === label)!.token });
    expect(JSON.stringify(w.route())).toBe(before);
    if (fields.ticketTopics) await expect.poll(() => w.log.some(l => l.kind === "open" && l.title.includes("Being worked"))).toBe(true);
    else {
      await new Promise(r => setTimeout(r, 100));
      expect(w.log.slice(sent).some(l => l.kind === "open")).toBe(false);
    }
  });

  it("with several projects, offers a select with the person's last-used project first", async () => {
    const w = await boot({ projects: 2 });
    await w.mention();
    await expect.poll(() => w.delivered().length).toBe(1);
    expect(w.card().content.text).toContain(w.project.name);
    expect(w.card().content.elements).toMatchObject([{ type: "select", options: expect.arrayContaining([{ label: w.others[0].name, value: w.others[0].id }]) }]);
    await w.choose(w.others[0].id);
    await expect.poll(() => w.card().content.text).toBe(`Use this channel with project ${w.others[0].name} as…`);
    expect(w.card().replaceMessageId).toBe("m-1");
    await w.press("Status (news only)");
    await expect.poll(() => w.route()?.projectId).toBe(w.others[0].id);
  });

  it("without a select, asks for the project with buttons first", async () => {
    const w = await boot({ projects: 2, select: false });
    await w.mention();
    await expect.poll(() => w.delivered().length).toBe(1);
    expect(w.card().content.text).toBe("Which project should this channel use?");
    await w.press(w.others[0].name);
    await expect.poll(() => w.card().content.text).toBe(`Use this channel with project ${w.others[0].name} as…`);
    await w.press("Chat (talk to the assistant)");
    await expect.poll(() => w.route()?.projectId).toBe(w.others[0].id);
  });

  it("Not here keeps it from asking there for a day, and the group stays listed as ignored", async () => {
    const w = await boot();
    await w.mention();
    await expect.poll(() => w.delivered().length).toBe(1);
    await w.press("Not here");
    await expect.poll(() => w.card().content.text).toMatch(/^OK, I won't ask here for 24 hours/);
    expect(w.route()).toBeUndefined();
    const sent = w.delivered().length;
    await w.mention();
    await new Promise(r => setTimeout(r, 50));
    expect(w.delivered().length).toBe(sent);
    expect(w.ctx.im.ignoredMessages()).toMatchObject([{ actorId: "owner", conversationId: "dev", reason: "conversation" }]);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60 * 1000);
    await w.mention();
    await expect.poll(() => w.delivered().length).toBe(sent + 1);
    expect(w.card().content.actions).toHaveLength(4);
  });

  it("lets an adapter's own setup allow a conversation with a preset, once, for the paired person only", async () => {
    const w = await boot({ projects: 2 });
    expect(w.io().projects!("stranger")).toEqual([]);
    expect(w.io().projects!("owner").map(p => p.id)).toEqual([w.project.id, w.others[0].id]);
    expect(w.io().allow!({ actorId: "stranger", address: GROUP, kind: "work", projectId: w.project.id })).toBe(false);
    expect(w.io().allow!({ actorId: "owner", address: GROUP, kind: "work", projectId: "nope" })).toBe(false);
    expect(w.route()).toBeUndefined();

    w.ctx.items.create({ projectId: w.others[0].id, boardId: w.ctx.boards.list(w.others[0].id)[0]!.id, title: "Being worked", workType: "coding", status: "doing", by: "human" });
    expect(w.io().allow!({ actorId: "owner", address: GROUP, kind: "work", projectId: w.others[0].id })).toBe(true);
    await expect.poll(() => w.route()).toMatchObject({ kind: "group", projectId: w.others[0].id, allowGroups: true, allowedActors: ["owner"], ticketTopics: true, groupActivation: "reply" });
    const top = () => w.delivered().filter(d => !d.address.topicId);
    await expect.poll(() => top().map(d => d.content.text)).toEqual([`This is now the work channel for ${w.others[0].name}: each ticket being worked gets a thread here.\nChange it any time in Tomrade's IM settings.`]);
    await expect.poll(() => w.log.some(l => l.kind === "open" && l.title.includes("Being worked"))).toBe(true);

    // Run again: the route as the person left it, and nothing said.
    const edited = { ...w.route()!, groupActivation: "all" as const };
    w.ctx.settings.set({ ...w.ctx.settings.get(), im: { ...ImSettings.parse(w.ctx.settings.get().im), routes: [...ImSettings.parse(w.ctx.settings.get().im).routes.filter(r => r.id !== edited.id), edited] } });
    expect(w.io().allow!({ actorId: "owner", address: GROUP, kind: "status", projectId: w.others[0].id })).toBe(true);
    await new Promise(r => setTimeout(r, 50));
    expect(w.route()).toMatchObject({ groupActivation: "all", ticketTopics: true });
    expect(top()).toHaveLength(1);
  });

  it("keeps a direct chat one whatever its switches let in: no topics are asked for there", async () => {
    const w = await boot();
    const im = ImSettings.parse(w.ctx.settings.get().im);
    // As pairing made it, with the group switch turned on afterwards.
    w.ctx.settings.set({ ...w.ctx.settings.get(), im: { ...im, routes: [{ ...im.routes[0]!, id: "dm-0123456789ab", allowGroups: true, ticketTopics: true }] } });
    expect(ImSettings.parse(w.ctx.settings.get().im).routes[0]!.kind).toBe("dm");
    const worked = (title: string) => {
      const item = w.ctx.items.create({ projectId: w.project.id, boardId: w.board.id, title, workType: "coding", status: "todo", by: "human" });
      w.ctx.items.update(w.project.id, item.id, { status: "doing" }, "human");
    };
    worked("Being worked");
    await new Promise(r => setTimeout(r, 200));
    expect(w.log.filter(l => l.kind === "open")).toEqual([]);
    await w.receive({ kind: "message", eventId: "d1", address: { tenantId: "@me", conversationId: "chat" }, actor: { id: "owner", isBot: false }, messageId: "d1", text: "hi", activation: "dm" });
    worked("Also worked");
    await new Promise(r => setTimeout(r, 200));
    expect(w.log.filter(l => l.kind === "open")).toEqual([]);
  });

  it("records what each conversation is where Tomrade makes its route, and reads it from the id of one made before", async () => {
    const w = await boot();
    const { code } = w.ctx.im.pairStart("bot", w.project.id);
    await w.receive({ kind: "message", eventId: "p1", address: { tenantId: "@me", conversationId: "ann-dm" }, actor: { id: "ann", isBot: false }, messageId: "p1", text: `/pair ${code}`, activation: "dm" });
    expect(w.ctx.im.pairConfirm("bot")).toBe(true);
    const routes = () => ImSettings.parse(w.ctx.settings.get().im).routes;
    expect(routes().find(r => r.conversationId === "ann-dm")).toMatchObject({ kind: "dm", allowGroups: false });
    await w.mention("stranger");
    await expect.poll(() => w.ctx.im.ignoredMessages().length).toBe(1);
    expect(w.ctx.im.allow({ ignoredId: w.ctx.im.ignoredMessages()[0]!.id, scope: "group", projectId: w.project.id })).toBe(true);
    expect(routes().find(r => r.conversationId === "dev")).toMatchObject({ kind: "group" });
    const parsed = ImSettings.parse({ connections: [{ id: "bot", adapterId: "x" }], routes: [
      { id: "dm-aaaaaaaaaaaa", connectionId: "bot", tenantId: "t", conversationId: "a", projectId: "p", allowedActors: ["u"] },
      { id: "group-bbbbbbbbbbbb", connectionId: "bot", tenantId: "t", conversationId: "b", projectId: "p", allowedActors: ["u"] },
      { id: "by-hand", connectionId: "bot", tenantId: "t", conversationId: "c", projectId: "p", allowedActors: ["u"] }] });
    expect(parsed.routes.map(r => r.kind)).toEqual(["dm", "group", undefined]);
  });
});
