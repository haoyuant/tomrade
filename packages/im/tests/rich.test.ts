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
  it("answers a change with a ticket card that opens the ticket on the desktop", async () => {
    const w = await boot(CARDS, creates);
    await w.receive(hello());
    await expect.poll(() => w.delivered.find(d => d.content.elements?.some(e => e.type === "section")), { timeout: 5000 }).toBeDefined();
    const item = w.ctx.items.list({ projectId: w.project.id })[0];
    const card = w.delivered.find(d => d.content.elements?.some(e => e.type === "section"))!;
    expect(card.content.elements).toEqual([
      { type: "section", title: `Created · ${item.key} Fix the login page`, fields: [{ label: "Status", value: "Todo" }, { label: "Priority", value: "High" }] },
      { type: "links", links: [{ label: "Open in Tomrade", url: `tomrade://item/${encodeURIComponent(w.project.id)}/${item.key}` }] }
    ]);
  });

  it("folds the card into text with the link where the platform has no cards", async () => {
    const w = await boot(PLAIN, creates);
    await w.receive(hello());
    const item = () => w.ctx.items.list({ projectId: w.project.id })[0];
    await expect.poll(() => w.delivered.some(d => d.content.text.includes("Open in Tomrade (tomrade://item/")), { timeout: 5000 }).toBe(true);
    const text = w.delivered.find(d => d.content.text.includes("Open in Tomrade"))!.content.text;
    expect(text).toContain(`${item().key} Fix the login page`);
    expect(text).toContain("Status: Todo");
  });

  it("sends a document the turn saved as the exact Files version, with a link to it", async () => {
    const body = "# Release plan\n\n1. Freeze\n2. Ship\n";
    const w = await boot(CARDS, async (_input, io) => {
      await io.tools.execute("write_file", { path: "Docs/release-plan.md", content: body });
      await io.tools.execute("write_file", { path: "Docs/release-plan.md", content: "a later edit" });
      io.emit({ type: "text", text: "Saved the plan." });
      return { stop: "end" };
    });
    await w.receive(hello());
    await expect.poll(() => w.delivered.filter(d => d.content.files?.length).length, { timeout: 5000 }).toBe(2);
    const [first] = w.delivered.filter(d => d.content.files?.length);
    const file = first.content.files![0];
    expect(file).toMatchObject({ name: "release-plan.md", mimeType: "text/markdown" });
    const [, fileId, versionId] = /^files:([^:]+):([^:]+)$/.exec(file.id)!;
    // The first message carries the first version, not whatever the file holds now.
    expect(Buffer.from(w.sent[file.id]).toString("utf8")).toBe(body);
    expect((await w.ctx.files.readVersion(w.project.id, { fileId, versionId }))?.body).toBe(body);
    expect(first.content.text).toBe(toImDialect(`Saved [Docs/release-plan.md](tomrade://file/${encodeURIComponent(w.project.id)}/${fileId})`, "markdown"));
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
    await expect.poll(() => w.delivered.some(d => d.content.text === "looking\nlist_items ✓"), { timeout: 5000 }).toBe(true);
    await expect.poll(() => w.delivered.some(d => d.content.text === "Turn finished\nlist_items ✓"), { timeout: 5000 }).toBe(true);
    // The sweep that settles missed runs leaves the tool line in place.
    await new Promise(r => setTimeout(r, 200));
    expect(w.delivered.filter(d => d.operationId.startsWith("progress:")).at(-1)!.content.text).toBe("Turn finished\nlist_items ✓");
    expect(w.delivered.some(d => d.content.text === "✓ list_items")).toBe(false);
    expect(JSON.stringify(w.delivered)).not.toContain("overloaded");

    const v = await boot(CARDS, turn, "verbose");
    await v.receive(hello());
    await expect.poll(() => v.delivered.some(d => d.content.text === "✓ list_items"), { timeout: 5000 }).toBe(true);
  });
});
