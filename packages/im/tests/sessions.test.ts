import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, type ImAdapter, type ImCapabilities, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const RICH: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0, select: true };

const say = (id: string, text: string, opts: { actor?: string; group?: boolean } = {}): ImInbound => ({
  kind: "message", eventId: id, messageId: id, text, activation: opts.group ? "mention" : "dm",
  actor: { id: opts.actor ?? "owner", isBot: false }, address: { tenantId: "team", conversationId: opts.group ? "room" : "chat" }
});
const act = (id: string, token: string, value?: string, actor = "owner", group = false): ImInbound => ({
  kind: "action", eventId: id, token, ...(value ? { value } : {}), actor: { id: actor, isBot: false }, address: { tenantId: "team", conversationId: group ? "room" : "chat" }
});

async function boot(capabilities: ImCapabilities = RICH) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-sessions-"));
  const delivered: ImDelivery[] = [];
  const ios = new Map<string, AdapterIO>();
  /** What each turn ran with. */
  const turns: { text: string; options: Record<string, unknown>; mode?: string }[] = [];
  let release: (() => void) | null = null;
  const turn: Engine["turn"] = async (input, io) => {
    const text = input.input.kind === "text" ? input.input.text : "";
    turns.push({ text, options: { ...(input.options as Record<string, unknown>) }, ...(input.permissionMode ? { mode: input.permissionMode } : {}) });
    if (text === "slow") await new Promise<void>(r => { release = r; });
    io.emit({ type: "text", text: `re:${text}` });
    return { stop: "end" };
  };
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities, async open(id, io) {
    ios.set(id, io);
    return { close: () => {}, deliver: async d => { delivered.push(structuredClone(d)); return { messageId: d.replaceMessageId ?? `m-${delivered.length}` }; } };
  } };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { release?.(); for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn,
    picks: () => [{ key: "model", title: "Model", choices: [{ value: "fast" }, { value: "deep", label: "Deep" }] }, { key: "effort", title: "Effort", choices: [{ value: "low" }, { value: "high" }] }],
    permissionModes: { default: "ask", choices: [{ value: "ask", label: "Ask first" }, { value: "auto", label: "Auto" }] } });
  world.ctx.agent.engine({ id: "other", title: "Other", author: "ai:test", available: async () => ({ ok: true }), turn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  const route = { connectionId: "bot", tenantId: "team", projectId: world.project.id, engine: "test", allowedActors: ["owner", "mate"] };
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    routes: [{ ...route, id: "dm", conversationId: "chat" }, { ...route, id: "group", conversationId: "room", allowGroups: true }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  const last = () => delivered.at(-1)!;
  const said = (match: RegExp) => expect.poll(() => delivered.some(d => match.test(d.content.text)), { timeout: 5000 }).toBe(true);
  const bound = (conversation = "chat") => world.ctx.im.store.bindings().find(b => JSON.parse(b.address_json).conversationId === conversation)!.thread_id;
  return { ...world, delivered, turns, receive, last, said, bound, release: () => release?.() };
}

describe("IM sessions and options", () => {
  it("continues a desktop conversation picked from /sessions, without replaying its history", async () => {
    const w = await boot();
    const desk = w.ctx.agent.newThread(w.project.id, "test", null, { title: "Launch plan" });
    w.ctx.agent.send(w.project.id, desk.id, { kind: "text", text: "from the desktop" });
    await expect.poll(() => w.ctx.agent.thread(w.project.id, desk.id).messages.some(m => m.role === "agent")).toBe(true);

    await w.receive(say("a", "hi"));
    await w.said(/^re:hi$/);
    await w.receive(say("s", "/sessions"));
    await w.said(/Launch plan · Test/);
    const list = w.last();
    expect(list.content.text).toMatch(/← here/);
    const select = list.content.elements!.find(e => e.type === "select")!;
    expect(select.type === "select" && select.options.map(o => o.value)).toEqual([desk.id]);
    await w.receive(act("pick", select.type === "select" ? select.token : "", desk.id));
    await w.said(/Continuing “Launch plan” here/);
    expect(w.bound()).toBe(desk.id);

    await w.receive(say("b", "from IM"));
    await expect.poll(() => w.ctx.agent.thread(w.project.id, desk.id).messages.filter(m => m.role === "user").map(m => (m.block as { text: string }).text)).toEqual(["from the desktop", "from IM"]);
    await w.said(/^re:from IM$/);
    expect(w.delivered.some(d => d.content.text === "re:from the desktop")).toBe(false);
  });

  it("changes model, effort and mode on the thread the desktop panel reads, from the next turn", async () => {
    const w = await boot();
    await w.receive(say("a", "slow"));
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(1);
    const thread = w.bound();
    await w.receive(say("m", "/model"));
    await w.said(/^Model: default\n- fast\n- Deep \(deep\)/);
    await w.receive(say("m2", "/model Deep"));
    await w.said(/^Model: deep\. It applies from the next turn\.$/);
    await w.receive(say("e", "/effort high"));
    await w.said(/^Effort: high\./);
    await w.receive(say("p", "/mode auto"));
    await w.said(/^Permission mode: Auto\./);
    await w.receive(say("bad", "/model huge"));
    await w.said(/No Model “huge”/);
    // The desktop panel reads the same thread fields.
    const summary = w.ctx.agent.store.thread(w.project.id, thread)!;
    expect(summary.options).toEqual({ model: "deep", effort: "high" });
    expect(summary.permissionMode).toBe("auto");

    w.release();
    await w.receive(say("b", "next"));
    await expect.poll(() => w.turns.map(t => t.text)).toEqual(["slow", "next"]);
    expect(w.turns[0].options).not.toHaveProperty("model");
    expect(w.turns[1].options).toMatchObject({ model: "deep", effort: "high" });
    expect(w.turns[1].mode).toBe("auto");

    await w.receive(say("d", "/model default"));
    await w.said(/^Model: default\.$/);
    expect(w.ctx.agent.store.thread(w.project.id, thread)!.options).toEqual({ effort: "high" });
  });

  it("switches the assistant only between turns", async () => {
    const w = await boot();
    await w.receive(say("a", "slow"));
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(1);
    await w.receive(say("e", "/engine other"));
    await w.said(/can't change while a turn runs/);
    w.release();
    await w.said(/^re:slow$/);
    await w.receive(say("e2", "/engine Other"));
    await w.said(/^Assistant: Other$/);
    expect(w.ctx.agent.store.thread(w.project.id, w.bound())!.engine).toBe("other");
  });

  it("asks the person who switches a group to confirm, and keeps others out", async () => {
    const w = await boot();
    const desk = w.ctx.agent.newThread(w.project.id, "test", null, { title: "Private notes" });
    await w.receive(say("g1", "hello", { group: true }));
    await w.said(/^re:hello$/);
    // Someone who isn't on the allow list never sees the list.
    const before = w.delivered.length;
    await w.receive(say("x", "/sessions", { group: true, actor: "stranger" }));
    await new Promise(r => setTimeout(r, 150));
    expect(w.delivered.length).toBe(before);

    await w.receive(say("s", "/sessions", { group: true }));
    await w.said(/Private notes/);
    const n = w.last().content.text.split("\n").findIndex(l => l.includes("Private notes")) + 1;
    await w.receive(say("sw", `/switch ${n}`, { group: true }));
    await w.said(/Everyone in this group will be able to read “Private notes”/);
    const ask = w.last();
    expect(ask.visibleTo).toBeUndefined();
    const confirm = ask.content.actions![0].token;
    expect(w.bound("room")).not.toBe(desk.id);
    // Another member can't confirm it for them.
    await w.receive(act("c0", confirm, undefined, "mate", true));
    await w.said(/isn't yours/);
    expect(w.bound("room")).not.toBe(desk.id);
    await w.receive(act("c1", confirm, undefined, "owner", true));
    await w.said(/Continuing “Private notes” here/);
    expect(w.bound("room")).toBe(desk.id);
  });

  it("confirms a group switch by text where the platform has no buttons", async () => {
    const w = await boot({ edit: false, buttons: false, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0 });
    const desk = w.ctx.agent.newThread(w.project.id, "test", null, { title: "Roadmap" });
    await w.receive(say("g1", "hello", { group: true }));
    await w.said(/^re:hello$/);
    await w.receive(say("s", "/sessions", { group: true }));
    await w.said(/Roadmap/);
    expect(w.last().content.elements).toBeUndefined();
    const n = w.last().content.text.split("\n").findIndex(l => l.includes("Roadmap")) + 1;
    await w.receive(say("sw", `/switch ${n}`, { group: true }));
    await w.said(new RegExp(`Reply /switch ${n} confirm`));
    await w.receive(say("ok", `/switch ${n} confirm`, { group: true }));
    await w.said(/Continuing “Roadmap” here/);
    expect(w.bound("room")).toBe(desk.id);
  });

  it("opens conversations in the route's permission mode", async () => {
    const w = await boot();
    const im = ImSettings.parse(w.ctx.settings.get().im);
    w.ctx.settings.set({ ...w.ctx.settings.get(), im: { ...im, routes: im.routes.map(r => r.id === "dm" ? { ...r, permissionMode: "auto" } : r) } });
    await w.receive(say("a", "hi"));
    await expect.poll(() => w.turns[0]?.mode).toBe("auto");
  });

  it("archives the conversation and starts a new one", async () => {
    const w = await boot();
    await w.receive(say("a", "hi"));
    await w.said(/^re:hi$/);
    const old = w.bound();
    await w.receive(say("ar", "/archive"));
    await w.said(/^Archived “.*”; new conversation started$/);
    expect(w.ctx.agent.store.thread(w.project.id, old)!.archived).toBe(true);
    expect(w.bound()).not.toBe(old);
    // Saying so goes out on the new conversation, as /new's does.
    await w.receive(say("n", "/new"));
    await w.said(/^New conversation started$/);
  });
});
