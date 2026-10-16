import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Agent, type Engine } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, toImDialect, type ImAdapter, type ImAdapterSession, type ImCapabilities, type ImCommand, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { ImSettings } from "@tomradex/im";

type AdapterIO = Parameters<ImAdapter["open"]>[1];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const FULL: ImCapabilities = {
  edit: true, buttons: true, inboundFiles: true, outboundFiles: true, maxTextLength: 4000, maxFileBytes: 1024 * 1024,
  threads: true, reactions: true, typing: true, stream: "native", select: true, multiSelect: true, textInput: true,
  cards: true, cardUpdate: true, nativeCommands: true, ephemeral: true, markdown: "slack"
};
const TEXT_ONLY: ImCapabilities = {
  edit: false, buttons: false, inboundFiles: false, outboundFiles: false, maxTextLength: 200, maxFileBytes: 0,
  stream: "none", markdown: "plain"
};

const REPLY = "**Plan** for `build`:\n- first step\n- second step\n```sh\npnpm build && pnpm test\n```\nSee [the guide](https://example.com/guide).";
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The same conversation for every tier: a streamed reply, then a multi-select question. */
const turn: Engine["turn"] = async (input, io) => {
  if (input.input.kind === "answer") { io.emit({ type: "text", text: `Chose ${JSON.stringify(input.input.value)}` }); return { stop: "end" }; }
  for (const piece of [REPLY.slice(0, 20), REPLY.slice(20, 60), REPLY.slice(60)]) { io.delta(piece); await pause(120); }
  io.emit({ type: "text", text: REPLY });
  await io.tools.execute("ask_user", { question: "Which targets?", options: ["web", "desktop", "cli"], multiple: true });
  return { stop: "end" };
};

async function boot(capabilities: ImCapabilities, engineTurn: Engine["turn"] = turn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-v2-"));
  const delivered: ImDelivery[] = [];
  const calls: { op: string; arg: unknown }[] = [];
  const ios = new Map<string, AdapterIO>();
  const native = capabilities.stream === "native";
  const session: ImAdapterSession = {
    deliver: vi.fn(async (d: ImDelivery) => { delivered.push(structuredClone(d)); return { messageId: d.replaceMessageId ?? `m-${delivered.length}` }; }),
    close: vi.fn(),
    ...(capabilities.reactions ? { react: async (arg: unknown) => { calls.push({ op: "react", arg }); } } : {}),
    ...(capabilities.typing ? { indicate: async (arg: unknown) => { calls.push({ op: "indicate", arg }); } } : {}),
    ...(capabilities.nativeCommands ? { commands: async (arg: ImCommand[]) => { calls.push({ op: "commands", arg }); } } : {}),
    ...(native ? { stream: {
      start: async (d: ImDelivery) => { calls.push({ op: "start", arg: structuredClone(d) }); return { messageId: "stream-1" }; },
      append: async (arg: unknown) => { calls.push({ op: "append", arg }); },
      stop: async (arg: { messageId: string }) => { calls.push({ op: "stop", arg: structuredClone(arg) }); return { messageId: arg.messageId }; }
    } } : {})
  };
  const adapter: ImAdapter = { id: "test_im", title: "Fake IM", capabilities, async open(id, io) { ios.set(id, io); return session; } };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], [Agent, { mediaDir: path.join(dir, "media") }], [(await import("@tomradex/im")).Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  world.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }), turn: engineTurn });
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    routes: [{ id: "route", connectionId: "bot", tenantId: "team", conversationId: "room", projectId: world.project.id, engine: "test", allowedActors: ["owner"], allowGroups: true }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  const runsEnded = (n: number) => expect.poll(() => world.ctx.agent.store.threads(world.project.id)
    .reduce((sum, th) => sum + world.ctx.agent.store.runs(world.project.id, th.id).filter(r => r.status !== "running").length, 0), { timeout: 5000 }).toBe(n);
  return { ...world, delivered, calls, receive, runsEnded };
}

/** Mentions the bot in a group, streams a reply, then answers the multi-select question the way the platform allows. */
async function conversation(capabilities: ImCapabilities) {
  const w = await boot(capabilities);
  await w.receive({ kind: "message", eventId: "e1", messageId: "msg-1", text: "plan the build", activation: "mention",
    actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "room" } });
  await expect.poll(() => w.delivered.find(d => d.content.text.startsWith("Which targets?")), { timeout: 5000 }).toBeDefined();
  const question = w.delivered.find(d => d.content.text.startsWith("Which targets?"))!;
  const select = question.content.elements?.find(e => e.type === "select");
  if (select?.type === "select") {
    await w.receive({ kind: "action", eventId: "e2", token: select.token, value: ["web", "cli"], actor: { id: "owner", isBot: false }, address: question.address });
  } else {
    const token = /\/answer (\S+)/.exec(question.content.text)![1];
    await w.receive({ kind: "message", eventId: "e2", messageId: "msg-2", text: `/answer ${token} ["web","cli"]`, activation: "mention",
      actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "room" } });
  }
  await w.runsEnded(2);
  await expect.poll(() => w.delivered.some(d => d.content.text.includes("Chose")), { timeout: 5000 }).toBe(true);
  return { ...w, question };
}

