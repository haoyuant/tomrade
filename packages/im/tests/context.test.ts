import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, type ImAdapter, type ImContextMessage, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const people = { owner: { id: "owner", name: "Olive", isBot: false }, carol: { id: "carol", name: "Carol", isBot: false } };
const say = (id: string, text: string, opts: { as?: keyof typeof people; activation?: "mention" | "ambient"; replyTo?: string; context?: ImContextMessage[] } = {}): ImInbound => ({
  kind: "message", eventId: id, messageId: id, text, activation: opts.activation ?? "mention",
  actor: people[opts.as ?? "owner"], address: { tenantId: "team", conversationId: "room" },
  ...(opts.replyTo ? { replyTo: opts.replyTo } : {}), ...(opts.context ? { context: opts.context } : {})
});

const seen: string[] = [];
const turn: Engine["turn"] = async (input, io) => {
  const text = input.input.kind === "text" ? input.input.text : "";
  seen.push(text);
  io.emit({ type: "text", text: "ok" });
  return { stop: "end" };
};

async function boot(groupContext?: Record<string, unknown>) {
  seen.length = 0;
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-context-"));
  const delivered: ImDelivery[] = [];
  const ios = new Map<string, AdapterIO>();
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM",
    capabilities: { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0 },
    async open(id, io) { ios.set(id, io); return { close: () => {}, deliver: async d => { delivered.push(structuredClone(d)); return { messageId: d.replaceMessageId ?? `m-${delivered.length}` }; } }; } };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  const set = (gc?: Record<string, unknown>) => world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    routes: [{ id: "group", connectionId: "bot", tenantId: "team", conversationId: "room", projectId: world.project.id, engine: "test",
      allowedActors: ["owner"], allowGroups: true, groupActivation: "mention", ...(gc ? { groupContext: gc } : {}) }] }) });
  set(groupContext);
  await expect.poll(() => ios.has("bot")).toBe(true);
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  const kept = () => world.ctx.im.store.all<{ message_id: string }>("SELECT message_id FROM plugin_im_window ORDER BY seq").map(r => r.message_id);
  /** Waits until the Agent has taken `n` turns. */
  const turns = (n: number) => expect.poll(() => seen.length, { timeout: 5000 }).toBe(n);
  return { ...world, receive, kept, turns, set, delivered };
}

describe("IM group context", () => {
  it("shows the Agent the message an @mention replies to, with its author, and keeps no chatter when the window is off", async () => {
    const w = await boot();
    await w.receive(say("a1", "we should ship the beta on Friday", { as: "carol", activation: "ambient" }));
    await w.receive(say("m1", "is that realistic?", { replyTo: "a1",
      context: [{ role: "quoted", messageId: "a1", author: people.carol, text: "we should ship the beta on Friday" }] }));
    await w.turns(1);
    expect(seen[0]).toContain("Replying to Carol: we should ship the beta on Friday");
    expect(seen[0]).toMatch(/is that realistic\?$/);
    expect(seen[0]).not.toContain("Recent messages");
    expect(w.kept()).toEqual([]);
  });

  it("attaches the thread's first message from the adapter", async () => {
    const w = await boot();
    await w.receive(say("m1", "summarise this", { context: [{ role: "root", messageId: "r1", author: people.carol, text: "Release checklist for v1" }] }));
    await w.turns(1);
    expect(seen[0]).toContain("Thread started by Carol: Release checklist for v1");
  });

  it("in a windowed group, quotes the recent discussion once, oldest first, and leaves out what the Agent already read", async () => {
    const w = await boot({ enabled: true, messages: 2 });
    await w.receive(say("a1", "first idea", { as: "carol", activation: "ambient" }));
    await w.receive(say("a2", "second idea", { as: "carol", activation: "ambient" }));
    await w.receive(say("a3", "third idea", { as: "owner", activation: "ambient" }));
    await expect.poll(() => w.kept().length).toBe(2);
    await w.receive(say("m1", "which one?", { replyTo: "a2" }));
    await w.turns(1);
    // Kept two; a2 is the quoted one, found in the window without the adapter's help.
    expect(seen[0]).toContain("Replying to Carol: second idea");
    expect(seen[0]).toContain("Recent messages here (kept on this computer only):\n> - Olive: third idea");
    expect(seen[0]).not.toContain("first idea");

    await w.receive(say("a4", "fourth idea", { as: "carol", activation: "ambient" }));
    await w.receive(say("m2", "and now?"));
    await w.turns(2);
    expect(seen[1]).toContain("- Carol: fourth idea");
    expect(seen[1]).not.toContain("third idea");
    expect(seen[1]).not.toContain("which one?");
  });

  it("clears kept messages on request, and forgets them when the window is turned off", async () => {
    const w = await boot({ enabled: true });
    await w.receive(say("a1", "hello", { as: "carol", activation: "ambient" }));
    await expect.poll(() => w.kept()).toEqual(["a1"]);
    expect(w.ctx.im.clearContext("group")).toBe(1);
    expect(w.kept()).toEqual([]);
    await w.receive(say("a2", "again", { as: "carol", activation: "ambient" }));
    await expect.poll(() => w.kept()).toEqual(["a2"]);
    w.set();
    await expect.poll(() => w.kept()).toEqual([]);
    await w.receive(say("a3", "unseen", { as: "carol", activation: "ambient" }));
    expect(w.kept()).toEqual([]);
  });
});
