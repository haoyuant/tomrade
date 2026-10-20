import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, ImDeliveryError, type ImAdapter, type ImAddress, type ImCapabilities, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";
import type { CodeSummary } from "../src/rich.js";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const TOPICS: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0, select: true, textInput: true, cards: true, cardUpdate: true, topics: true };
const OPEN: CodeSummary = { links: [{ branch: "tom-1/login", prNumber: 12, prUrl: "https://github.com/o/r/pull/12", prState: "open", mergedSha: null }], session: null, proposals: [] };

type StartOpts = { mode: "run"; engine?: string; source?: Record<string, string> };

/** Code link as IM reads it: a summary per ticket, proposals a person settles, and a start that opens the ticket's thread and asks a question. */
class FakeCode extends Service {
  static provide = "codeLink";
  static inject = ["agent", "items"];
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
  startDefaults() { return { engine: "test" }; }
  async start(projectId: string, itemId: string, opts: StartOpts) {
    const item = this.ctx.items.get(projectId, itemId)!;
    const thread = this.ctx.agent.newThread(projectId, opts.engine, null, { surface: "assistant", itemId, title: `${item.key} ${item.title}` });
    const { runId } = this.ctx.agent.send(projectId, thread.id, { kind: "text", text: `Brief ${item.key}` }, { requestId: `start:${itemId}`, source: opts.source! });
    return { ok: true, continued: false, threadId: thread.id, runId, engine: "test" };
  }
}

const ROOM: ImAddress = { tenantId: "team", conversationId: "room" };
const say = (id: string, text: string, address: ImAddress = ROOM): ImInbound => ({
  kind: "message", eventId: id, messageId: id, text, activation: "mention", actor: { id: "owner", isBot: false }, address
});
const act = (id: string, token: string, address: ImAddress = ROOM): ImInbound => ({ kind: "action", eventId: id, token, actor: { id: "owner", isBot: false }, address });

