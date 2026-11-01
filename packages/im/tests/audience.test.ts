import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, type ImAdapter, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const dm = (id: string, text: string): ImInbound => ({ kind: "message", eventId: id, messageId: id, text, activation: "dm",
  actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "dm-owner" } });
const group = (id: string, text: string): ImInbound => ({ kind: "message", eventId: id, messageId: id, text, activation: "mention",
  actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "room" } });
const press = (id: string, token: string, conversationId: string): ImInbound => ({ kind: "action", eventId: id, token,
  actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId } });

/** "ask" turns wait on a permission request; others echo. */
const turn: Engine["turn"] = async (input, io) => {
  const text = input.input.kind === "text" ? input.input.text : "";
  if (text === "ask") {
    const answer = await io.requestPermission!("Run the deploy?", ["Allow", "Deny"]);
    io.emit({ type: "text", text: `permission:${answer}` });
  } else io.emit({ type: "text", text: `re:${text}` });
  return { stop: "end" };
};

async function boot(im: Record<string, unknown> = {}, route: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-audience-"));
  const delivered: ImDelivery[] = [];
  const ios = new Map<string, AdapterIO>();
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM",
    capabilities: { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0 },
    async open(id, io) { ios.set(id, io); return { close: () => {}, deliver: async d => { delivered.push(structuredClone(d)); return { messageId: d.replaceMessageId ?? `m-${delivered.length}` }; } }; } };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: "en" }], [Agent, { mediaDir: path.join(dir, "media") }], [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { if (!world.ctx.agent) return void rmSync(dir, { recursive: true, force: true }); for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  const base = { connectionId: "bot", tenantId: "team", projectId: world.project.id, engine: "test", allowedActors: ["owner"] };
  const set = (extra: Record<string, unknown> = im) => world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    identities: [{ connectionId: "bot", tenantId: "team", actorId: "owner", pairedAt: 1 }],
    routes: [{ ...base, id: "dm", conversationId: "dm-owner", ...route }, { ...base, id: "group", conversationId: "room", allowGroups: true }], ...extra }) });
  set();
  await expect.poll(() => ios.has("bot")).toBe(true);
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  const to = (conversation: string) => delivered.filter(d => d.address.conversationId === conversation).map(d => d.content.text);
  const binding = (conversation: string) => world.ctx.im.store.bindings().find(b => JSON.parse(b.address_json).conversationId === conversation)!;
  /** A turn started on the desktop, as the assistant panel sends it. */
  const desktop = async (threadId: string, text: string) => {
    const { runId } = world.ctx.agent.send(world.project.id, threadId, { kind: "text", text });
    await expect.poll(() => world.ctx.agent.store.runs(world.project.id, threadId).find(r => r.id === runId)?.status, { timeout: 5000 }).toBe("done");
    await new Promise(r => setTimeout(r, 150));
  };
  return { ...world, delivered, receive, to, binding, desktop, set, ios };
}

