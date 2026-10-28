import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, type ImAdapter, type ImCapabilities, type ImDelivery, type ImElement, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const RICH: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0, select: true, textInput: true, cards: true, cardUpdate: true };

type StartOpts = { mode: "run"; engine?: string; options?: Record<string, unknown>; permissionMode?: string; playbook?: string; allowBlocked?: boolean; releaseBranch?: boolean; message?: string; source?: Record<string, string> };

/** Code link as a start from IM uses it: it opens the ticket's thread and sends the brief, or stops at a gate. */
class FakeCode extends Service {
  static provide = "codeLink";
  static inject = ["agent", "items"];
  starts: StartOpts[] = [];
  gate: { gate: string; message: string; blockers?: string[]; board?: { name: string }; cause?: { code: string; branch?: string; heldAt?: string; releasable?: boolean } } | null = null;
  /** While set, a start waits for it, as a real one waits on its worktree and engine. */
  hold: Promise<void> | null = null;
  constructor(ctx: Context) { super(ctx, "codeLink"); }
  summary() { return { links: [], session: null, proposals: [] }; }
  resolve() { return { state: "accepted" }; }
  startDefaults() { return { mode: "run", engine: "test", options: { model: "deep" }, permissionMode: "auto" }; }
  async start(projectId: string, itemId: string, opts: StartOpts) {
    this.starts.push(opts);
    if (this.hold) await this.hold;
    if (this.gate && !(this.gate.gate === "blocked" && opts.allowBlocked) && !(this.gate.cause?.releasable && opts.releaseBranch)) return { ok: false, ...this.gate };
    const item = this.ctx.items.get(projectId, itemId)!;
    const thread = this.ctx.agent.newThread(projectId, opts.engine, null, { surface: "assistant", itemId, title: `${item.key} ${item.title}` });
    const { runId } = this.ctx.agent.send(projectId, thread.id, { kind: "text", text: `Brief ${item.key}` }, { requestId: `start:${this.starts.length}`, source: opts.source! });
    return { ok: true, continued: false, threadId: thread.id, runId, engine: opts.engine ?? "test", warnings: ["Pushing is off for this repository"] };
  }
}

const say = (id: string, text: string, opts: { actor?: string; group?: boolean } = {}): ImInbound => ({
  kind: "message", eventId: id, messageId: id, text, activation: opts.group ? "mention" : "dm",
  actor: { id: opts.actor ?? "owner", isBot: false }, address: { tenantId: "team", conversationId: opts.group ? "room" : "chat" }
});
const act = (id: string, token: string, value?: string, opts: { actor?: string; group?: boolean } = {}): ImInbound => ({
  kind: "action", eventId: id, token, ...(value ? { value } : {}), actor: { id: opts.actor ?? "owner", isBot: false }, address: { tenantId: "team", conversationId: opts.group ? "room" : "chat" }
});