async function boot(opts: { topics?: boolean; open?: () => Promise<{ topicId: string }>; ticketTopics?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-topics-"));
  /** What the bot did, in order: messages and topic operations. */
  const log: ({ kind: "deliver"; d: ImDelivery } | { kind: "open"; address: ImAddress; title: string } | { kind: "update"; address: ImAddress; title: string; closed: boolean })[] = [];
  const ios = new Map<string, AdapterIO>();
  const turns: string[] = [];
  const turn: Engine["turn"] = async (input, io) => {
    const text = input.input.kind === "text" ? input.input.text : "";
    turns.push(text);
    if (text.startsWith("Brief")) { await io.tools.execute("ask_user", { question: "Which page first?", freeText: true }); return { stop: "end" }; }
    io.emit({ type: "text", text: `re:${text.split("\n").at(-1)}` });
    return { stop: "end" };
  };
  let topics = 0;
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities: opts.topics === false ? { ...TOPICS, topics: false } : TOPICS, async open(id, io) {
    ios.set(id, io);
    return { close: () => {},
      deliver: async d => { log.push({ kind: "deliver", d: structuredClone(d) }); return { messageId: d.replaceMessageId ?? `m-${log.length}` }; },
      topics: {
        open: async c => { log.push({ kind: "open", address: c.address, title: c.title }); return opts.open ? opts.open() : { topicId: `topic-${++topics}` }; },
        update: async c => { log.push({ kind: "update", address: c.address, title: c.title, closed: c.closed }); }
      } };
  } };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], FakeCode, [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    routes: [{ id: "group", connectionId: "bot", tenantId: "team", conversationId: "room", projectId: world.project.id, engine: "test", allowedActors: ["owner"],
      allowGroups: true, groupActivation: "all", ...(opts.ticketTopics === false ? { ticketTopics: false } : {}) }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const item = world.ctx.items.create({ projectId: world.project.id, boardId: world.board.id, title: "Fix the login page", workType: "coding", status: "todo", by: "human" });
  const code = world.ctx.get("codeLink") as unknown as FakeCode;
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  const delivered = () => log.flatMap(l => l.kind === "deliver" ? [l.d] : []);
  const said = async (match: RegExp, where?: string | null) => {
    const find = () => delivered().filter(d => match.test(d.content.text) && (where === undefined || (d.address.topicId ?? null) === where)).at(-1);
    await expect.poll(find, { timeout: 5000 }).toBeDefined();
    return find()!;
  };
  const move = (status: "backlog" | "todo" | "doing" | "verifying" | "done" | "cancelled", id = item.id) => world.ctx.items.update(world.project.id, id, { status }, "human");
  /** The group says something first, so the bot knows the conversation. */
  await receive(say("hi", "hello"));
  await said(/^re:hello$/, null);
  return { ...world, log, delivered, turns, code, item, receive, said, move };
}

describe("ticket topics in an IM group", () => {
  it("opens a topic once a ticket is worked, sends its news there, and closes it when the ticket is done", async () => {
    const w = await boot();
    w.move("doing");
    const card = await w.said(/^This thread follows /, "topic-1");
    expect(w.log.find(l => l.kind === "open")).toEqual({ kind: "open", address: ROOM, title: `${w.item.key} · Doing · Fix the login page` });
    expect(card.content.elements?.[0]).toMatchObject({ type: "section", title: `${w.item.key} Fix the login page` });
    // The move that opened it shows on the card, not as a line at the top level.
    expect(w.delivered().some(d => d.content.text.includes("→ Doing"))).toBe(false);

    w.code.set(w.project.id, OPEN);
    await w.said(/Pull request #12 opened/, "topic-1");
    w.move("verifying");
    await w.said(new RegExp(`^${w.item.key}: Doing → Verifying$`), "topic-1");
    await expect.poll(() => w.log.find(l => l.kind === "update" && l.title.includes("Verifying"))).toMatchObject({ address: { ...ROOM, topicId: "topic-1" }, closed: false });

    w.move("done");
    await expect.poll(() => w.log.find(l => l.kind === "update" && l.closed)).toMatchObject({ title: `${w.item.key} · Done · Fix the login page` });
    // Closed only after its last line went out.
    const line = w.log.findIndex(l => l.kind === "deliver" && l.d.content.text === `${w.item.key}: Verifying → Done`);
    expect(line).toBeGreaterThan(-1);
    expect(w.log.findIndex(l => l.kind === "update" && l.closed)).toBeGreaterThan(line);
    expect(w.delivered().filter(d => !d.address.topicId && d.content.text.includes(w.item.key))).toEqual([]);

    w.move("doing");
    await expect.poll(() => w.log.filter(l => l.kind === "update").at(-1)).toMatchObject({ closed: false, title: `${w.item.key} · Doing · Fix the login page` });
    expect(w.log.filter(l => l.kind === "open")).toHaveLength(1);
  });

  it("keeps a ticket that is not being worked to one line at the top level, and other tickets' moves out of a ticket's topic", async () => {
    const w = await boot();
    w.move("doing");
    await w.said(/^This thread follows /, "topic-1");
    const other = w.ctx.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Tidy the footer", workType: "coding", status: "backlog", by: "human" });
    w.move("todo", other.id);
    await w.said(new RegExp(`^${other.key}: Backlog → Todo$`), null);
    await new Promise(r => setTimeout(r, 200));
    expect(w.delivered().filter(d => d.content.text.startsWith(`${other.key}:`))).toHaveLength(1);
    expect(w.log.filter(l => l.kind === "open")).toHaveLength(1);
  });

  it("settles a proposal from its buttons in the topic", async () => {
    const w = await boot();
    w.move("doing");
    await w.said(/^This thread follows /, "topic-1");
    w.code.set(w.project.id, { ...OPEN, proposals: [{ id: "p1", kind: "propose", toStatus: "done", reason: "merged into main" }] });
    const card = await w.said(/move it to Done\?/, "topic-1");
    await w.receive(act("yes", card.content.actions![0].token, { ...ROOM, topicId: "topic-1" }));
    await expect.poll(() => w.code.resolved).toEqual([["p1", true]]);
    await w.said(/Accepted$/, "topic-1");
    expect(w.delivered().some(d => /expired|Cannot process/.test(d.content.text))).toBe(false);
  });

  it("sends a delivery waiting for review to the ticket's topic, and accepts it from there", async () => {
    const w = await boot();
    const note = w.ctx.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Write the launch note", workType: "general", status: "doing", by: "human" });
    w.ctx.items.submitDelivery(w.project.id, note.id, { report: "Drafted the note." }, "ai:desktop");
    const card = await w.said(new RegExp(`^${note.key} is ready for your review`), "topic-1");
    await w.receive(act("ok", card.content.actions!.find(a => a.label === "Accept")!.token, { ...ROOM, topicId: "topic-1" }));
    await expect.poll(() => w.ctx.items.get(w.project.id, note.id)!.status, { timeout: 5000 }).toBe("done");
    await w.said(/Accepted by owner$/, "topic-1");
    await expect.poll(() => w.log.find(l => l.kind === "update" && l.closed)).toBeDefined();
    expect(w.delivered().filter(d => !d.address.topicId && d.content.text.includes(note.key))).toEqual([]);
  });

  it("talks about the ticket in its topic, in a conversation of its own named after it", async () => {
    const w = await boot();
    const group = w.ctx.im.store.bindings().find(b => !JSON.parse(b.address_json).topicId)!;
    w.move("doing");
    await w.said(/^This thread follows /, "topic-1");
    await w.receive(say("q", "what is left?", { ...ROOM, topicId: "topic-1" }));
    await w.said(/^re:what is left\?$/, "topic-1");
    const topic = w.ctx.im.store.bindings().find(b => JSON.parse(b.address_json).topicId === "topic-1")!;
    expect(topic.thread_id).not.toBe(group.thread_id);
    expect(w.ctx.agent.store.thread(w.project.id, topic.thread_id)?.title).toBe(`${w.item.key} Fix the login page`);
    expect(w.turns.at(-1)).toContain(`This thread follows ${w.item.key} Fix the login page`);
    // The group's own conversation is where it was.
    expect(w.ctx.im.store.binding(group.id)!.thread_id).toBe(group.thread_id);
  });

  it("shows a session started from the group in the ticket's topic instead of offering to follow it", async () => {
    const w = await boot();
    await w.receive(say("go", `/start ${w.item.key}`));
    const card = await w.said(new RegExp(`^Start ${w.item.key}`), null);
    await w.receive(act("start", card.content.actions!.find(a => a.label === "Start")!.token));
    const started = await w.said(/^Started .* with Test\./, null);
    expect(started.content.text).toContain("Its progress and questions come to its thread.");
    expect(started.content.actions ?? []).toEqual([]);
    await w.said(/^This thread follows /, "topic-1");
    await w.said(/^Which page first\?$/, "topic-1");
    const topic = w.ctx.im.store.bindings().find(b => JSON.parse(b.address_json).topicId === "topic-1")!;
    expect(w.ctx.agent.store.thread(w.project.id, topic.thread_id)?.itemId).toBe(w.item.id);
  });

  it("sends the ticket's news to the group as before when the topic cannot be opened", async () => {
    const w = await boot({ open: async () => { throw new ImDeliveryError("no", "permanent"); } });
    w.move("doing");
    await w.said(new RegExp(`^${w.item.key}: Doing$`), null);
    w.move("verifying");
    await w.said(new RegExp(`^${w.item.key}: Doing → Verifying$`), null);
    expect(w.delivered().some(d => d.address.topicId)).toBe(false);
  });

  it("keeps everything at the top level where the platform opens no topics or the route turned them off", async () => {
    for (const opts of [{ topics: false }, { ticketTopics: false }]) {
      const w = await boot(opts);
      w.move("doing");
      await w.said(new RegExp(`^${w.item.key}: Todo → Doing$`), null);
      expect(w.log.some(l => l.kind === "open")).toBe(false);
    }
  });
});
