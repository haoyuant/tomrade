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

type StartOpts = { mode: "run"; engine?: string; options?: Record<string, unknown>; permissionMode?: string; playbook?: string; allowBlocked?: boolean; source?: Record<string, string> };

/** Code link as a start from IM uses it: it opens the ticket's thread and sends the brief, or stops at a gate. */
class FakeCode extends Service {
  static provide = "codeLink";
  static inject = ["agent", "items"];
  starts: StartOpts[] = [];
  gate: { gate: string; message: string; blockers?: string[] } | null = null;
  constructor(ctx: Context) { super(ctx, "codeLink"); }
  summary() { return { links: [], session: null, proposals: [] }; }
  resolve() { return { state: "accepted" }; }
  startDefaults() { return { mode: "run", engine: "test", options: { model: "deep" }, permissionMode: "auto" }; }
  async start(projectId: string, itemId: string, opts: StartOpts) {
    this.starts.push(opts);
    if (this.gate && !(this.gate.gate === "blocked" && opts.allowBlocked)) return { ok: false, ...this.gate };
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
  const turn: Engine["turn"] = async (input, io) => {
    const text = input.input.kind === "text" ? input.input.text : "";
    turns.push({ text, options: { ...(input.options as Record<string, unknown>) }, ...(input.permissionMode ? { mode: input.permissionMode } : {}) });
    if (text === "offer") {
      const run = world.ctx.agent.activeRuns().find(r => r.thread.id === input.threadId)!;
      const item = world.ctx.items.getByKey(world.project.id, ticket)!;
      world.ctx.agent.setCard(run.run.id, { id: `start-${item.id}`, schema: "start", title: `${item.key} ${item.title}`, data: { itemId: item.id, key: item.key, title: item.title } });
    }
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
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn,
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
  return { ...world, delivered, turns, code, item, receive, said, bound };
}

const select = (els: ImElement[] | undefined, placeholder: string) => els?.find((e): e is Extract<ImElement, { type: "select" }> => e.type === "select" && e.placeholder === placeholder);

describe("starting a ticket from IM", () => {
  it("starts an offered ticket from its card with this computer's last choices, then follows its session here", async () => {
    const w = await boot();
    await w.receive(say("a", "offer"));
    await expect.poll(() => w.delivered.find(d => d.content.actions?.some(a => a.label === "Start")), { timeout: 5000 }).toBeDefined();
    const card = w.delivered.find(d => d.content.actions?.some(a => a.label === "Start"))!;
    expect(card.content.actions!.map(a => a.label)).toEqual(["Start", "Adjust settings"]);
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(0);
    await w.receive(act("go", card.content.actions![0].token));
    await w.said(/^Started .* with Test; its progress and questions come here\./);
    expect(w.code.starts).toEqual([{ mode: "run", engine: "test", options: { model: "deep" }, permissionMode: "auto",
      source: { connection: "bot", tenant: "team", conversation: "chat", actor: "owner" } }]);
    expect((await w.said(/^Started/)).content.text).toContain("⚠ Pushing is off for this repository");
    // The coding run's question comes here, and is answered here.
    const question = await w.said(/^Which page first\?$/);
    const input = question.content.elements!.find(e => e.type === "input") as { token: string };
    const thread = w.bound()!;
    expect(w.ctx.agent.store.thread(w.project.id, thread)?.itemId).toBe(w.item.id);
    await w.receive(act("ans", input.token, "the login form"));
    await expect.poll(() => w.ctx.agent.thread(w.project.id, thread).pending).toBeNull();
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
    const last = w.delivered.filter(d => d.replaceMessageId && d.content.text.includes("Permission mode: Ask first")).at(-1)!;
    // The card's earlier choices are spent with it.
    await w.receive(act("old", select(card.content.elements, "Model")!.token, "deep"));
    await w.said(/expired or isn't yours/);
    await w.receive(act("go", last.content.actions![0].token));
    await w.said(/^Started/);
    expect(w.code.starts.at(-1)).toMatchObject({ engine: "test", options: { model: "fast" }, permissionMode: "ask" });
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
    expect(gate.content.elements).toEqual([{ type: "links", links: [{ label: "Open in Tomrade", url: `tomrade://item/${encodeURIComponent(other.project.id)}/${other.item.key}` }] }]);
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
