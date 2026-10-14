import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fresh, settle, sdk } from "@tomradex/testkit";
import { Agent, type Engine, type RunView } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, ImDeliveryError, type ImAdapter, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const message = (id: string, text = "hello", actorId = "owner", conversationId = "chat"): ImInbound => ({
  kind: "message", eventId: id, messageId: id, text, activation: "dm",
  actor: { id: actorId, isBot: false }, address: { tenantId: "team", conversationId }
});

async function boot(turn: Engine["turn"] = async (input, io) => { io.emit({ type: "text", text: `reply:${input.input.kind === "text" ? input.input.text : input.input.value}` }); return { stop: "end" }; }, buttons = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-"));
  const delivered: ImDelivery[] = [];
  const ios = new Map<string, AdapterIO>();
  const deliver = vi.fn(async (command: ImDelivery) => { delivered.push(structuredClone(command)); return { messageId: command.replaceMessageId ?? `remote-${delivered.length}` }; });
  const close = vi.fn();
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities: {
    edit: true, buttons, inboundFiles: true, outboundFiles: true, maxTextLength: 2000, maxFileBytes: 32 * 1024 * 1024 },
    async open(id, io) { ios.set(id, io); return { deliver, close, download: async () => Buffer.from("image") }; } };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], [Agent, { mediaDir: path.join(dir, "media") }], [Im, { pollMs: 10, retryMs: 10, progressMs: 100 }]] });
  cleanups.push(async () => { await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), media: () => ({ input: ["image/png"], output: ["image/png"] }), turn });
  const plugin = definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } });
  const fiber = world.ctx.plugin(sdk(plugin, { id: "test/im", namespace: "test", origin: "extension" }));
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    routes: [{ id: "route", connectionId: "bot", tenantId: "team", conversationId: "chat", projectId: world.project.id, engine: "test", allowedActors: ["owner"] }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  return { ...world, dir, delivered, deliver, close, ios, fiber, adapter, im: world.ctx.im, receive: (e: ImInbound) => ios.get("bot")!.receive(e) };
}

async function ended(w: Awaited<ReturnType<typeof boot>>, count = 1) {
  await expect.poll(() => w.ctx.agent.store.threads(w.project.id).reduce((sum, th) => sum + w.ctx.agent.store.runs(w.project.id, th.id).filter(r => r.status !== "running").length, 0)).toBe(count);
}

