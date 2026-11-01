/** A run the app's closing cut short leaves its conversation interrupted, until someone continues it, waves it away or archives it. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, type Block, type ThreadMessage, type ThreadSummary } from "@tomradex/agent";

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-interrupted-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }]] });
  const said: string[] = [];
  const history: string[] = [];
  ctx.agent.engine({
    id: "coder",
    title: "Coder",
    author: "ai:coder",
    available: async () => ({ ok: true }),
    async turn(input, io) {
      said.push(input.input.kind === "text" ? input.input.text : "");
      const last = input.messages.at(-1)?.block;
      history.push(last?.type === "text" ? last.text : "");
      io.emit({ type: "text", text: "Picking up." });
      return { stop: "end" };
    }
  });
  // what the panel asks for, answered by the handlers the agent registers
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  (ctx as unknown as { provide(name: string, value: unknown): void }).provide("ipc", {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    send: () => {}
  });
  await expect.poll(() => handlers.has("agent.threads")).toBe(true);
  const changed: string[] = [];
  ctx.on("agent/interrupted-changed", (_projectId, threadId) => void changed.push(threadId));
  const panel = () => handlers.get("agent.threads")!(project.id) as ThreadSummary[];
  const done = async () => {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { ctx, project, said, history, changed, panel, handlers, done };
}

const notes = (messages: ThreadMessage[]) => messages.flatMap((m) => (m.block.type === "note" ? [m.block as Extract<Block, { type: "note" }>] : []));

it("stops the run as interrupted, not cancelled, and marks the notes in the conversation and in the one it reports to", async () => {
  const { ctx, project, done } = await setup();
  try {
    const store = ctx.agent.store;
    const parent = store.createThread(project.id, "coder", "Chat");
    const child = store.createThread(project.id, "coder", "Chat · writing code", null, null, null, "assistant", parent.id);
    const run = store.beginRun(project.id, child.id, "coder");
    expect(store.reconcileInterrupted(project.id, "Interrupted.", (title) => `Background “${title}” was interrupted.`)).toEqual([child.id]);
    expect(store.reconcileInterrupted(project.id, "Interrupted.", (title) => `Background “${title}” was interrupted.`)).toEqual([]);
    expect(store.run(project.id, run.id)).toMatchObject({ status: "cancelled", stop: "interrupted", error: "Interrupted.", dismissedAt: null });
    expect(notes(store.messages(project.id, child.id))).toEqual([{ type: "note", text: "Interrupted.", interrupted: true }]);
    expect(notes(store.messages(project.id, parent.id))).toEqual([{ type: "note", text: "Background “Chat · writing code” was interrupted.", threadFor: child.id, interrupted: true }]);
    expect(store.interruptedThreads(project.id).map((th) => th.id)).toEqual([child.id]);
    expect(store.interruptedRun(project.id, parent.id)).toBeNull();
  } finally { await done(); }
});

it("says which conversations a project's opening found interrupted", async () => {
  const { ctx, project, changed, done } = await setup();
  try {
    const thread = ctx.agent.newThread(project.id, "coder", null, { title: "Dedupe" });
    ctx.agent.store.beginRun(project.id, thread.id, "coder");
    ctx.emit("db/opened", project.id);
    expect(changed).toEqual([thread.id]);
    expect(notes(ctx.agent.thread(project.id, thread.id).messages)).toEqual([{ type: "note", text: "Interrupted \u2014 the app closed while this run was in progress.", interrupted: true }]);
  } finally { await done(); }
});

it("lists the conversation as interrupted for the panel until a new run continues it, which says so", async () => {
  const { ctx, project, said, changed, panel, handlers, done } = await setup();
  try {
    const thread = ctx.agent.newThread(project.id, "coder", null, { title: "Dedupe" });
    ctx.agent.store.beginRun(project.id, thread.id, "coder");
    ctx.agent.store.reconcileInterrupted(project.id, "Interrupted.");
    expect(panel().find((th) => th.id === thread.id)?.interrupted).toBe(true);

    const { runId } = handlers.get("agent.continueInterrupted")!(project.id, thread.id) as { runId: string };
    expect(changed).toEqual([thread.id]);
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).toBe("done");
    expect(said[0]).toMatch(/^Tomrade restarted and interrupted the last run\. Continue where you left off\.\n\n\(From Tomrade: /);
    expect(panel().find((th) => th.id === thread.id)?.interrupted).toBeUndefined();
    expect(ctx.agent.store.interruptedThreads(project.id)).toEqual([]);
    // nothing left to continue
    expect(() => ctx.agent.continueInterrupted(project.id, thread.id)).toThrow(/not interrupted/);
  } finally { await done(); }
});

it("tells the agent to check before repeating, once, in what either kind of engine reads, and shows only what was sent", async () => {
  const { ctx, project, said, history, done } = await setup();
  try {
    const thread = ctx.agent.newThread(project.id, "coder", null, { title: "Dedupe" });
    ctx.agent.store.beginRun(project.id, thread.id, "coder");
    ctx.agent.store.reconcileInterrupted(project.id, "Interrupted.");

    const first = ctx.agent.send(project.id, thread.id, { kind: "text", text: "and open the PR" });
    await expect.poll(() => ctx.agent.store.run(project.id, first.runId)?.status).toBe("done");
    expect(said[0]).toMatch(/^and open the PR\n\n.*already happened/s);
    expect(history[0]).toBe(said[0]);
    const shown = ctx.agent.thread(project.id, thread.id).messages.filter((m) => m.role === "user").map((m) => (m.block as { text: string }).text);
    expect(shown).toEqual(["and open the PR"]);

    const second = ctx.agent.send(project.id, thread.id, { kind: "text", text: "thanks" });
    await expect.poll(() => ctx.agent.store.run(project.id, second.runId)?.status).toBe("done");
    expect(said[1]).toBe("thanks");
    expect(history[1]).toBe("thanks");
  } finally { await done(); }
});

it("says nothing of the kind to a conversation that was not interrupted, or to an engine with no model", async () => {
  const { ctx, project, said, done } = await setup();
  try {
    const thread = ctx.agent.newThread(project.id, "coder", null, { title: "Plain" });
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "hello" });
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).toBe("done");
    expect(said).toEqual(["hello"]);

    const heard: string[] = [];
    ctx.agent.engine({ id: "menu", title: "Menu", author: "ai:menu", literal: true, available: async () => ({ ok: true }), async turn(input) { heard.push(input.input.kind === "text" ? input.input.text : ""); return { stop: "end" }; } });
    const menu = ctx.agent.newThread(project.id, "menu", null, { title: "Menu" });
    ctx.agent.store.beginRun(project.id, menu.id, "menu");
    ctx.agent.store.reconcileInterrupted(project.id, "Interrupted.");
    const again = ctx.agent.send(project.id, menu.id, { kind: "text", text: "cancel" });
    await expect.poll(() => ctx.agent.store.run(project.id, again.runId)?.status).toBe("done");
    expect(heard).toEqual(["cancel"]);
  } finally { await done(); }
});

it("waving the interruption away leaves the conversation as it was, no longer interrupted", async () => {
  const { ctx, project, said, changed, panel, done } = await setup();
  try {
    const thread = ctx.agent.newThread(project.id, "coder", null, { title: "Dedupe" });
    const run = ctx.agent.store.beginRun(project.id, thread.id, "coder");
    ctx.agent.store.reconcileInterrupted(project.id, "Interrupted.");
    const before = ctx.agent.thread(project.id, thread.id).messages.length;

    expect(ctx.agent.dismissInterrupted(project.id, thread.id)).toBe(true);
    expect(changed).toEqual([thread.id]);
    expect(ctx.agent.store.run(project.id, run.id)?.dismissedAt).toEqual(expect.any(Number));
    expect(panel().find((th) => th.id === thread.id)?.interrupted).toBeUndefined();
    expect(ctx.agent.thread(project.id, thread.id).messages).toHaveLength(before);
    expect(said).toEqual([]);
    expect(ctx.agent.dismissInterrupted(project.id, thread.id)).toBe(false);
    expect(changed).toEqual([thread.id]);
  } finally { await done(); }
});

it("an archived conversation is not interrupted; restored, it is again", async () => {
  const { ctx, project, changed, done } = await setup();
  try {
    const thread = ctx.agent.newThread(project.id, "coder", null, { title: "Dedupe" });
    ctx.agent.store.beginRun(project.id, thread.id, "coder");
    ctx.agent.store.reconcileInterrupted(project.id, "Interrupted.");

    ctx.agent.archiveThread(project.id, thread.id);
    expect(ctx.agent.store.interruptedThreads(project.id)).toEqual([]);
    expect(ctx.agent.store.interruptedRun(project.id, thread.id)).toBeNull();
    ctx.agent.unarchiveThread(project.id, thread.id, { restored: true });
    expect(ctx.agent.store.interruptedThreads(project.id).map((th) => th.id)).toEqual([thread.id]);
    expect(changed).toEqual([thread.id, thread.id]);
  } finally { await done(); }
});

it("leaves a run the person stopped as cancelled, with nothing to continue", async () => {
  const { ctx, project, done } = await setup();
  try {
    const thread = ctx.agent.newThread(project.id, "coder", null, { title: "Dedupe" });
    const run = ctx.agent.store.beginRun(project.id, thread.id, "coder");
    ctx.agent.store.endRun(project.id, run.id, { status: "cancelled", stop: "cancelled", changes: 0 });
    expect(ctx.agent.store.run(project.id, run.id)?.stop).toBe("cancelled");
    expect(ctx.agent.store.run(project.id, run.id)).not.toHaveProperty("dismissedAt");
    expect(ctx.agent.store.interruptedThreads(project.id)).toEqual([]);
    expect(ctx.agent.dismissInterrupted(project.id, thread.id)).toBe(false);
  } finally { await done(); }
});