async function boot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-start-"));
  const delivered: ImDelivery[] = [];
  const ios = new Map<string, AdapterIO>();
  const turns: { text: string; options: Record<string, unknown>; mode?: string }[] = [];
  let world!: Awaited<ReturnType<typeof fresh>>;
  let ticket = "";
  /** While set, asking which engines can run waits for it, as probing real CLIs does. */
  const probe: { hold: Promise<void> | null } = { hold: null };
  const turn: Engine["turn"] = async (input, io) => {
    const text = input.input.kind === "text" ? input.input.text : "";
    turns.push({ text, options: { ...(input.options as Record<string, unknown>) }, ...(input.permissionMode ? { mode: input.permissionMode } : {}) });
    if (text === "offer" || text === "offer the merge") {
      const run = world.ctx.agent.activeRuns().find(r => r.thread.id === input.threadId)!;
      const item = world.ctx.items.getByKey(world.project.id, ticket)!;
      const task = text === "offer the merge" ? { task: "PR #9 conflicts with main: merge origin/main, resolve, test, push, merge" } : {};
      world.ctx.agent.setCard(run.run.id, { id: `start-${item.id}-${run.run.id}`, schema: "start", title: `${item.key} ${item.title}`, data: { itemId: item.id, key: item.key, title: item.title, ...task } });
    }
    if (text === "confirm" || text === "confirm two" || text === "pick") {
      const run = world.ctx.agent.activeRuns().find(r => r.thread.id === input.threadId)!;
      const item = world.ctx.items.getByKey(world.project.id, ticket)!;
      const other = text === "confirm two" ? world.ctx.items.create({ projectId: world.project.id, boardId: world.board.id, title: "Second", workType: "coding", status: "todo", by: "human" }) : null;
      const tickets = [item, ...(other ? [other] : [])].map(i => ({ itemId: i.id, key: i.key, title: i.title }));
      const data = text === "pick" ? { tickets, reason: "no agent" } : { tickets, task: "Do it", config: { engine: "test", options: { model: "fast" }, permissionMode: "auto" } };
      world.ctx.agent.setCard(run.run.id, { id: `start-batch-${run.run.id}`, schema: "start-batch", title: tickets.map(t => t.key).join(", "), data });
    }
    if (text === "wait" && probe.hold) await probe.hold;
    if (text === "ask") { await io.tools.execute("ask_user", { question: "Ship it?", options: ["Yes", "No"] }); return { stop: "end" }; }
    if (text.startsWith("Brief")) {
      await io.tools.execute("ask_user", { question: "Which page first?", freeText: true });
      return { stop: "end" };
    }
    io.emit({ type: "text", text: `re:${text}` });
    return { stop: "end" };
  };
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities: RICH, async open(id, io) {
    ios.set(id, io);
    return { close: () => {}, deliver: async d => { delivered.push(structuredClone(d)); return { messageId: d.replaceMessageId ?? `m-${delivered.length}` }; } };
  } };
  world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], FakeCode, [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => { if (probe.hold) await probe.hold; return { ok: true }; }, turn,
    picks: () => [{ key: "model", title: "Model", choices: [{ value: "fast" }, { value: "deep", label: "Deep" }] }],
    permissionModes: { default: "ask", choices: [{ value: "ask", label: "Ask first" }, { value: "auto", label: "Auto" }] } });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  const route = { connectionId: "bot", tenantId: "team", projectId: world.project.id, engine: "test", allowedActors: ["owner", "mate"] };
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    routes: [{ ...route, id: "dm", conversationId: "chat" }, { ...route, id: "group", conversationId: "room", allowGroups: true, groupActivation: "all" }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const item = world.ctx.items.create({ projectId: world.project.id, boardId: world.board.id, title: "Fix the login page", workType: "coding", status: "todo", by: "human" });
  ticket = item.key;
  const code = world.ctx.get("codeLink") as unknown as FakeCode;
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  const find = (match: RegExp) => delivered.filter(d => match.test(d.content.text)).at(-1);
  const said = async (match: RegExp) => { await expect.poll(() => find(match), { timeout: 5000 }).toBeDefined(); return find(match)!; };
  const bound = (conversation = "chat") => world.ctx.im.store.bindings().find(b => JSON.parse(b.address_json).conversationId === conversation)?.thread_id;
  /** Follow here, from the message that says the start went through. */
  const follow = async () => {
    const started = await said(/^Started .* with Test\./);
    await receive(act(`follow-${delivered.length}`, started.content.actions!.find(a => a.label === "Follow here")!.token));
    await said(/^Following .* here; its progress and questions come here\./);
  };
  return { ...world, delivered, turns, code, item, receive, said, bound, probe, follow };
}

const select = (els: ImElement[] | undefined, placeholder: string) => els?.find((e): e is Extract<ImElement, { type: "select" }> => e.type === "select" && e.placeholder === placeholder);