describe("who sees what in IM", () => {
  it("keeps desktop turns out of a group unless the desktop shares one, and shows them in a direct chat", async () => {
    const w = await boot();
    await w.receive(group("g1", "from the group"));
    await expect.poll(() => w.to("room"), { timeout: 5000 }).toContain("re:from the group");
    const room = w.binding("room");
    expect(w.ctx.im.threadBindings(w.project.id, room.thread_id)).toEqual([expect.objectContaining({ conversationId: "room", group: true, shareNext: false })]);

    await w.desktop(room.thread_id, "private desktop note");
    expect(w.to("room")).not.toContain("re:private desktop note");

    expect(w.ctx.im.shareNext(room.id, true)).toBe(true);
    await w.desktop(room.thread_id, "for everyone");
    await expect.poll(() => w.to("room"), { timeout: 5000 }).toContain("re:for everyone");
    // Sharing covers one turn.
    await w.desktop(room.thread_id, "back to private");
    expect(w.to("room")).not.toContain("re:back to private");
    expect(w.ctx.im.threadBindings(w.project.id, room.thread_id)[0].shareNext).toBe(false);

    await w.receive(dm("d1", "hello"));
    await expect.poll(() => w.to("dm-owner"), { timeout: 5000 }).toContain("re:hello");
    await w.desktop(w.binding("dm-owner").thread_id, "from my desk");
    await expect.poll(() => w.to("dm-owner"), { timeout: 5000 }).toContain("re:from my desk");
  });

  it("leaves desktop turns out of a direct chat when the route says so", async () => {
    const w = await boot({}, { desktopTurns: false });
    await w.receive(dm("d1", "hello"));
    await expect.poll(() => w.to("dm-owner"), { timeout: 5000 }).toContain("re:hello");
    await w.desktop(w.binding("dm-owner").thread_id, "from my desk");
    expect(w.to("dm-owner")).not.toContain("re:from my desk");
  });

  it("brings an approval to the person's direct chat while they are away, answerable there", async () => {
    const w = await boot();
    await w.receive(dm("d1", "hello"));
    await expect.poll(() => w.to("dm-owner"), { timeout: 5000 }).toContain("re:hello");
    // A conversation only the desktop knows asks for permission.
    const desk = w.ctx.agent.newThread(w.project.id, "test", null, { title: "Deploy" });
    w.ctx.agent.send(w.project.id, desk.id, { kind: "text", text: "ask" });
    await expect.poll(() => w.ctx.agent.thread(w.project.id, desk.id).pending?.kind).toBe("permission");

    expect(w.ctx.im.remind({ projectId: w.project.id, threadId: desk.id, kind: "permission", title: "Test needs your approval", body: "Run the deploy?" })).toBe(true);
    await expect.poll(() => w.delivered.find(d => d.content.text.startsWith("**Test needs your approval**")), { timeout: 5000 }).toBeDefined();
    const reminder = w.delivered.find(d => d.content.text.startsWith("**Test needs your approval**"))!;
    expect(reminder.address.conversationId).toBe("dm-owner");
    expect(reminder.content.text).toBe("**Test needs your approval**\nRun the deploy?\n\n" + w.ctx.agent.thread(w.project.id, desk.id).pending!.question.text);
    expect(reminder.content.actions?.map(a => [a.label, a.style])).toEqual([["Allow", "primary"], ["Deny", undefined]]);

    await w.receive(press("p1", reminder.content.actions![0].token, "dm-owner"));
    await expect.poll(() => w.ctx.agent.thread(w.project.id, desk.id).messages.some(m => m.block.type === "text" && m.block.text === "permission:Allow"), { timeout: 5000 }).toBe(true);
    await expect.poll(() => w.to("dm-owner")).toContain("Answered: Allow");
    // A second press finds it handled.
    await w.receive(press("p2", reminder.content.actions![1].token, "dm-owner"));
    await expect.poll(() => w.to("dm-owner").some(t => t.includes("already handled")), { timeout: 5000 }).toBe(true);
  });

  it("doesn't remind where the conversation already shows the question", async () => {
    const w = await boot();
    await w.receive(dm("d1", "ask"));
    await expect.poll(() => w.to("dm-owner").some(t => t.startsWith("Run the deploy?")), { timeout: 5000 }).toBe(true);
    const thread = w.binding("dm-owner").thread_id;
    expect(w.ctx.im.remind({ projectId: w.project.id, threadId: thread, kind: "permission", title: "Test needs your approval", body: "" })).toBe(false);
    // Waiting and finished notices stay on the desktop.
    expect(w.ctx.im.remind({ projectId: w.project.id, threadId: thread, kind: "waiting", title: "x", body: "" })).toBe(false);
  });

  it("doesn't bring reminders to a conversation that turned them off", async () => {
    const w = await boot({}, { notify: { attention: false } });
    await w.receive(dm("d1", "hello"));
    await expect.poll(() => w.to("dm-owner"), { timeout: 5000 }).toContain("re:hello");
    const desk = w.ctx.agent.newThread(w.project.id, "test", null, { title: "Deploy" });
    w.ctx.agent.send(w.project.id, desk.id, { kind: "text", text: "ask" });
    await expect.poll(() => w.ctx.agent.thread(w.project.id, desk.id).pending?.kind).toBe("permission");
    expect(w.ctx.im.remind({ projectId: w.project.id, threadId: desk.id, kind: "permission", title: "Test needs your approval", body: "" })).toBe(false);
  });

  it("announces in the paired person's direct chat, once, and never in a group they are in", async () => {
    const w = await boot();
    await w.receive(dm("d1", "hello"));
    await expect.poll(() => w.to("dm-owner"), { timeout: 5000 }).toContain("re:hello");
    await w.receive(group("g1", "hi all"));
    await expect.poll(() => w.to("room"), { timeout: 5000 }).toContain("re:hi all");
    const heardInGroup = w.delivered.filter(d => d.address.conversationId === "room").length;
    const notice = { key: "night-shift:s1", title: "Your night shift is done", body: "2 to review, 1 merged, 0 need you" };
    expect(w.ctx.im.announce(notice)).toBe(true);
    expect(w.ctx.im.announce(notice)).toBe(true);
    await expect.poll(() => w.delivered.filter(d => d.content.text.startsWith("**Your night shift is done**")).length, { timeout: 5000 }).toBe(1);
    const said = w.delivered.find(d => d.content.text.startsWith("**Your night shift is done**"))!;
    expect(said.address.conversationId).toBe("dm-owner");
    expect(said.content.text).toBe("**Your night shift is done**\n2 to review, 1 merged, 0 need you");
    expect(said.content.actions ?? []).toEqual([]);
    expect(w.delivered.filter(d => d.address.conversationId === "room")).toHaveLength(heardInGroup);
  });

  it("announces nothing to a chat that turned reminders off, or to nobody paired", async () => {
    const off = await boot({}, { notify: { attention: false } });
    await off.receive(dm("d1", "hello"));
    await expect.poll(() => off.to("dm-owner"), { timeout: 5000 }).toContain("re:hello");
    expect(off.ctx.im.announce({ key: "k", title: "t", body: "" })).toBe(false);
    const nobody = await boot({ identities: [] });
    expect(nobody.ctx.im.announce({ key: "k", title: "t", body: "" })).toBe(false);
  });

  it("follows what every conversation hears unless the conversation chose for itself", async () => {
    const w = await boot({ notify: { routines: true } }, { notify: { routines: false } });
    await w.receive(dm("d1", "hello"));
    await w.receive(group("g1", "hello"));
    await expect.poll(() => w.to("room"), { timeout: 5000 }).toContain("re:hello");
    w.ctx.emit("schedules/ran", w.project.id, { id: "r1", ok: true, itemIds: [], threadId: null, error: null }, "Weekly review");
    await expect.poll(() => w.to("room"), { timeout: 5000 }).toContain("Routine “Weekly review” ran");
    expect(w.to("dm-owner").some(t => t.startsWith("Routine"))).toBe(false);
  });

  it("says when a routine runs, only where the conversation asked for routines", async () => {
    const w = await boot({}, { notify: { routines: true } });
    await w.receive(dm("d1", "hello"));
    await w.receive(group("g1", "hello"));
    await expect.poll(() => w.to("room"), { timeout: 5000 }).toContain("re:hello");
    w.ctx.emit("schedules/ran", w.project.id, { id: "r1", ok: true, itemIds: [], threadId: "t1", error: null }, "Weekly review");
    w.ctx.emit("schedules/ran", w.project.id, { id: "r2", ok: false, itemIds: [], threadId: null, error: "No engine" }, "Standup");
    await expect.poll(() => w.to("dm-owner"), { timeout: 5000 }).toContain("Routine “Standup” failed: No engine");
    const ran = w.delivered.find(d => d.content.text.startsWith("Routine “Weekly review” ran"))!;
    expect(JSON.stringify(ran.content)).not.toContain("tomrade://");
    expect(w.to("room").some(t => t.startsWith("Routine"))).toBe(false);
  });

  it("says when it comes online in a conversation that asked to, and not in one that turned the older setting off", async () => {
    const reconnect = (w: Awaited<ReturnType<typeof boot>>, extra: Record<string, unknown>, presence: boolean) => {
      const routes = (im: ImSettings) => im.routes.map(r => r.id === "dm" ? { ...r, notify: { ...r.notify, presence } } : r);
      const im = w.ctx.settings.get().im as ImSettings;
      w.ctx.settings.set({ ...w.ctx.settings.get(), im: { ...im, ...extra, routes: routes(im), connections: [{ ...im.connections[0], enabled: false }] } });
      w.ctx.settings.set({ ...w.ctx.settings.get(), im: { ...im, ...extra, routes: routes(im) } });
    };
    const w = await boot();
    await w.receive(dm("d1", "hello"));
    await expect.poll(() => w.to("dm-owner"), { timeout: 5000 }).toContain("re:hello");
    reconnect(w, {}, true);
    await expect.poll(() => w.to("dm-owner"), { timeout: 5000 }).toContain("Tomrade is online on your computer.");

    const off = await boot();
    await off.receive(dm("d1", "hello"));
    await expect.poll(() => off.to("dm-owner"), { timeout: 5000 }).toContain("re:hello");
    reconnect(off, { announcePresence: true }, false);
    await new Promise(r => setTimeout(r, 300));
    expect(off.to("dm-owner").some(t => t.includes("online"))).toBe(false);
  });

  it("says when it comes online and goes offline, only when asked to", async () => {
    const w = await boot();
    await w.receive(dm("d1", "hello"));
    await expect.poll(() => w.to("dm-owner"), { timeout: 5000 }).toContain("re:hello");
    expect(w.to("dm-owner").some(t => t.includes("online"))).toBe(false);
    // Reconnecting with the setting on says hello once.
    w.set({ notify: { presence: true }, connections: [{ id: "bot", adapterId: "test_im", enabled: false }] });
    w.set({ notify: { presence: true } });
    await expect.poll(() => w.to("dm-owner"), { timeout: 5000 }).toContain("Tomrade is online on your computer.");
    expect(w.to("room")).toEqual([]);
    await w.ctx.fiber.dispose();
    expect(w.to("dm-owner").at(-1)).toMatch(/^Tomrade is going offline/);
  });
});