describe("IM common layer through the SDK", () => {
  it("shares the real assistant history and deduplicates provider events and message redelivery", async () => {
    const w = await boot();
    const receipt = await w.receive(message("one"));
    expect(await w.receive(message("one"))).toEqual(receipt);
    expect(await w.receive({ ...message("one"), eventId: "redelivery" })).toEqual(receipt);
    await ended(w);
    await expect.poll(() => w.delivered.some(d => d.content.text === "reply:hello")).toBe(true);
    const th = w.ctx.agent.store.threads(w.project.id)[0];
    expect(th.surface).toBe("assistant");
    expect(w.ctx.agent.thread(w.project.id, th.id).messages.filter(m => m.role === "user")).toHaveLength(1);
    expect(w.ctx.items.list({ projectId: w.project.id })).toHaveLength(0);
    await w.receive(message("two", "continue"));
    await ended(w, 2);
    expect(w.ctx.agent.store.threads(w.project.id)).toHaveLength(1);
    expect(w.ctx.agent.thread(w.project.id, th.id).messages.filter(m => m.role === "user")).toHaveLength(2);
  });

  it("ignores bots and unauthorized identities without retaining their message bodies", async () => {
    const w = await boot();
    await w.receive(message("bad", "SECRET", "stranger"));
    await w.receive({ ...message("bot"), actor: { id: "owner", isBot: true } });
    await w.receive(message("channel", "SECRET", "owner", "other-chat"));
    expect(w.ctx.agent.store.threads(w.project.id)).toHaveLength(0);
    expect(w.im.ignoredMessages()).toHaveLength(3);
    expect(JSON.stringify(w.im.ignoredMessages())).not.toContain("SECRET");
    expect(w.im.store.all("SELECT * FROM plugin_im_inbox")).toHaveLength(0);
  });

  it("queues normal messages and routes permissions to the same run, refusing stale and foreign actions", async () => {
    const answers: (string | null)[] = [];
    const w = await boot(async (input, io) => {
      if (input.input.kind === "text" && input.input.text === "first") answers.push(await io.requestPermission!("Run command?", ["Allow", "Deny"]));
      io.emit({ type: "text", text: "done" });
      return { stop: "end" };
    });
    await w.receive(message("first", "first"));
    await expect.poll(() => w.delivered.find(d => d.content.actions?.length)?.content.actions?.length).toBe(2);
    const question = w.delivered.find(d => d.content.actions?.length)!;
    const th = w.ctx.agent.store.threads(w.project.id)[0];
    const run = w.ctx.agent.store.runs(w.project.id, th.id)[0];
    await w.receive(message("second", "second"));
    expect(w.ctx.agent.store.runs(w.project.id, th.id)).toHaveLength(1);
    const action: ImInbound = { kind: "action", eventId: "answer", address: question.address, actor: { id: "owner", isBot: false }, token: question.content.actions![1].token };
    await w.receive({ ...action, eventId: "foreign", actor: { id: "stranger", isBot: false } });
    expect(answers).toEqual([]);
    await w.receive(action);
    await ended(w, 2);
    expect(answers).toEqual(["Deny"]);
    expect(w.ctx.agent.store.runs(w.project.id, th.id)[0].id).toBe(run.id);
    await w.receive({ ...action, eventId: "stale" });
    await expect.poll(() => w.im.store.get<{ state: string }>("SELECT state FROM plugin_im_inbox WHERE event_json LIKE '%stale%'")?.state).toBe("failed");
    expect(w.ctx.agent.store.runs(w.project.id, th.id)).toHaveLength(2);
  });

  it("expires the old card when the same permission is answered from desktop", async () => {
    const w = await boot(async (_input, io) => { await io.requestPermission!("Approve?", ["Yes", "No"]); return { stop: "end" }; });
    await w.receive(message("go"));
    await expect.poll(() => w.delivered.some(d => d.content.actions?.length)).toBe(true);
    const th = w.ctx.agent.store.threads(w.project.id)[0];
    const q = w.ctx.agent.thread(w.project.id, th.id).pending!.question;
    w.ctx.agent.send(w.project.id, th.id, { kind: "answer", questionId: q.id, value: "No" });
    await ended(w);
    await expect.poll(() => w.delivered.some(d => d.replaceMessageId && d.content.text === "问题已处理或失效")).toBe(true);
  });

  it("supports explicit text decisions on platforms without buttons", async () => {
    let answer: string | null = null;
    const w = await boot(async (_input, io) => { answer = await io.requestPermission!("Proceed?", ["Yes", "No"]); return { stop: "end" }; }, false);
    await w.receive(message("go"));
    await expect.poll(() => w.delivered.find(d => d.content.text.includes("No：/answer"))).toBeDefined();
    const text = w.delivered.find(d => d.content.text.includes("No：/answer"))!.content.text;
    const command = text.split("\n").find(l => l.startsWith("No："))!.slice(3);
    await w.receive(message("answer", command));
    await ended(w);
    expect(answer).toBe("No");
  });

  it("makes an explicitly requested ticket through existing Agent tools", async () => {
    const w = await boot(async (_input, io) => {
      const item = await io.tools.execute("create_item", { title: "A requested ticket", status: "backlog" }) as { key: string };
      io.emit({ type: "text", text: `Created ${item.key}` }); return { stop: "end" };
    });
    await w.receive(message("ticket", "create a ticket"));
    await ended(w);
    const items = w.ctx.items.list({ projectId: w.project.id });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "A requested ticket", status: "backlog", updatedBy: "ai:test" });
    await expect.poll(() => w.delivered.some(d => d.content.text.includes(items[0].key))).toBe(true);
  });

  it("recovers a persisted inbox item after send without starting another run", async () => {
    const w = await boot();
    const receipt = await w.receive(message("once"));
    await ended(w);
    w.im.store.run("UPDATE plugin_im_inbox SET state = 'queued', run_id = NULL WHERE id = ?", receipt.receiptId);
    await expect.poll(() => w.im.store.get<{ state: string }>("SELECT state FROM plugin_im_inbox WHERE id = ?", receipt.receiptId)?.state).toBe("accepted");
    const th = w.ctx.agent.store.threads(w.project.id)[0];
    expect(w.ctx.agent.store.runs(w.project.id, th.id)).toHaveLength(1);
  });

  it("retries known-unsent delivery with the same operation id, but leaves unknown outcomes uncertain", async () => {
    const w = await boot();
    w.deliver.mockRejectedValueOnce(new ImDeliveryError("rate limit", "retryable", 10));
    await w.receive(message("first"));
    await expect.poll(() => w.deliver.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(w.deliver.mock.calls[0][0].operationId).toBe(w.deliver.mock.calls[1][0].operationId);
    await ended(w);
    await expect.poll(() => w.im.views()[0].pending).toBe(0);
    w.deliver.mockRejectedValueOnce(new Error("network outcome unknown"));
    await w.receive(message("second"));
    await ended(w, 2);
    await expect.poll(() => w.im.views()[0].uncertain).toBe(1);
    const unknown = w.im.store.get<{ id: string }>("SELECT id FROM plugin_im_outbox WHERE state = 'uncertain'")!;
    await new Promise(r => setTimeout(r, 100));
    expect(w.im.views()[0].uncertain).toBe(1);
    expect(w.im.retry(unknown.id)).toBe(true);
    await expect.poll(() => w.im.views()[0].uncertain).toBe(0);
  });

  it("keeps different bot installations isolated and closes SDK connections on unload", async () => {
    const w = await boot();
    w.ctx.settings.set({ ...w.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }, { id: "other", adapterId: "test_im" }],
      routes: ["bot", "other"].map(connectionId => ({ id: connectionId, connectionId, tenantId: "team", conversationId: "chat", projectId: w.project.id, engine: "test", allowedActors: ["owner"] })) }) });
    await expect.poll(() => w.ios.has("other")).toBe(true);
    await w.receive(message("shared-id"));
    await w.ios.get("other")!.receive(message("shared-id"));
    await ended(w, 2);
    expect(w.ctx.agent.store.threads(w.project.id)).toHaveLength(2);
    await w.fiber.dispose();
    await expect.poll(() => w.close.mock.calls.length).toBe(2);
    await expect(w.receive(message("after-unload"))).rejects.toThrow("no longer active");
    expect(w.im.views().map(v => v.state)).toEqual(["unconfigured", "unconfigured"]);
  });

  it("checks upload and outbound file access using only scoped media handles", async () => {
    const w = await boot(async (input, io) => {
      expect(input.input.kind === "text" && input.input.attachments?.[0].name).toBe("sample.png");
      io.media!.publish({ name: "output.png", mime: "image/png", base64: Buffer.from("output").toString("base64") });
      return { stop: "end" };
    });
    const bytes: Uint8Array[] = [];
    const original = w.deliver.getMockImplementation()!;
    w.deliver.mockImplementation(async d => {
      for (const file of d.content.files ?? []) bytes.push(await w.ios.get("bot")!.readOutboundFile(file.id));
      return original(d);
    });
    await w.receive({ ...message("image"), kind: "message", messageId: "image", text: "", activation: "dm", attachments: [{ id: "remote-image", name: "sample.png", mimeType: "image/png", size: 5 }] });
    await ended(w);
    await expect.poll(() => bytes.length).toBe(1);
    expect(Buffer.from(bytes[0]).toString()).toBe("output");
    await expect(w.ios.get("bot")!.readOutboundFile("arbitrary-path")).rejects.toThrow("not part");
  });

  it("stops a live run and clears queued follow-up messages", async () => {
    const w = await boot(async (_input, io) => { await new Promise<void>(r => io.signal.addEventListener("abort", () => r(), { once: true })); return { stop: "cancelled" }; });
    await w.receive(message("go"));
    await expect.poll(() => w.ctx.agent.activeRuns().length).toBe(1);
    await w.receive(message("queued", "later"));
    await w.receive(message("stop", "/stop"));
    await ended(w);
    const th = w.ctx.agent.store.threads(w.project.id)[0];
    expect(w.ctx.agent.store.runs(w.project.id, th.id)).toHaveLength(1);
    expect(w.ctx.agent.store.runs(w.project.id, th.id)[0].status).toBe("cancelled");
    expect(w.im.store.all<{ state: string }>("SELECT state FROM plugin_im_inbox ORDER BY seq").map(r => r.state)).toEqual(["accepted", "cancelled", "accepted"]);
  });
});
