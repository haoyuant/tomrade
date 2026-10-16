import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, resolveImCapabilities } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";
import { CAPABILITIES, openDiscord } from "../src/adapter.js";
import { FakeDiscord } from "../src/fake.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const OWNER = "501";
const DM = "20";
const GUILD = "77";
const CHANNEL = "30";
const THREAD = "31";

/** "ask" asks which targets (multi-select); "why" asks for free text; "slow" waits; anything else is echoed. */
const turn: Engine["turn"] = async (input, io) => {
  if (input.input.kind === "answer") { io.emit({ type: "text", text: `chose ${JSON.stringify(input.input.value)}` }); return { stop: "end" }; }
  const text = input.input.kind === "text" ? input.input.text : "";
  if (text === "ask") await io.tools.execute("ask_user", { question: "Which targets?", options: ["web", "cli"], multiple: true });
  else if (text === "pick") await io.tools.execute("ask_user", { question: "Ship it?", options: ["Yes", "No"] });
  else if (text === "why") await io.tools.execute("ask_user", { question: "Why?", freeText: true });
  else io.emit({ type: "text", text: `echo: ${text}${input.input.kind === "text" && input.input.attachments?.length ? ` +${input.input.attachments.length} file` : ""}` });
  return { stop: "end" };
};

async function boot(opts: { token?: string } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-discord-"));
  const discord = new FakeDiscord();
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), media: () => ({ input: ["image/png"], output: [] }), turn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) {
    await ctx.im.register({ id: "discord", title: "Discord", capabilities: CAPABILITIES, setup: { fields: [{ key: "botToken", label: "Bot token", secret: true }], steps: [] },
      open: (id, io) => openDiscord(id, io, { net: discord.net(), backoffMs: 10 }) });
  } }), { id: "tomrade/discord", namespace: "discord", origin: "extension" }));
  const route = { connectionId: "bot", projectId: world.project.id, engine: "test", allowedActors: [OWNER] };
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({
    connections: [{ id: "bot", adapterId: "discord", credentials: { botToken: opts.token ?? discord.token } }],
    routes: [{ ...route, id: "dm", tenantId: "@me", conversationId: DM }, { ...route, id: "channel", tenantId: GUILD, conversationId: CHANNEL, allowGroups: true }] }) });
  const posted = (channel: string) => [...discord.messages.values()].filter(m => m.channel === channel).map(m => m.body);
  const said = (channel: string, text: string | RegExp) => expect.poll(() => posted(channel).some(b => typeof text === "string" ? b.content === text : text.test(String(b.content))), { timeout: 10_000 }).toBe(true);
  const runs = () => world.ctx.agent.store.threads(world.project.id).flatMap(th => world.ctx.agent.store.runs(world.project.id, th.id));
  return { ...world, discord, posted, said, runs, im: world.ctx.im };
}