describe("starting a ticket from IM", () => {
  it("starts an offered ticket from its card with this computer's last choices, and follows its session here only when asked", async () => {
    const w = await boot();
    await w.receive(say("a", "offer"));
    await expect.poll(() => w.delivered.find(d => d.content.actions?.some(a => a.label === "Start")), { timeout: 5000 }).toBeDefined();
    const card = w.delivered.find(d => d.content.actions?.some(a => a.label === "Start"))!;
    expect(card.content.actions!.map(a => a.label)).toEqual(["Start", "Adjust settings"]);
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(0);
    const home = w.bound();
    await w.receive(act("go", card.content.actions![0].token));
    await w.said(/^Started .* with Test\./);
    expect(w.code.starts).toEqual([{ mode: "run", engine: "test", options: { model: "deep" }, permissionMode: "auto",
      source: { connection: "bot", tenant: "team", conversation: "chat", actor: "owner" } }]);
    expect((await w.said(/^Started/)).content.text).toContain("⚠ Pushing is off for this repository");
    // The card clicked says so in place, and a second click on it is let go.
    expect((await w.said(new RegExp(`^Started ${w.item.key} Fix the login page$`))).replaceMessageId).toBeDefined();
    await w.receive(act("twice", card.content.actions![0].token));
    // The conversation stays where it was until it asks to follow.
    expect(w.bound()).toBe(home);
    expect(w.delivered.some(d => /^Which page first\?$/.test(d.content.text))).toBe(false);
    await w.follow();
    // The coding run's question comes here, and is answered here.
    const question = await w.said(/^Which page first\?$/);
    const input = question.content.elements!.find(e => e.type === "input") as { token: string };
    const thread = w.bound()!;
    expect(w.ctx.agent.store.thread(w.project.id, thread)?.itemId).toBe(w.item.id);
    await w.receive(act("ans", input.token, "the login form"));
    await expect.poll(() => w.ctx.agent.thread(w.project.id, thread).pending).toBeNull();
    expect(w.code.starts).toHaveLength(1);
    expect(w.delivered.some(d => /expired or isn't yours|Cannot process/.test(d.content.text))).toBe(false);
  });

  it("asks on a start-batch card still waiting for the person, and starts with what the assistant settled", async () => {
    const w = await boot();
    await w.receive(say("a", "confirm"));
    const card = await w.said(new RegExp(`^Start ${w.item.key}\\?\\nFirst: Do it$`));
    // Buttons keep it a message of its own rather than part of the turn's reply.
    expect(card.content.actions!.map(a => a.label)).toEqual(["Start"]);
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(0);
    await w.receive(act("go", card.content.actions![0].token));
    await w.said(/^Started .* with Test\./);
    expect(w.code.starts).toEqual([{ mode: "run", engine: "test", options: { model: "fast" }, permissionMode: "auto", message: "Do it",
      source: { connection: "bot", tenant: "team", conversation: "chat", actor: "owner" } }]);
  });

  it("gives each ticket of a start-batch card its own Start, and Adjust when no agent was settled", async () => {
    const w = await boot();
    await w.receive(say("a", "confirm two"));
    const card = await w.said(/^Start .*, .*\?/);
    expect(card.content.actions!.map(a => a.label)).toEqual([`Start ${w.item.key}`, expect.stringMatching(/^Start /)]);
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(0);
    await w.receive(act("go", card.content.actions![1].token));
    await w.said(/^Started .* with Test\./);
    expect(w.code.starts).toHaveLength(1);
    await w.receive(act("go2", card.content.actions![0].token));
    await expect.poll(() => w.code.starts.length).toBe(2);

    const picking = await boot();
    await picking.receive(say("b", "pick"));
    const ask = await picking.said(new RegExp(`^Start ${picking.item.key}\\?`));
    expect(ask.content.actions!.map(a => a.label)).toEqual(["Adjust settings"]);
  });

  it("shows a card offered again in the same conversation, and starts from the newest", async () => {
    const w = await boot();
    const cards = () => w.delivered.filter(d => d.content.actions?.some(a => a.label === "Start"));
    await w.receive(say("a", "offer"));
    await expect.poll(() => cards().length, { timeout: 5000 }).toBe(1);
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(0);
    await w.receive(say("b", "offer"));
    await expect.poll(() => cards().length, { timeout: 5000 }).toBe(2);
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(0);
    await w.receive(act("go", cards()[1].content.actions![0].token));
    await w.said(/^Started .* with Test\./);
    expect(w.code.starts).toHaveLength(1);
  });

  it("says on the card what a start offered with a task does first, and hands the task to the session", async () => {
    const w = await boot();
    await w.receive(say("a", "offer the merge"));
    const card = await w.said(/^First: PR #9 conflicts with main: merge origin\/main, resolve, test, push, merge$/);
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(0);
    await w.receive(act("go", card.content.actions!.find(a => a.label === "Start")!.token));
    await w.said(/^Started .* with Test\./);
    expect(w.code.starts.at(-1)).toMatchObject({ message: "PR #9 conflicts with main: merge origin/main, resolve, test, push, merge" });

    // Adjusted first, the card shows the task too, and its Start still hands it on.
    const adjusted = await boot();
    await adjusted.receive(say("b", "offer the merge"));
    const offered = await adjusted.said(/^First: PR #9/);
    await expect.poll(() => adjusted.ctx.agent.activeRuns().length).toBe(0);
    await adjusted.receive(act("adjust", offered.content.actions!.find(a => a.label === "Adjust settings")!.token));
    const settings = await adjusted.said(/\nFirst: PR #9 conflicts with main/);
    await adjusted.receive(act("start", settings.content.actions!.find(a => a.label === "Start")!.token));
    await adjusted.said(/^Started .* with Test\./);
    expect(adjusted.code.starts.at(-1)).toMatchObject({ message: "PR #9 conflicts with main: merge origin/main, resolve, test, push, merge" });
  });

  it("starts and follows a ticket while a question waits here, leaving the question's card saying where it stays", async () => {
    const w = await boot();
    await w.receive(say("a", "ask"));
    const card = await w.said(/^Ship it\?$/);
    const id = `m-${w.delivered.indexOf(card) + 1}`;
    await w.receive(say("s", `/start ${w.item.key} engine=test`));
    await w.follow();
    await expect.poll(() => w.delivered.filter(d => d.replaceMessageId === id).at(-1)?.content).toEqual({ text: "Ship it?\n\nThis question stays in “ask”; /switch back to answer it." });
    await w.receive(act("old", card.content.actions![0].token));
    await w.said(/^This question stays in “ask”; \/switch back to answer it\.$/);
  });

  it("/start shows what will run, changes it in place from its selects, and starts on Start", async () => {
    const w = await boot();
    await w.receive(say("s", `/start ${w.item.key}`));
    const card = await w.said(new RegExp(`^Start ${w.item.key} Fix the login page`));
    expect(card.content.text).toContain("Agent: Test\nModel: Deep\nPermission mode: Auto");
    await w.receive(act("m", select(card.content.elements, "Model")!.token, "fast"));
    await expect.poll(() => w.delivered.find(d => d.replaceMessageId && d.content.text.includes("Model: fast")), { timeout: 5000 }).toBeDefined();
    const changed = w.delivered.find(d => d.replaceMessageId && d.content.text.includes("Model: fast"))!;
    await w.receive(act("p", select(changed.content.elements, "Permission mode")!.token, "ask"));
    await expect.poll(() => w.delivered.find(d => d.replaceMessageId && d.content.text.includes("Permission mode: Ask first")), { timeout: 5000 }).toBeDefined();
    // A select the card showed before its edits still works, over what the card says now.
    await w.receive(act("old", select(card.content.elements, "Model")!.token, "deep"));
    await expect.poll(() => w.delivered.find(d => d.replaceMessageId && d.content.text.includes("Model: Deep\nPermission mode: Ask first")), { timeout: 5000 }).toBeDefined();
    await w.receive(act("go", card.content.actions![0].token));
    await w.said(/^Started/);
    expect(w.code.starts.at(-1)).toMatchObject({ engine: "test", options: { model: "deep" }, permissionMode: "ask" });
    expect(w.delivered.some(d => /expired or isn't yours/.test(d.content.text))).toBe(false);
  });

  it("takes two selects changed before the card shows the first change", async () => {
    const w = await boot();
    await w.receive(say("s", `/start ${w.item.key}`));
    const card = await w.said(new RegExp(`^Start ${w.item.key} Fix the login page`));
    await w.receive(act("m", select(card.content.elements, "Model")!.token, "fast"));
    await w.receive(act("p", select(card.content.elements, "Permission mode")!.token, "ask"));
    await expect.poll(() => w.delivered.find(d => d.replaceMessageId && d.content.text.includes("Model: fast\nPermission mode: Ask first")), { timeout: 5000 }).toBeDefined();
    await w.receive(act("go", card.content.actions![0].token));
    await w.said(/^Started/);
    expect(w.code.starts).toMatchObject([{ options: { model: "fast" }, permissionMode: "ask" }]);
    expect(w.delivered.some(d => /expired or isn't yours/.test(d.content.text))).toBe(false);
  });

  it("says on the card at once that the start is under way, and starts once however often Start is clicked", async () => {
    const w = await boot();
    let release!: () => void;
    w.code.hold = new Promise(resolve => { release = resolve; });
    await w.receive(say("s", `/start ${w.item.key}`));
    const card = await w.said(new RegExp(`^Start ${w.item.key} Fix the login page`));
    const start = card.content.actions![0].token;
    await w.receive(act("go", start));
    const starting = await w.said(new RegExp(`^Starting ${w.item.key}…$`));
    expect(starting.replaceMessageId).toBeDefined();
    expect(starting.content.actions ?? []).toEqual([]);
    expect(starting.content.elements ?? []).toEqual([]);
    await w.receive(act("again", start));
    await w.receive(act("model", select(card.content.elements, "Model")!.token, "fast"));
    release();
    await w.said(/^Started .* with Test/);
    await w.said(new RegExp(`^Started ${w.item.key} Fix the login page$`));
    await w.receive(act("late", start));
    await expect.poll(() => w.ctx.im.store.all<{ state: string }>("SELECT state FROM plugin_im_inbox WHERE state = 'queued'").length).toBe(0);
    expect(w.code.starts).toHaveLength(1);
    expect(w.delivered.some(d => /expired or isn't yours|Cannot process/.test(d.content.text))).toBe(false);
  });

  it("shows the start under way as soon as Start is pressed, before anything slow runs, and keeps repeat presses to one start", async () => {
    const w = await boot();
    await w.receive(say("a", "offer"));
    await expect.poll(() => w.delivered.find(d => d.content.actions?.some(a => a.label === "Start")), { timeout: 5000 }).toBeDefined();
    const card = w.delivered.find(d => d.content.actions?.some(a => a.label === "Start"))!;
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(0);
    let release!: () => void;
    w.probe.hold = new Promise(resolve => { release = resolve; });
    const start = card.content.actions![0].token;
    await w.receive(act("go", start));
    await w.receive(act("again", start));
    const starting = await w.said(new RegExp(`^Starting ${w.item.key}…$`));
    expect(starting.replaceMessageId).toBeDefined();
    expect(starting.content.actions ?? []).toEqual([]);
    expect(w.code.starts).toHaveLength(0);
    expect(w.ctx.im.store.all("SELECT 1 FROM plugin_im_inbox WHERE json_extract(event_json, '$.token') = ?", start)).toHaveLength(1);
    w.probe.hold = null;
    release();
    await w.said(/^Started .* with Test/);
    expect(w.code.starts).toHaveLength(1);
    expect(w.delivered.some(d => /expired or isn't yours|Cannot process/.test(d.content.text))).toBe(false);
  });

  it("says on the card that nothing started when a press shown as under way is refused", async () => {
    const w = await boot();
    await w.receive(say("s", `/start ${w.item.key}`));
    const card = await w.said(new RegExp(`^Start ${w.item.key} Fix the login page`));
    let release!: () => void;
    w.probe.hold = new Promise(resolve => { release = resolve; });
    await w.receive(say("w", "wait"));
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(1);
    await w.receive(act("go", card.content.actions![0].token));
    await w.said(/Cannot process message: Stop the current turn/);
    expect((await w.said(new RegExp(`^${w.item.key} wasn't started$`))).replaceMessageId).toBeDefined();
    expect(w.code.starts).toHaveLength(0);
    w.probe.hold = null;
    release();
  });

  it("tells the conversation that started a ticket when its status moves, unless it turned that off", async () => {
    const w = await boot();
    await w.receive(say("go", `/start ${w.item.key} model=fast`));
    await w.said(/^Started .* with Test\./);
    w.ctx.items.update(w.project.id, w.item.id, { status: "doing" }, "human");
    // The group nobody wrote in hears it too: it was allowed.
    await expect.poll(() => w.delivered.filter(d => d.content.text === `${w.item.key}: Todo → Doing`).map(d => d.address.conversationId).sort(), { timeout: 5000 }).toEqual(["chat", "room"]);
    const im = w.ctx.settings.get().im as ImSettings;
    w.ctx.settings.set({ ...w.ctx.settings.get(), im: { ...im, routes: im.routes.map(r => ({ ...r, notify: { ...r.notify, tickets: false } })) } });
    w.ctx.items.update(w.project.id, w.item.id, { status: "verifying" }, "human");
    await new Promise(r => setTimeout(r, 200));
    expect(w.delivered.some(d => d.content.text.includes("→ Verifying"))).toBe(false);
  });

  it("tells every conversation of the project when any of its tickets moves, though it never saw the ticket", async () => {
    const w = await boot();
    await w.receive(say("hi", "hello"));
    await w.said(/^re:hello$/);
    expect(w.delivered.some(d => d.content.text.includes(w.item.key))).toBe(false);
    w.ctx.items.update(w.project.id, w.item.id, { title: "Fix the sign-in page" }, "human");
    w.ctx.items.update(w.project.id, w.item.id, { status: "verifying" }, "human");
    await expect.poll(() => w.delivered.filter(d => d.content.text === `${w.item.key}: Todo → Verifying`).map(d => d.address.conversationId).sort(), { timeout: 5000 }).toEqual(["chat", "room"]);
    expect(w.delivered.filter(d => d.content.text.startsWith(`${w.item.key}:`))).toHaveLength(2);
  });

  it("goes back to the conversation it left once the ticket is done and its session archived, and the next message goes there", async () => {
    const w = await boot();
    await w.receive(say("hi", "hello"));
    await w.said(/^re:hello$/);
    const home = w.bound()!;
    w.ctx.agent.store.touchThread(w.project.id, home, { title: "Planning" });
    await w.receive(say("go", `/start ${w.item.key} model=fast`));
    await w.follow();
    const question = await w.said(/^Which page first\?$/);
    const ticketThread = w.bound()!;
    expect(ticketThread).not.toBe(home);
    await w.receive(act("ans", (question.content.elements!.find(e => e.type === "input") as { token: string }).token, "login"));
    await expect.poll(() => w.ctx.agent.thread(w.project.id, ticketThread).pending).toBeNull();
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(0);
    // As code link puts a finished ticket's work away.
    w.ctx.items.update(w.project.id, w.item.id, { status: "done" }, "human");
    w.ctx.agent.archiveThread(w.project.id, ticketThread);
    await w.receive(say("after", "what next?"));
    await w.said(new RegExp(`^${w.item.key} is done; back to “Planning”\.$`));
    await w.said(/^re:what next\?$/);
    expect(w.bound()).toBe(home);
    expect(w.delivered.some(d => /archived|Cannot process/i.test(d.content.text))).toBe(false);
  });

  it("opens a new conversation when the one it left can't be continued either", async () => {
    const w = await boot();
    await w.receive(say("hi", "hello"));
    await w.said(/^re:hello$/);
    const home = w.bound()!;
    await w.receive(say("go", `/start ${w.item.key} model=fast`));
    await w.follow();
    const question = await w.said(/^Which page first\?$/);
    const ticketThread = w.bound()!;
    await w.receive(act("ans", (question.content.elements!.find(e => e.type === "input") as { token: string }).token, "login"));
    await expect.poll(() => w.ctx.agent.thread(w.project.id, ticketThread).pending).toBeNull();
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(0);
    w.ctx.agent.archiveThread(w.project.id, home);
    w.ctx.agent.archiveThread(w.project.id, ticketThread);
    await w.said(new RegExp(`^${w.item.key}'s session was archived; a new conversation started\.$`));
    const fresh = w.bound()!;
    expect([home, ticketThread]).not.toContain(fresh);
    await w.receive(say("after", "still here?"));
    await w.said(/^re:still here\?$/);
    expect(w.bound()).toBe(fresh);
  });

  it("starts at once from /start with settings named, and refuses a setting the agent doesn't have", async () => {
    const w = await boot();
    await w.receive(say("bad", `/start ${w.item.key} colour=red`));
    await w.said(/This start has no setting “colour”/);
    await w.receive(say("ok", `/start ${w.item.key} model=fast mode=ask`));
    await w.said(/^Started/);
    expect(w.code.starts).toMatchObject([{ engine: "test", options: { model: "fast" }, permissionMode: "ask" }]);
  });

  it("offers Start anyway for a ticket that waits on others, and says where to fix any other gate", async () => {
    const w = await boot();
    w.code.gate = { gate: "blocked", message: "waits", blockers: ["TOM-9"] };
    await w.receive(say("b", `/start ${w.item.key} model=fast`));
    const blocked = await w.said(/waits on TOM-9, still open\. Start it anyway\?/);
    await w.receive(act("any", blocked.content.actions![0].token));
    await w.said(/^Started/);
    expect(w.code.starts.at(-1)).toMatchObject({ allowBlocked: true, options: { model: "fast" } });

    const other = await boot();
    other.code.gate = { gate: "checkout", message: "No checkout of tomrade on this machine" };
    await other.receive(say("c", `/start ${other.item.key} model=fast`));
    const gate = await other.said(/^Couldn't start .*: No checkout of tomrade on this machine\. It's fixed on the desktop\.$/);
    expect(JSON.stringify(gate.content)).not.toContain("tomrade://");
  });

  it("says why there is no working folder, and never without the detail", async () => {
    const w = await boot();
    w.code.gate = { gate: "workdir", message: "Docs has no repository yet", board: { name: "Docs" }, cause: { code: "no-board-repo" } };
    await w.receive(say("a", `/start ${w.item.key} model=fast`));
    await w.said(/: the workstream “Docs” has no repository yet — link one under Repositories on the desktop\./);

    const held = await boot();
    held.code.gate = { gate: "workdir", message: "held", cause: { code: "branch-in-use", branch: "tom-1/x", heldAt: "/work/other" } };
    await held.receive(say("b", `/start ${held.item.key} model=fast`));
    await held.said(/: tom-1\/x is already checked out in another worktree \(\/work\/other\)/);
    expect((await held.said(/already checked out/)).content.actions).toBeUndefined();

    // Nothing there would be lost: the person frees the branch from here, and the start goes through.
    const free = await boot();
    free.code.gate = { gate: "workdir", message: "held", cause: { code: "branch-in-use", branch: "tom-1/x", heldAt: "/work/other", releasable: true } };
    await free.receive(say("d", `/start ${free.item.key} model=fast`));
    const offered = await free.said(/: tom-1\/x is checked out in another worktree \(\/work\/other\), with nothing uncommitted there\./);
    expect(offered.content.text).not.toContain("fixed on the desktop");
    expect(offered.content.actions!.map(a => a.label)).toEqual(["Free it and start"]);
    await free.receive(act("free", offered.content.actions![0].token));
    await free.said(/^Started .* with Test\./);
    expect(free.code.starts.at(-1)).toMatchObject({ releaseBranch: true });

    const other = await boot();
    other.code.gate = { gate: "workdir", message: "git worktree add failed: disk full" };
    await other.receive(say("c", `/start ${other.item.key} model=fast`));
    await other.said(/: no working folder \(git worktree add failed: disk full\)\./);
  });

  it("in a group, only the person the conversation is with starts, after seeing the group will see it", async () => {
    const w = await boot();
    await w.receive(say("hi", "hello", { group: true }));
    await w.said(/^re:hello$/);
    await w.receive(say("mate", `/start ${w.item.key} model=fast`, { actor: "mate", group: true }));
    await w.said(/Only the person this conversation is with can start work here/);
    await w.receive(say("own", `/start ${w.item.key} model=fast`, { group: true }));
    const confirm = await w.said(/Everyone in this group will see its progress and questions\./);
    expect(w.code.starts).toEqual([]);
    await w.receive(act("not-mine", confirm.content.actions![0].token, undefined, { actor: "mate", group: true }));
    await w.said(/expired or isn't yours/);
    await w.receive(act("go", confirm.content.actions![0].token, undefined, { group: true }));
    await w.said(/^Started/);
    expect(w.code.starts).toHaveLength(1);
  });
});
