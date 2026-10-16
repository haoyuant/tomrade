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

const message = (id: string, text: string, extra: Partial<ImInbound & { kind: "message" }> = {}): ImInbound => ({
  kind: "message", eventId: id, messageId: id, text, activation: "dm",
  actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "chat" }, ...extra
});

/** A turn that works until released, reading steers as it goes, and answers with what it was told. */
function gated() {
  let release: () => void = () => {};
  const steered: string[] = [];
  const engine = (steers: boolean): Parameters<Agent["engine"]>[0] => ({
    id: "gated", title: "Gated", author: "ai:test", available: async () => ({ ok: true }), steers,
    turn: (async (input, io) => {
      const text = input.input.kind === "text" ? input.input.text : "";
      if (text.startsWith("long")) {
        let done = false;
        const gate = new Promise<void>(r => { release = () => { done = true; r(); }; });
        while (!done) {
          io.activity?.("reading the backlog");
          steered.push(...(io.takeSteers?.() ?? []));
          await Promise.race([gate, new Promise(r => setTimeout(r, 30))]);
        }
      }
      io.emit({ type: "text", text: `done:${text}` });
      return { stop: "end" };
    }) as Engine["turn"]
  });
  return { engine, steered, release: () => release() };
}

async function boot(opts: { edit?: boolean; steers?: boolean; locale?: "en" | "zh" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-running-"));
  const delivered: (ImDelivery & { messageId: string })[] = [];
  const ios = new Map<string, AdapterIO>();
  const adapter: ImAdapter = {
    id: "test_im", title: "Fake IM",
    capabilities: { edit: opts.edit ?? true, buttons: false, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0 },
    async open(id, io) {
      ios.set(id, io);
      return { deliver: async d => { const messageId = d.replaceMessageId ?? `m-${delivered.length + 1}`; delivered.push({ ...structuredClone(d), messageId }); return { messageId }; }, close: () => {} };
    }
  };
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json"), locale: opts.locale ?? "en" }], [Agent, { mediaDir: path.join(dir, "media") }], [Im, { pollMs: 10, retryMs: 10, progressMs: 100, sweepMs: 50 }]] });
  cleanups.push(async () => { for (const r of world.ctx.agent.activeRuns()) world.ctx.agent.cancel(r.run.id); await expect.poll(() => world.ctx.agent.activeRuns().length).toBe(0); await world.ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const g = gated();
  world.ctx.agent.engine(g.engine(opts.steers ?? true));
  world.ctx.plugin(sdk(definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } }), { id: "test/im", namespace: "test", origin: "extension" }));
  world.ctx.settings.set({ ...world.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "bot", adapterId: "test_im" }],
    routes: [{ id: "route", connectionId: "bot", tenantId: "team", conversationId: "chat", projectId: world.project.id, engine: "gated", allowedActors: ["owner", "mate"] }] }) });
  await expect.poll(() => ios.has("bot")).toBe(true);
  const receive = (e: ImInbound) => ios.get("bot")!.receive(e);
  const said = (text: string | RegExp) => delivered.some(d => typeof text === "string" ? d.content.text === text : text.test(d.content.text));
  const userTexts = () => world.ctx.agent.store.threads(world.project.id).flatMap(th =>
    world.ctx.agent.thread(world.project.id, th.id).messages.filter(m => m.role === "user" && m.block.type === "text").map(m => (m.block as { text: string }).text));
  const running = () => expect.poll(() => world.ctx.agent.activeRuns().length).toBe(1);
  /** The latest text of the message an operation id prefix was sent as. */
  const latest = (prefix: string) => delivered.filter(d => d.operationId.startsWith(prefix)).at(-1)?.content.text;
  return { ...world, ...g, delivered, receive, said, userTexts, running, latest };
}