describe("IM adapter contract v2", () => {
  it("uses every native capability on a full adapter", async () => {
    const w = await conversation(FULL);
    // Native commands, typing and reactions.
    expect(w.calls.find(c => c.op === "commands")?.arg).toEqual(expect.arrayContaining([expect.objectContaining({ name: "stop" }), expect.objectContaining({ name: "answer" })]));
    expect(w.calls.some(c => c.op === "indicate" && (c.arg as { state: string }).state === "typing")).toBe(true);
    expect(w.calls.some(c => c.op === "indicate" && (c.arg as { state: string }).state === "idle")).toBe(true);
    await expect.poll(() => w.calls.filter(c => c.op === "react").map(c => (c.arg as { reaction: string }).reaction)).toEqual(expect.arrayContaining(["received", "done"]));
    // The reply streamed natively, in the thread under the mention, and settled to the full Slack-dialect text.
    const start = w.calls.find(c => c.op === "start")!.arg as ImDelivery;
    expect(start.threadId).toBe("msg-1");
    expect(start.replyTo).toBeUndefined();
    expect(w.calls.some(c => c.op === "append")).toBe(true);
    const stop = w.calls.find(c => c.op === "stop")!.arg as { messageId: string; content: { text: string } };
    expect(stop.messageId).toBe("stream-1");
    expect(stop.content.text).toBe(toImDialect(REPLY, "slack"));
    expect(w.delivered.some(d => d.content.text.includes("first step") && !d.replaceMessageId)).toBe(false);
    // The question is a native multi-select card in the same thread.
    expect(w.question.threadId).toBe("msg-1");
    expect(w.question.content.elements).toEqual([expect.objectContaining({ type: "select", multiple: true, options: ["web", "desktop", "cli"].map(o => ({ label: o, value: o })) })]);
    expect(w.question.content.text).not.toContain("/answer");
    expect(w.delivered.find(d => d.content.text.includes("Chose"))!.content.text).toBe('Chose ["web","cli"]');
  });

  it("degrades the same conversation to plain text without losing information", async () => {
    const w = await conversation(TEXT_ONLY);
    expect(w.calls).toEqual([]);
    // No stream or edits: the reply arrives once, whole, as plain text quoting the mention.
    const reply = w.delivered.filter(d => d.content.text.includes("first step"));
    expect(reply).toHaveLength(1);
    expect(reply[0].content.text).toBe(toImDialect(REPLY, "plain"));
    expect(reply[0].content.text).toContain("pnpm build && pnpm test");
    expect(reply[0].content.text).toContain("the guide (https://example.com/guide)");
    expect(reply[0].replyTo).toBe("msg-1");
    expect(reply[0].threadId).toBeUndefined();
    expect(w.delivered.every(d => !d.replaceMessageId && d.content.text.length <= 200 && !d.content.elements?.length && !d.content.actions?.length)).toBe(true);
    // Every option and how to answer are in the text.
    for (const option of ["web", "desktop", "cli"]) expect(w.question.content.text).toContain(option);
    expect(w.question.content.text).toMatch(/\/answer \S+ \["option", …\]/);
    expect(w.delivered.find(d => d.content.text.includes("Chose"))!.content.text).toBe('Chose ["web","cli"]');
  });

  it("falls back from a native stream to edits of one message", async () => {
    const { stream: _native, ...rest } = FULL;
    const w = await conversation({ ...rest, stream: "edit" });
    expect(w.calls.some(c => ["start", "append", "stop"].includes(c.op))).toBe(false);
    const streamed = w.delivered.filter(d => d.content.text.startsWith("*Plan*"));
    expect(streamed.length).toBeGreaterThan(1);
    expect(new Set(streamed.slice(1).map(d => d.replaceMessageId))).toEqual(new Set([`m-${w.delivered.indexOf(streamed[0]) + 1}`]));
    expect(streamed.at(-1)!.content.text).toBe(toImDialect(REPLY, "slack"));
  });

  it("holds a conversation to its rate limit without reordering", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const w = await boot({ ...TEXT_ONLY, maxTextLength: 128, rateLimit: { messages: 2, windowMs: 400 } },
      async (_input, io) => { io.emit({ type: "text", text: long }); return { stop: "end" }; });
    const started = Date.now();
    await w.receive({ kind: "message", eventId: "r1", messageId: "r1", text: "go", activation: "dm", actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "room" } });
    await expect.poll(() => w.delivered.map(d => d.content.text).join("\n"), { timeout: 5000 }).toBe(long);
    expect(w.delivered.length).toBeGreaterThan(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });
});