describe("Discord adapter against the IM layer", () => {
  it("connects, shows the bot, registers /tomrade, and holds a direct conversation", async () => {
    const w = await boot();
    await expect.poll(() => w.im.views()[0]).toMatchObject({ state: "connected", identity: { id: "900", name: "tomrade-bot" } });
    expect(resolveImCapabilities(CAPABILITIES)).toBeTruthy();
    await expect.poll(() => w.discord.where("PUT", /^\/applications\/800\/commands$/).length).toBe(1);
    const command = w.discord.where("PUT", /commands$/)[0]!.body as unknown as { name: string; options: { name: string }[] }[];
    expect(command[0]!.name).toBe("tomrade");
    expect(command[0]!.options.map(o => o.name)).toEqual(expect.arrayContaining(["new", "stop", "status", "help", "steer", "sessions", "switch", "engine", "model", "effort", "mode", "answer"]));

    const m = w.discord.message({ channel: DM, author: OWNER, content: "hello" });
    await w.said(DM, "echo: hello");
    // Received, then done; typing while it works.
    await expect.poll(() => w.discord.where("PUT", /reactions/).map(c => decodeURIComponent(c.path.split("/")[6]!))).toEqual(["👀", "✅"]);
    expect(w.discord.where("PUT", /reactions/)[0]!.path).toContain(`/messages/${m.id}/`);
    expect(w.discord.where("DELETE", new RegExp(`/messages/${m.id}/reactions/`)).length).toBe(1);
    expect(w.discord.where("POST", /\/typing$/).length).toBeGreaterThan(0);
  });

  it("answers an @mention in a channel by quoting it, and a thread inside that thread", async () => {
    const w = await boot();
    await expect.poll(() => w.im.views()[0]?.state).toBe("connected");
    w.discord.dispatch("GUILD_CREATE", { id: GUILD, channels: [{ id: CHANNEL, type: 0 }], threads: [{ id: THREAD, type: 11, parent_id: CHANNEL }] });
    const ignored = w.discord.message({ channel: CHANNEL, guild: GUILD, author: OWNER, content: "" });
    const asked = w.discord.message({ channel: CHANNEL, guild: GUILD, author: OWNER, content: "<@900> status of the launch", mentions: true });
    await w.said(CHANNEL, "echo: status of the launch");
    const reply = w.posted(CHANNEL).find(b => b.content === "echo: status of the launch")!;
    expect(reply.message_reference).toEqual({ message_id: asked.id, fail_if_not_exists: false });
    expect(w.runs()).toHaveLength(1);
    expect(ignored).toBeTruthy();

    w.discord.message({ channel: THREAD, guild: GUILD, author: OWNER, content: "<@900> in the thread", mentions: true });
    await w.said(THREAD, "echo: in the thread");
  });

  it("answers questions with buttons, selects and a form, acknowledged within three seconds", async () => {
    const w = await boot();
    await expect.poll(() => w.im.views()[0]?.state).toBe("connected");
    const press = async (o: { custom_id: string; component_type?: number; values?: string[]; type?: number; components?: unknown[] }) => {
      const i = w.discord.interaction({ type: o.type ?? 3, channel: DM, user: OWNER, data: { custom_id: o.custom_id, component_type: o.component_type ?? 2, ...(o.values ? { values: o.values } : {}), ...(o.components ? { components: o.components } : {}) } });
      const sent = Date.now();
      await expect.poll(() => w.discord.where("POST", new RegExp(`^/interactions/${i.id}/`)).length).toBe(1);
      const callback = w.discord.where("POST", new RegExp(`^/interactions/${i.id}/`))[0]!;
      expect(callback.at - sent).toBeLessThan(3000);
      return callback.body;
    };
    const row = (body: Record<string, unknown>) => (body.components as { components: { custom_id?: string; type: number }[] }[]).flatMap(r => r.components);

    w.discord.message({ channel: DM, author: OWNER, content: "pick" });
    await w.said(DM, "Ship it?");
    const yes = row(w.posted(DM).find(b => b.content === "Ship it?")!).find(c => c.type === 2)!;
    expect(await press({ custom_id: yes.custom_id! })).toEqual({ type: 6 });
    await w.said(DM, 'chose "Yes"');
    // The answered card loses its buttons.
    await expect.poll(() => row(w.posted(DM).find(b => b.content === "Question handled or expired") ?? { components: [{ components: [{ type: 2 }] }] })).toEqual([]);

    w.discord.message({ channel: DM, author: OWNER, content: "ask" });
    await w.said(DM, "Which targets?");
    const select = row(w.posted(DM).find(b => b.content === "Which targets?")!).find(c => c.type === 3) as unknown as { custom_id: string; max_values: number };
    expect(select.max_values).toBe(2);
    await press({ custom_id: select.custom_id, component_type: 3, values: ["web", "cli"] });
    await w.said(DM, 'chose ["web","cli"]');

    w.discord.message({ channel: DM, author: OWNER, content: "why" });
    await w.said(DM, "Why?");
    const form = row(w.posted(DM).find(b => b.content === "Why?")!).find(c => c.custom_id?.startsWith("i:"))!;
    expect(await press({ custom_id: form.custom_id! })).toMatchObject({ type: 9, data: { custom_id: form.custom_id } });
    await press({ type: 5, custom_id: form.custom_id!, components: [{ type: 1, components: [{ type: 4, custom_id: "answer", value: "it is late" }] }] });
    await w.said(DM, 'chose "it is late"');
   // Discord allows about five messages a channel every five seconds; three questions and their answers wait for it.
  }, 30_000);

  it("takes /tomrade commands, deferring within three seconds", async () => {
    const w = await boot();
    await expect.poll(() => w.im.views()[0]?.state).toBe("connected");
    const i = w.discord.interaction({ type: 2, channel: DM, user: OWNER, data: { name: "tomrade", options: [{ type: 1, name: "status" }] } });
    const sent = Date.now();
    await expect.poll(() => w.discord.where("POST", new RegExp(`^/interactions/${i.id}/`))[0]?.body).toEqual({ type: 5 });
    expect(w.discord.where("POST", new RegExp(`^/interactions/${i.id}/`))[0]!.at - sent).toBeLessThan(3000);
    await expect.poll(() => w.discord.where("PATCH", /@original$/)[0]?.body?.content).toBe("› /status");
    await w.said(DM, "No task is running");

    w.discord.interaction({ type: 2, channel: DM, user: OWNER, data: { name: "tomrade", options: [{ type: 1, name: "steer", options: [{ type: 3, name: "args", value: "say hi" }] }] } });
    await w.said(DM, "echo: say hi");
  });

  it("resumes after a drop, replaying what it missed exactly once, and survives a dead connection", async () => {
    const w = await boot();
    await expect.poll(() => w.im.views()[0]?.state).toBe("connected");
    w.discord.message({ channel: DM, author: OWNER, content: "one" });
    await w.said(DM, "echo: one");
    w.discord.drop();
    w.discord.message({ channel: DM, author: OWNER, content: "while away" });
    await w.said(DM, "echo: while away");
    expect(w.discord.sockets[1]!.url).toMatch(/^wss:\/\/resume\.discord\.gg\//);
    // Discord redelivers an event the client already had; it runs once.
    const again = w.discord.message({ channel: DM, author: OWNER, content: "twice", id: "4242" });
    w.discord.dispatch("MESSAGE_CREATE", again);
    await w.said(DM, "echo: twice");
    await new Promise(r => setTimeout(r, 200));
    expect(w.runs().length).toBe(3);

    // Heartbeats go unanswered: the client drops the zombie and resumes.
    w.discord.silent = true;
    await expect.poll(() => w.discord.sockets.length, { timeout: 3000 }).toBeGreaterThan(2);
    w.discord.silent = false;
    w.discord.message({ channel: DM, author: OWNER, content: "after" });
    await w.said(DM, "echo: after");
   }, 30_000);

  it("waits out a rate limit and posts once", async () => {
    const w = await boot();
    await expect.poll(() => w.im.views()[0]?.state).toBe("connected");
    w.discord.failNext(c => c.method === "POST" && c.path === `/channels/${DM}/messages`, 429, { retryAfter: 0.1 });
    w.discord.message({ channel: DM, author: OWNER, content: "limited" });
    await w.said(DM, "echo: limited");
    expect(w.posted(DM).filter(b => b.content === "echo: limited")).toHaveLength(1);
    expect(w.discord.where("POST", new RegExp(`^/channels/${DM}/messages$`)).length).toBeGreaterThanOrEqual(2);
  });

  it("downloads attachments it is sent", async () => {
    const w = await boot();
    await expect.poll(() => w.im.views()[0]?.state).toBe("connected");
    w.discord.message({ channel: DM, author: OWNER, content: "look", attachments: [{ id: "a1", filename: "shot.png", content_type: "image/png", size: "bytes of shot.png".length }] });
    await w.said(DM, "echo: look +1 file");
  });

  it("drops a waiting message its sender deletes", async () => {
    const w = await boot();
    await expect.poll(() => w.im.views()[0]?.state).toBe("connected");
    w.discord.message({ channel: DM, author: OWNER, content: "pick" });
    await w.said(DM, "Ship it?");
    const waiting = w.discord.message({ channel: DM, author: OWNER, content: "never mind" });
    await w.said(DM, /^Waiting \(1 in line\)/);
    w.discord.dispatch("MESSAGE_DELETE", { id: waiting.id, channel_id: DM });
    await w.said(DM, "Withdrawn; it won't run.");
  });

  it("says the token is wrong instead of retrying it forever", async () => {
    const w = await boot({ token: "wrong" });
    await expect.poll(() => w.im.views()[0]?.state).toBe("error");
  });
});
