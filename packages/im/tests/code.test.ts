import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk, settle } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { definePlugin, type ImAdapter, type ImCapabilities, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";
import type { CodeSummary } from "../src/rich.js";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const CARDS: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0, cards: true, cardUpdate: true, markdown: "markdown" };

const EMPTY: CodeSummary = { links: [], session: null, proposals: [] };
const OPEN: CodeSummary = { links: [{ branch: "tom-1/login", prNumber: 12, prUrl: "https://github.com/o/r/pull/12", prState: "open", mergedSha: null }], session: { state: "running", blocked: null }, proposals: [] };
const MERGED: CodeSummary = { ...OPEN, links: [{ ...OPEN.links[0], prState: "merged", mergedSha: "abcdef1234" }], session: null };

/** Code link as IM reads it: a summary per ticket, and proposals a person settles. */
class FakeCode extends Service {
  static provide = "codeLink";
  code: CodeSummary = EMPTY;
  resolved: [string, boolean][] = [];
  constructor(ctx: Context) { super(ctx, "codeLink"); }
  summary(_projectId: string, _itemId: string): CodeSummary { return this.code; }
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

const hello = (id = "m1", text = "go"): ImInbound => ({ kind: "message", eventId: id, messageId: id, text, activation: "dm",
  actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "chat" } });
const press = (id: string, token: string): ImInbound => ({ kind: "action", eventId: id, token, actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "chat" } });

const creates: Engine["turn"] = async (_input, io) => {
  await io.tools.execute("create_item", { title: "Fix the login page", status: "doing", priority: 3 });
  io.emit({ type: "text", text: "Filed it." });
  return { stop: "end" };
};

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-im-code-"));
  const delivered: ImDelivery[] = [];
  const ios = new Map<string, AdapterIO>();
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities: CARDS, async open(id, io) {
    ios.set(id, io);
    return { close: () => {}, deliver: async d => { delivered.push(structuredClone(d)); return { messageId: d.replaceMessageId ?? `m-${delivered.length}` }; } };
  } };
  const world = await fresh({ hubDir: dir, plugins: [[Settings, { path: path.join(dir, "settings.json") }],
    [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }], Tools, [Agent, { mediaDir: path.join(dir, "media") }],
    FakeCode, [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  await settle();
  await world.ctx.storage.ready;
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn: creates });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    routes: [{ id: "route", connectionId: "bot", tenantId: "team", conversationId: "chat", projectId: world.project.id, engine: "test", allowedActors: ["owner"] }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const code = world.ctx.get("codeLink") as unknown as FakeCode;
  return { ...world, delivered, code, receive: (e: ImInbound) => ios.get("bot")!.receive(e) };
}

/** Boots, files a ticket from IM and waits for its card: the conversation now watches that ticket. */
async function watching(code?: CodeSummary) {
  const w = await boot();
  if (code) w.code.code = code;
  await w.receive(hello());
  await expect.poll(() => w.delivered.some(d => d.content.elements?.some(e => e.type === "section")), { timeout: 5000 }).toBe(true);
  const item = w.ctx.items.list({ projectId: w.project.id })[0];
  return { ...w, item };
}

describe("code links in IM", () => {
  it("shows a ticket card's branch, pull request and session, with the pull request's page as a link", async () => {
    const w = await watching(OPEN);
    const card = w.delivered.find(d => d.content.elements?.some(e => e.type === "section"))!;
    expect(card.content.elements).toEqual([
      { type: "section", title: `Created · ${w.item.key} Fix the login page`, fields: [
        { label: "Status", value: "Doing" }, { label: "Priority", value: "High" },
        { label: "Branch", value: "tom-1/login" }, { label: "Pull request", value: "#12 · Open" }, { label: "Session", value: "Running" }
      ] },
      { type: "links", links: [{ label: "Pull request #12", url: "https://github.com/o/r/pull/12" },
        { label: "Open in Tomrade", url: `tomrade://item/${encodeURIComponent(w.project.id)}/${w.item.key}` }] }
    ]);
  });

  it("tells the conversation that saw a ticket when its pull request opens and when it merges", async () => {
    const w = await watching();
    w.code.set(w.project.id, OPEN);
    await expect.poll(() => w.delivered.find(d => d.content.text.includes("Pull request #12 opened")), { timeout: 5000 }).toBeDefined();
    w.code.set(w.project.id, MERGED);
    await expect.poll(() => w.delivered.find(d => d.content.text === "Merged"), { timeout: 5000 }).toBeDefined();
    const merged = w.delivered.find(d => d.content.text === "Merged")!;
    expect(merged.content.elements?.[0]).toMatchObject({ type: "section", title: `${w.item.key} Fix the login page` });
    // The same state again is not news.
    const count = w.delivered.length;
    w.code.set(w.project.id, MERGED);
    await new Promise(r => setTimeout(r, 200));
    expect(w.delivered.length).toBe(count);
  });

  it("says when a merge waits on the person", async () => {
    const w = await watching(OPEN);
    w.code.set(w.project.id, { ...OPEN, session: { state: "error", blocked: "merge" } });
    await expect.poll(() => w.delivered.find(d => d.content.text.includes("merge waits on you")), { timeout: 5000 }).toBeDefined();
  });

  it("settles git's status proposal from its buttons, as the desktop would", async () => {
    const w = await watching(MERGED);
    w.code.set(w.project.id, { ...MERGED, proposals: [{ id: "p1", kind: "propose", toStatus: "done", reason: "merged into main" }] });
    await expect.poll(() => w.delivered.find(d => d.content.actions?.length), { timeout: 5000 }).toBeDefined();
    const card = w.delivered.find(d => d.content.actions?.length)!;
    expect(card.content.text).toBe(`${w.item.key}: move it to Done?\nmerged into main`);
    expect(card.content.actions!.map(a => a.label)).toEqual(["Accept", "Not this time"]);
    await w.receive(press("a1", card.content.actions![0].token));
    await expect.poll(() => w.code.resolved).toEqual([["p1", true]]);
    await expect.poll(() => w.delivered.find(d => d.replaceMessageId && d.content.text.endsWith("Accepted")), { timeout: 5000 }).toBeDefined();
    // Its other button is spent with it.
    await w.receive(press("a2", card.content.actions![1].token));
    await expect.poll(() => w.delivered.some(d => d.content.text.includes("expired or isn't yours")), { timeout: 5000 }).toBe(true);
    expect(w.code.resolved).toEqual([["p1", true]]);
  });

  it("takes the buttons off a proposal settled on the desktop", async () => {
    const w = await watching(MERGED);
    w.code.set(w.project.id, { ...MERGED, proposals: [{ id: "p2", kind: "propose", toStatus: "done", reason: "merged into main" }] });
    await expect.poll(() => w.delivered.find(d => d.content.actions?.length), { timeout: 5000 }).toBeDefined();
    w.code.set(w.project.id, MERGED);
    await expect.poll(() => w.delivered.find(d => d.replaceMessageId && d.content.text.endsWith("Handled in Tomrade")), { timeout: 5000 }).toBeDefined();
  });
});
