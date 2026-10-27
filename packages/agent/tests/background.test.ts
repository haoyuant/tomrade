/** 「放到后台做」: the coding moves to a conversation of its own under this one; this one is free to talk, and the conclusion comes back once. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, type Block, type ThreadMessage } from "@tomradex/agent";

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-background-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }]] });
  const gates = new Map<string, () => void>();
  // the turn holds here until the test lets it go — or until it is stopped
  const gate = (id: string, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    gates.set(id, resolve);
    signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
  });
  const openers: string[] = [];
  ctx.agent.engine({
    id: "coder",
    title: "Coder",
    author: "ai:coder",
    available: async () => ({ ok: true }),
    async turn(input, io) {
      const text = input.input.kind === "text" ? input.input.text : "";
      if (text.startsWith("Carry on in the background — ")) {
        openers.push(text);
        io.emit({ type: "trace", tool: "write_file", args: { path: "b.ts" }, ok: true, summary: "b.ts", ms: 1 });
        await gate("child", io.signal);
        io.emit({ type: "text", text: "Done: b.ts written, 3 tests pass." });
        return { stop: "end" };
      }
      if (text.startsWith("write")) {
        io.emit({ type: "text", text: "On it." });
        io.emit({ type: "trace", tool: "write_file", args: { path: "a.ts" }, ok: true, summary: "a.ts", ms: 1 });
        await gate("parent", io.signal);
        io.emit({ type: "text", text: "Written." });
        return { stop: "end" };
      }
      io.emit({ type: "text", text: "Sure." });
      return { stop: "end" };
    }
  });
  const done = async () => {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { ctx, project, gates, openers, done };
}

const notesFor = (messages: ThreadMessage[], threadId: string) => messages.filter((m): m is ThreadMessage & { block: Extract<Block, { type: "note" }> } => m.block.type === "note" && m.block.threadFor === threadId);

it("moves the coding under way to a child conversation under this one, which carries on from everything said and done, and leaves this one free to talk", async () => {
  const { ctx, project, gates, openers, done } = await setup();
  try {
    const parent = ctx.agent.newThread(project.id, "coder", null, { title: "Dedupe chat" });
    ctx.agent.send(project.id, parent.id, { kind: "text", text: "write a dedupe script" });
    await expect.poll(() => ctx.agent.thread(project.id, parent.id).messages.some((m) => m.block.type === "trace")).toBe(true);
    const { threadId: childId, runId } = await ctx.agent.toBackground(project.id, parent.id);
    // the turn here ended as stopped; the child is a thread of its own under this one, on the same engine, and runs
    expect(ctx.agent.store.runs(project.id, parent.id).at(-1)?.status).toBe("cancelled");
    const child = ctx.agent.store.thread(project.id, childId)!;
    expect(child).toMatchObject({ parentId: parent.id, engine: "coder", title: "Dedupe chat · writing code", boardId: null, itemId: null });
    expect(ctx.agent.activeRuns().map((a) => a.run.id)).toEqual([runId]);
    // this conversation says so, pointing at the child
    const moved = notesFor(ctx.agent.thread(project.id, parent.id).messages, childId);
    expect(moved).toHaveLength(1);
    expect(moved[0].block.text).toContain("Moved the coding to the background");
    // the child opened on what was said and done here, the step that was under way included
    await expect.poll(() => openers.length).toBe(1);
    expect(openers[0]).toContain("User: write a dedupe script");
    expect(openers[0]).toContain("Step: did write_file → a.ts");
    // this conversation takes a message at once, the child still running
    const next = ctx.agent.send(project.id, parent.id, { kind: "text", text: "anything else?" });
    await expect.poll(() => ctx.agent.store.run(project.id, next.runId)?.status).toBe("done");
    expect(ctx.agent.activeRuns().map((a) => a.run.id)).toEqual([runId]);
    // the child's conclusion lands here once it finishes, and once
    gates.get("child")!();
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).toBe("done");
    const notes = notesFor(ctx.agent.thread(project.id, parent.id).messages, childId);
    expect(notes).toHaveLength(2);
    expect(notes[1].block.text).toBe("The background conversation “Dedupe chat · writing code” finished: Done: b.ts written, 3 tests pass.");
    expect(ctx.agent.thread(project.id, parent.id).messages.at(-1)?.id).toBe(notes[1].id);
  } finally { await done(); }
});

it("says in the parent when the child stopped on an error or was stopped, each once", async () => {
  const { ctx, project, gates, done } = await setup();
  try {
    const parent = ctx.agent.newThread(project.id, "coder", null, { title: "Chat" });
    ctx.agent.send(project.id, parent.id, { kind: "text", text: "write it" });
    await expect.poll(() => ctx.agent.thread(project.id, parent.id).messages.some((m) => m.block.type === "trace")).toBe(true);
    const { threadId: childId, runId } = await ctx.agent.toBackground(project.id, parent.id);
    await expect.poll(() => gates.has("child")).toBe(true);
    ctx.agent.cancel(runId);
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).toBe("cancelled");
    const notes = notesFor(ctx.agent.thread(project.id, parent.id).messages, childId);
    expect(notes.map((n) => n.block.text)).toEqual([expect.stringContaining("Moved the coding"), "The background conversation “Chat · writing code” was stopped before it finished."]);
  } finally { await done(); }
});

it("after the app closed mid-run, the interruption is the child's conclusion, written to the parent once at the next start", async () => {
  const { ctx, project, done } = await setup();
  try {
    const store = ctx.agent.store;
    const parent = store.createThread(project.id, "coder", "Chat");
    const child = store.createThread(project.id, "coder", "Chat · writing code", null, null, null, "assistant", parent.id);
    store.beginRun(project.id, child.id, "coder");
    store.reconcileInterrupted(project.id, "Interrupted.", (title) => `Background “${title}” was interrupted.`);
    store.reconcileInterrupted(project.id, "Interrupted.", (title) => `Background “${title}” was interrupted.`);
    expect(store.messages(project.id, child.id).map((m) => m.block.type === "note" && m.block.text)).toEqual(["Interrupted."]);
    const notes = notesFor(store.messages(project.id, parent.id), child.id);
    expect(notes.map((n) => n.block.text)).toEqual(["Background “Chat · writing code” was interrupted."]);
  } finally { await done(); }
});
