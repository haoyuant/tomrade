import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, type ImAdapter, type ImCapabilities, type ImCommand, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const RICH: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0, select: true, nativeCommands: true };

const say = (id: string, text: string, group = false): ImInbound => ({
  kind: "message", eventId: id, messageId: id, text, activation: group ? "mention" : "dm",
  actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: group ? "room" : "chat" }
});
const act = (id: string, token: string): ImInbound => ({
  kind: "action", eventId: id, token, actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "chat" }
});

async function boot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-project-"));
  const delivered: ImDelivery[] = [];
  const registered: ImCommand[][] = [];
  const ios = new Map<string, AdapterIO>();
  const turn: Engine["turn"] = async (input, io) => {
    io.emit({ type: "text", text: `re:${input.input.kind === "text" ? input.input.text : ""}` });
    return { stop: "end" };
  };
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities: RICH, async open(id, io) {
    ios.set(id, io);
    return { close: () => {}, commands: async list => { registered.push(list); },
      deliver: async d => { delivered.push(structuredClone(d)); return { messageId: d.replaceMessageId ?? `m-${delivered.length}` }; } };
  } };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  const other = world.ctx.projects.create({ name: "Garden", keyPrefix: "GAR" });
  const route = { connectionId: "bot", tenantId: "team", projectId: world.project.id, engine: "test", allowedActors: ["owner"] };
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    routes: [{ ...route, id: "dm", kind: "dm", conversationId: "chat" }, { ...route, id: "group", kind: "group", conversationId: "room", allowGroups: true }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  const said = (match: RegExp) => expect.poll(() => delivered.some(d => match.test(d.content.text)), { timeout: 5000 }).toBe(true);
  const last = (match: RegExp) => delivered.findLast(d => match.test(d.content.text))!;
  const userTexts = (projectId: string) => world.ctx.agent.store.threads(projectId, "assistant")
    .flatMap(t => world.ctx.agent.thread(projectId, t.id).messages.filter(m => m.role === "user").map(m => (m.block as { text: string }).text));
  const dmProject = () => ImSettings.parse(world.ctx.settings.get().im).routes.find(r => r.id === "dm")!.projectId;
  return { ...world, other, delivered, registered, receive, said, last, userTexts, dmProject };
}

describe("IM /project", () => {
  it("switches a direct chat to another project by name, and back to the conversation it left", async () => {
    const w = await boot();
    await expect.poll(() => w.registered.at(-1)?.some(c => c.name === "project")).toBe(true);
    await w.receive(say("a", "hello"));
    await w.said(/^re:hello$/);
    const first = w.ctx.agent.store.threads(w.project.id, "assistant")[0]!;

    await w.receive(say("p", "/project garden"));
    await w.said(/^Now in project Garden, in a new conversation\.$/);
    expect(w.dmProject()).toBe(w.other.id);
    await w.receive(say("b", "in the garden"));
    await w.said(/^re:in the garden$/);
    expect(w.userTexts(w.other.id)).toEqual(["in the garden"]);

    await w.receive(say("s", "/status"));
    await w.said(/^Project: Garden\nNo task is running$/);

    await w.receive(say("p2", `/project ${w.project.name}`));
    await w.said(new RegExp(`^Now in project ${w.project.name}, continuing “${first.title || "Untitled"}”\\.$`));
    await w.receive(say("c", "back home"));
    await expect.poll(() => w.ctx.agent.thread(w.project.id, first.id).messages.filter(m => m.role === "user").map(m => (m.block as { text: string }).text)).toEqual(["hello", "back home"]);
  });

  it("lists the projects with a button each, and a press switches", async () => {
    const w = await boot();
    await w.receive(say("l", "/project"));
    await w.said(/^Project: .+\n- Garden\nReply \/project <name>/);
    const card = w.last(/^Project: /);
    expect(card.content.actions?.map(a => a.label)).toEqual(["Garden"]);
    await w.receive(act("press", card.content.actions![0]!.token));
    await w.said(/^Now in project Garden/);
    expect(w.dmProject()).toBe(w.other.id);
  });

  it("keeps a channel's project, and says where a direct chat that names another project is", async () => {
    const w = await boot();
    await w.receive(say("g", "/project garden", true));
    await w.said(/\/project works in a direct chat/);
    expect(ImSettings.parse(w.ctx.settings.get().im).routes.find(r => r.id === "group")!.projectId).toBe(w.project.id);

    await w.receive(say("x", "what is in the garden project?"));
    await w.said(/This chat is in project .+\. To work in Garden, send \/project Garden\./);
    await w.said(/^re:what is in the garden project\?$/);
    expect(w.dmProject()).toBe(w.project.id);

    await w.receive(say("y", "/project nowhere"));
    await w.said(/No project “nowhere”/);
  });
});
