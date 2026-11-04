import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fresh, sdk, settle } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { Files } from "@tomradex/files";
import { definePlugin, toImDialect, type ImAdapter, type ImCapabilities, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Im, ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const CARDS: ImCapabilities = { edit: true, buttons: true, inboundFiles: false, outboundFiles: true, maxTextLength: 4000, maxFileBytes: 1024 * 1024, cards: true, markdown: "markdown" };
const PLAIN: ImCapabilities = { edit: false, buttons: false, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0, markdown: "plain" };

const hello = (id = "m1", text = "go"): ImInbound => ({ kind: "message", eventId: id, messageId: id, text, activation: "dm",
  actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "chat" } });

async function boot(capabilities: ImCapabilities, turn: Engine["turn"], output: "progress" | "verbose" = "progress") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-im-rich-"));
  const delivered: ImDelivery[] = [];
  const sent: Record<string, Uint8Array> = {};
  const ios = new Map<string, AdapterIO>();
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities, async open(id, io) {
    ios.set(id, io);
    return { close: () => {}, deliver: async d => {
      for (const f of d.content.files ?? []) sent[f.id] = await io.readOutboundFile(f.id);
      delivered.push(structuredClone(d));
      return { messageId: d.replaceMessageId ?? `m-${delivered.length}` };
    } };
  } };
  const world = await fresh({ hubDir: dir, plugins: [[Settings, { path: path.join(dir, "settings.json") }],
    [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }], Tools, [Agent, { mediaDir: path.join(dir, "media") }],
    [Files, { watch: false, autoSyncMs: 0 }], [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  await settle();
  await world.ctx.storage.ready;
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    routes: [{ id: "route", connectionId: "bot", tenantId: "team", conversationId: "chat", projectId: world.project.id, engine: "test", allowedActors: ["owner"], output }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  return { ...world, delivered, sent, receive: (e: ImInbound) => ios.get("bot")!.receive(e) };
}

const creates: Engine["turn"] = async (_input, io) => {
  await io.tools.execute("create_item", { title: "Fix the login page", status: "todo", priority: 3 });
  io.emit({ type: "text", text: "Filed it." });
  return { stop: "end" };
};

describe("rich IM replies", () => {
  it("folds the ticket a turn created into its reply, with no link a phone can't open", async () => {
    const w = await boot(CARDS, creates);
    await w.receive(hello());
    await expect.poll(() => w.delivered.find(d => d.content.elements?.some(e => e.type === "section")), { timeout: 5000 }).toBeDefined();
    const item = w.ctx.items.list({ projectId: w.project.id })[0];
    const card = w.delivered.find(d => d.content.elements?.some(e => e.type === "section"))!;
    expect(card.content.text).toBe("Filed it.");
    expect(card.content.elements).toEqual([
      { type: "section", title: `Created · ${item.key} Fix the login page`, fields: [{ label: "Status", value: "Todo" }, { label: "Priority", value: "High" }] }
    ]);
    // The reply was changed in place: the progress message and the reply are all the turn sent.
    expect(new Set(w.delivered.map(d => d.content.text === "Filed it." ? "reply" : d.operationId.split(":")[0]))).toEqual(new Set(["progress", "reply"]));
    expect(JSON.stringify(w.delivered)).not.toContain("tomrade://");
  });

  it("answers a request to file and start a ticket with one reply: what it made and where it stands, and the question apart", async () => {
    const turn: Engine["turn"] = async (_input, io) => {
      const made = await io.tools.execute("create_item", { title: "Explain local setup", status: "todo", priority: 3 }) as { id: string; key: string };
      await io.tools.execute("change_status", { id: made.id, status: "doing" });
      // A card IM shows only by its title, here the keys a start was about.
      io.emit({ type: "card", id: "start-batch", schema: "start-batch", title: made.key, data: {} });
      await io.tools.execute("ask_user", { question: "Where should the checkout go?", options: ["Clone it (Recommended)", "Use an existing folder"], freeText: true });
      io.emit({ type: "text", text: "Filed and started it." });
      return { stop: "end" };
    };
    const w = await boot(CARDS, turn);
    await w.receive(hello());
    await expect.poll(() => w.delivered.find(d => d.content.text === "Filed and started it." && d.content.elements?.length), { timeout: 5000 }).toBeDefined();
    const item = w.ctx.items.list({ projectId: w.project.id })[0];
    const reply = w.delivered.findLast(d => d.content.text === "Filed and started it.")!;
    expect(reply.content.elements).toEqual([{ type: "section", title: `Created · ${item.key} Explain local setup`, fields: [{ label: "Status", value: "Doing" }, { label: "Priority", value: "High" }] }]);
    // The question goes on its own, and may land after the reply.
    await expect.poll(() => w.delivered.find(d => d.content.text.startsWith("Where should the checkout go?")), { timeout: 5000 }).toBeDefined();
    const question = w.delivered.find(d => d.content.text.startsWith("Where should the checkout go?"))!;
    expect(question.content.actions?.map(a => [a.label, a.style])).toEqual([["Clone it (Recommended)", "primary"], ["Use an existing folder", undefined]]);
    // The progress message, the question and the reply: no status news, no card of its own.
    expect(new Set(w.delivered.map(d => d.operationId.split(":")[0]))).toEqual(new Set(["progress", "question", "message"]));
    const progress = w.delivered.filter(d => d.operationId.startsWith("progress:")).at(-1)!.content.text;
    expect(progress).toBe("Turn finished\nCreating the ticket · Updating the ticket");
    expect(JSON.stringify(w.delivered)).not.toMatch(/tomrade:\/\/|create_item|change_status|ask_user/);
  });

  it("tells about mentions and lists the commands in /help", async () => {
    const w = await boot(CARDS, creates);
    await w.receive(hello("h", "/help"));
    await expect.poll(() => w.delivered.find(d => d.content.text.includes("/project")), { timeout: 5000 }).toBeDefined();
    expect(w.delivered.find(d => d.content.text.includes("/project"))!.content.text).toContain("typing @ and picking me from the list");
  });

  it("folds the card into text where the platform has no cards, after the reply it can't change", async () => {
    const w = await boot(PLAIN, creates);
    await w.receive(hello());
    const item = () => w.ctx.items.list({ projectId: w.project.id })[0];
    await expect.poll(() => w.delivered.some(d => d.content.text.includes("Status: Todo")), { timeout: 5000 }).toBe(true);
    expect(w.delivered.map(d => d.content.text.split("\n")[0])).toEqual(["Filed it.", `Created · ${item().key} Fix the login page`]);
    const text = w.delivered.find(d => d.content.text.includes("Status: Todo"))!.content.text;
    expect(text).toContain(`${item().key} Fix the login page`);
    expect(text).toContain("Status: Todo");
  });

  // Creating the store and two versioned saves run ~27 git commands; a busy machine stretches each spawn to most of a second.
  it("sends a document the turn saved as the exact Files version, with a link to it", { timeout: 30_000 }, async () => {
    const body = "# Release plan\n\n1. Freeze\n2. Ship\n";
    const w = await boot(CARDS, async (_input, io) => {
      await io.tools.execute("write_file", { path: "Docs/release-plan.md", content: body });
      await io.tools.execute("write_file", { path: "Docs/release-plan.md", content: "a later edit" });
      io.emit({ type: "text", text: "Saved the plan." });
      return { stop: "end" };
    });
    await w.receive(hello());
    await expect.poll(() => w.delivered.filter(d => d.content.files?.length).length, { timeout: 25_000 }).toBe(2);
    const [first] = w.delivered.filter(d => d.content.files?.length);
    const file = first.content.files![0];
    expect(file).toMatchObject({ name: "release-plan.md", mimeType: "text/markdown" });
    const [, fileId, versionId] = /^files:([^:]+):([^:]+)$/.exec(file.id)!;
    // The first message carries the first version, not whatever the file holds now.
    expect(Buffer.from(w.sent[file.id]).toString("utf8")).toBe(body);
    expect((await w.ctx.files.readVersion(w.project.id, { fileId, versionId }))?.body).toBe(body);
    expect(first.content.text).toBe(toImDialect("Saved Docs/release-plan.md", "markdown"));
  });

  it("keeps tools and retries to one line of the progress message, and lists each tool only when asked", async () => {
    const turn: Engine["turn"] = async (_input, io) => {
      io.retry?.({ attempt: 2, max: 3, reason: "overloaded" });
      io.activity?.("thinking");
      await new Promise(r => setTimeout(r, 250));
      io.retry?.(null);
      await io.tools.execute("list_items", {});
      io.activity?.("looking");
      await new Promise(r => setTimeout(r, 250));
      io.emit({ type: "text", text: "Nothing urgent." });
      return { stop: "end" };
    };
    const w = await boot(CARDS, turn);
    await w.receive(hello());
    await expect.poll(() => w.delivered.some(d => d.content.text.startsWith("Retrying (attempt 2 of 3)")), { timeout: 5000 }).toBe(true);
    await expect.poll(() => w.delivered.some(d => d.content.text === "looking\nLooking through the backlog"), { timeout: 5000 }).toBe(true);
    await expect.poll(() => w.delivered.some(d => d.content.text === "Turn finished\nLooking through the backlog"), { timeout: 5000 }).toBe(true);
    // The sweep that settles missed runs leaves the tool line in place.
    await new Promise(r => setTimeout(r, 200));
    expect(w.delivered.filter(d => d.operationId.startsWith("progress:")).at(-1)!.content.text).toBe("Turn finished\nLooking through the backlog");
    expect(w.delivered.some(d => d.content.text === "✓ list_items")).toBe(false);
    expect(JSON.stringify(w.delivered)).not.toContain("overloaded");

    const v = await boot(CARDS, turn, "verbose");
    await v.receive(hello());
    await expect.poll(() => v.delivered.some(d => d.content.text === "✓ list_items"), { timeout: 5000 }).toBe(true);
  });
});