describe("IM while a turn runs", () => {
  it("acknowledges queued messages with their place, keeps it current, and runs them in order", async () => {
    const w = await boot();
    await w.receive(message("a", "long job"));
    await w.running();
    await w.receive(message("b", "second"));
    await w.receive(message("c", "third"));
    await expect.poll(() => w.latest("queued:")).toBeDefined();
    await expect.poll(() => w.delivered.filter(d => d.operationId.startsWith("queued:")).map(d => d.content.text))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^Queued \(1 in line\)/), expect.stringMatching(/^Queued \(2 in line\)/)]));
    await w.receive(message("q", "/queue"));
    await expect.poll(() => w.said("1. second\n2. third")).toBe(true);
    await w.receive(message("s", "/status"));
    await expect.poll(() => w.said("Working: reading the backlog\n2 waiting")).toBe(true);

    w.release();
    await expect.poll(() => w.userTexts()).toEqual(["long job", "second", "third"]);
    // The receipt of the message that ran says so in place.
    await expect.poll(() => w.delivered.some(d => d.content.text === "Running now" && d.replaceMessageId)).toBe(true);
    await expect.poll(() => w.said("done:third")).toBe(true);
  });

  it("says a receipt once where the platform can't edit", async () => {
    const w = await boot({ edit: false });
    await w.receive(message("a", "long job"));
    await w.running();
    await w.receive(message("b", "second"));
    await w.receive(message("c", "third"));
    await expect.poll(() => w.delivered.filter(d => d.operationId.startsWith("queued:")).length).toBe(2);
    // "third" moves up a place once "second" is withdrawn; a non-editing chat isn't told again.
    await w.receive(message("u", "/unqueue 1"));
    await expect.poll(() => w.said("Withdrawn: second")).toBe(true);
    await new Promise(r => setTimeout(r, 150));
    expect(w.delivered.filter(d => d.operationId.startsWith("queued:"))).toHaveLength(2);
    w.release();
    await expect.poll(() => w.userTexts()).toEqual(["long job", "third"]);
  });

  it("steers the running turn with /steer and with a reply to its progress message", async () => {
    const w = await boot();
    await w.receive(message("a", "long job"));
    await w.running();
    await w.receive(message("s1", "/steer focus on bugs"));
    await expect.poll(() => w.steered).toEqual(["focus on bugs"]);
    await expect.poll(() => w.said("Sent into the current turn")).toBe(true);

    await expect.poll(() => w.delivered.find(d => d.content.text === "reading the backlog")).toBeDefined();
    const progress = w.delivered.find(d => d.content.text === "reading the backlog")!;
    await w.receive(message("s2", "only open ones", { replyTo: progress.messageId }));
    await expect.poll(() => w.steered).toEqual(["focus on bugs", "only open ones"]);

    w.release();
    await expect.poll(() => w.said("done:long job")).toBe(true);
    // Steers belong to the turn they reached; nothing was queued for another.
    expect(w.ctx.agent.store.threads(w.project.id).flatMap(th => w.ctx.agent.store.runs(w.project.id, th.id))).toHaveLength(1);
  });

  it("queues a steer the assistant can't take, and says so", async () => {
    const w = await boot({ steers: false, locale: "zh" });
    await w.receive(message("a", "long job"));
    await w.running();
    await w.receive(message("s", "/steer focus on bugs"));
    await expect.poll(() => w.said("当前助手不支持运行中插话，已改为排队，本轮结束后执行。")).toBe(true);
    expect(w.steered).toEqual([]);
    w.release();
    await expect.poll(() => w.userTexts()).toEqual(["long job", "focus on bugs"]);
  });

  it("never runs a queued message its sender withdrew on the platform, and doesn't rerun edits", async () => {
    const w = await boot();
    await w.receive(message("a", "long job"));
    await w.running();
    await w.receive(message("b", "never mind this"));
    await expect.poll(() => w.latest("queued:")).toMatch(/^Queued/);
    // Someone else can't withdraw it.
    await w.receive({ kind: "retract", eventId: "r0", messageId: "b", actor: { id: "mate", isBot: false }, address: { tenantId: "team", conversationId: "chat" } });
    await w.receive({ kind: "retract", eventId: "r1", messageId: "b", actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "chat" } });
    await expect.poll(() => w.latest("queued:")).toBe("Withdrawn; it won't run.");
    await w.receive({ kind: "edit", eventId: "e1", messageId: "a", actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "chat" } });
    await expect.poll(() => w.said(/^Edits don't rerun a message/)).toBe(true);
    w.release();
    await expect.poll(() => w.said("done:long job")).toBe(true);
    await new Promise(r => setTimeout(r, 200));
    expect(w.userTexts()).toEqual(["long job"]);
  });

  it("lists the commands it takes, the project and the assistant, in the desktop's language", async () => {
    for (const locale of ["en", "zh"] as const) {
      const w = await boot({ locale });
      await w.receive(message("h", "/help"));
      await expect.poll(() => w.delivered.length).toBeGreaterThan(0);
      const text = w.delivered[0].content.text;
      for (const command of ["/stop", "/status", "/new", "/answer", "/steer", "/queue", "/unqueue", "/help"]) expect(text).toContain(command);
      expect(text).toContain(locale === "en" ? "Assistant: Gated" : "助手：Gated");
      expect(text).toContain(locale === "en" ? "Project: " : "项目：");
    }
  });
});
