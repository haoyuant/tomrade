import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk, useHome } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, type ImAdapter, type ImCapabilities, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const RICH: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0, select: true, textInput: true, cards: true, cardUpdate: true };
const REMOTE = "https://example.com/acme/app.git";

/** The repository's checkout on this machine, as repos keeps it: chosen from a folder, or cloned. */
class FakeRepos extends Service {
  static provide = "repos";
  calls: string[][] = [];
  placed: string | null = null;
  constructor(ctx: Context) { super(ctx, "repos"); }
  get(_projectId: string, id: string) { return id === "r1" ? { name: "app", defaultBranch: "main" } : null; }
  checkouts() { return this.placed ? [{ checkout: this.placed }] : []; }
  async selectCheckout(remote: string, dir: string) {
    this.calls.push(["select", remote, dir]);
    if (fs.existsSync(path.join(dir, ".git"))) { this.placed = dir; return { state: "ready", view: { checkout: dir } }; }
    return { state: "clone", parent: dir, dir: path.join(dir, "app") };
  }
  async cloneInto(remote: string, branch: string, parent: string) {
    this.calls.push(["clone", remote, branch, parent]);
    this.placed = path.join(parent, "app");
    return { checkout: this.placed };
  }
}

/** Code link stopping at the checkout gate until the repository has a checkout here. */
class FakeCode extends Service {
  static provide = "codeLink";
  static inject = ["agent", "items", "repos"];
  remote = REMOTE;
  starts: Record<string, unknown>[] = [];
  constructor(ctx: Context) { super(ctx, "codeLink"); }
  summary() { return { links: [], session: null, proposals: [] }; }
  resolve() { return { state: "accepted" }; }
  startDefaults() { return { engine: "test" }; }
  async start(projectId: string, itemId: string, opts: { engine?: string; source?: Record<string, string> }) {
    this.starts.push(opts);
    if (!(this.ctx.get("repos") as unknown as FakeRepos).placed) return { ok: false, gate: "checkout", message: "No checkout of app on this machine", remote: this.remote, repo: { id: "r1", name: "app" } };
    const item = this.ctx.items.get(projectId, itemId)!;
    const thread = this.ctx.agent.newThread(projectId, opts.engine, null, { surface: "assistant", itemId, title: `${item.key} ${item.title}` });
    const { runId } = this.ctx.agent.send(projectId, thread.id, { kind: "text", text: `Brief ${item.key}` }, { requestId: `start:${this.starts.length}`, source: opts.source! });
    return { ok: true, continued: false, threadId: thread.id, runId, engine: opts.engine ?? "test" };
  }
}

const say = (id: string, text: string): ImInbound => ({
  kind: "message", eventId: id, messageId: id, text, activation: "dm", actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "chat" }
});
const act = (id: string, token: string): ImInbound => ({ kind: "action", eventId: id, token, actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "chat" } });

async function boot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-checkout-"));
  const hubDir = path.join(dir, "hub");
  fs.mkdirSync(hubDir);
  // The assistant shows a folder under the home as ~/…; a temp folder on Windows sits under the real home.
  const restoreHome = useHome(path.join(dir, "home"));
  cleanups.push(async () => restoreHome());
  const delivered: ImDelivery[] = [];
  const ios = new Map<string, AdapterIO>();
  let world!: Awaited<ReturnType<typeof fresh>>;
  let ticket = "";
  // "start it" ends the way start_ticket does when the ticket's repository has no checkout here.
  const turn: Engine["turn"] = async (input, io) => {
    const text = input.input.kind === "text" ? input.input.text : "";
    if (text === "start it") {
      const run = world.ctx.agent.activeRuns().find(r => r.thread.id === input.threadId)!;
      const item = world.ctx.items.getByKey(world.project.id, ticket)!;
      world.ctx.agent.setCard(run.run.id, { id: `start-batch-${run.run.id}`, schema: "start-batch", title: item.key, data: {
        tickets: [{ itemId: item.id, key: item.key, title: item.title }], config: { engine: "test" },
        results: [{ itemId: item.id, key: item.key, title: item.title, ok: false, gate: "checkout", message: "No checkout of app on this machine", remote: code.remote, repo: { id: "r1", name: "app" } }] } });
    }
    io.emit({ type: "text", text: `re:${text}` });
    return { stop: "end" };
  };
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities: RICH, async open(id, io) {
    ios.set(id, io);
    return { close: () => {}, deliver: async d => { delivered.push(structuredClone(d)); return { messageId: d.replaceMessageId ?? `m-${delivered.length}` }; } };
  } };
  world = await fresh({ hubDir, plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], FakeRepos, FakeCode, [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    routes: [{ id: "dm", connectionId: "bot", tenantId: "team", conversationId: "chat", projectId: world.project.id, engine: "test", allowedActors: ["owner"] }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const item = world.ctx.items.create({ projectId: world.project.id, boardId: world.board.id, title: "Run it locally", workType: "coding", status: "todo", by: "human" });
  ticket = item.key;
  const code = world.ctx.get("codeLink") as unknown as FakeCode;
  const repos = world.ctx.get("repos") as unknown as FakeRepos;
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  const find = (match: RegExp) => delivered.filter(d => match.test(d.content.text)).at(-1);
  const said = async (match: RegExp) => { await expect.poll(() => find(match), { timeout: 5000 }).toBeDefined(); return find(match)!; };
  return { ...world, dir, hubDir, delivered, code, repos, item, receive, said };
}

describe("a ticket whose repository has no checkout here, started from IM", () => {
  it("offers to clone into Tomrade's own folder from the assistant's start, clones on a press, and starts the ticket", async () => {
    const w = await boot();
    await w.receive(say("a", "start it"));
    const offer = await w.said(new RegExp(`^${w.item.key} can't start yet: this computer has no usable checkout of app\\.\\nPick one, and the ticket starts right after\\.$`));
    const parent = path.join(w.hubDir, "repos");
    expect(offer.content.actions!.map(a => a.label)).toEqual([`Clone into ${parent}`]);
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(0);
    await w.receive(act("go", offer.content.actions![0].token));
    await w.said(/^Started .* with Test\./);
    expect(w.repos.calls).toEqual([["select", REMOTE, parent], ["clone", REMOTE, "main", parent]]);
    expect(fs.existsSync(parent)).toBe(true);
    // The offer says what was done in place, and takes no second press.
    expect((await w.said(/^Cloned app into /)).replaceMessageId).toBeDefined();
    await w.receive(act("twice", offer.content.actions![0].token));
    await w.said(/expired/);
    expect(w.code.starts.filter(s => s.engine === "test")).toHaveLength(1);
  });

  it("offers the repository's own folder when its source is one on this machine, and starts in it from /start", async () => {
    const w = await boot();
    const source = path.join(w.dir, "app");
    fs.mkdirSync(path.join(source, ".git"), { recursive: true });
    w.code.remote = source;
    await w.receive(say("s", `/start ${w.item.key}`));
    const card = await w.said(new RegExp(`^Start ${w.item.key}`));
    await w.receive(act("go", card.content.actions!.find(a => a.label === "Start")!.token));
    const offer = await w.said(/can't start yet/);
    // A local repository is that folder: there is nothing to clone it from.
    expect(offer.content.actions!.map(a => a.label)).toEqual([`Use ${source}`]);
    await w.receive(act("use", offer.content.actions![0].token));
    await w.said(/^Started .* with Test\./);
    expect(w.repos.calls).toEqual([["select", source, source]]);
    expect(w.repos.placed).toBe(source);
  });
});
