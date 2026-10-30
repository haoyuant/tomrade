/** A run still driven in this process is never taken for one the app's closing cut short (TOM-833). */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, type Block, type Engine, type ThreadMessage } from "@tomradex/agent";

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-live-run-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }]] });
  let agent = ctx.plugin(Agent, { mediaDir: path.join(dir, "media") });
  await settle();
  // A turn that goes on until it is let go or stopped, as a coding agent's does.
  const turns: { aborted: () => boolean; release: () => void }[] = [];
  const engine: Engine = {
    id: "coder",
    title: "Coder",
    author: "ai:coder",
    available: async () => ({ ok: true }),
    async turn(_input, io) {
      io.emit({ type: "text", text: "Working." });
      await new Promise<void>((resolve) => {
        turns.push({ aborted: () => io.signal.aborted, release: resolve });
        io.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { stop: "end" };
    }
  };
  ctx.agent.engine(engine);
  const restart = async () => {
    await agent.dispose();
    agent = ctx.plugin(Agent, { mediaDir: path.join(dir, "media") });
    await settle();
    ctx.agent.engine(engine);
  };
  const changed: string[] = [];
  ctx.on("agent/interrupted-changed", (_projectId, threadId) => void changed.push(threadId));
  const done = async () => {
    await ctx.fiber.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  return { ctx, project, turns, restart, changed, done };
}

const notes = (messages: ThreadMessage[]) => messages.flatMap((m) => (m.block.type === "note" ? [m.block as Extract<Block, { type: "note" }>] : []));

it("leaves a run going on when its project file is opened again, and takes the next message once it ends", async () => {
  const { ctx, project, turns, changed, done } = await setup();
  try {
    const thread = ctx.agent.newThread(project.id, "coder", null, { title: "Dedupe" });
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    await expect.poll(() => turns.length).toBe(1);

    ctx.emit("db/opened", project.id);
    expect(ctx.agent.store.run(project.id, runId)).toMatchObject({ status: "running" });
    expect(notes(ctx.agent.thread(project.id, thread.id).messages)).toEqual([]);
    expect(ctx.agent.store.interruptedThreads(project.id)).toEqual([]);
    expect(changed).toEqual([]);

    turns[0]!.release();
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).toBe("done");
    const next = ctx.agent.send(project.id, thread.id, { kind: "text", text: "again" });
    await expect.poll(() => turns.length).toBe(2);
    turns[1]!.release();
    await expect.poll(() => ctx.agent.store.run(project.id, next.runId)?.status).toBe("done");
  } finally { await done(); }
});

it("an assistant torn down mid-run stops the run and settles it; the next one adds nothing and takes the next message", async () => {
  const { ctx, project, turns, restart, changed, done } = await setup();
  try {
    const thread = ctx.agent.newThread(project.id, "coder", null, { title: "Dedupe" });
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    await expect.poll(() => turns.length).toBe(1);

    await restart();
    expect(turns[0]!.aborted()).toBe(true);
    // the old instance's turn returning afterwards writes nothing over the settled run
    await settle();
    const interrupted = "Interrupted — the assistant was restarted or switched off while this run was in progress.";
    expect(ctx.agent.store.run(project.id, runId)).toMatchObject({ status: "cancelled", stop: "interrupted", error: interrupted });
    expect(notes(ctx.agent.thread(project.id, thread.id).messages)).toEqual([{ type: "note", text: interrupted, interrupted: true }]);
    expect(changed).toEqual([thread.id]);
    expect(ctx.agent.activeRuns()).toEqual([]);

    const { runId: next } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go on" });
    await expect.poll(() => turns.length).toBe(2);
    turns[1]!.release();
    await expect.poll(() => ctx.agent.store.run(project.id, next)?.status).toBe("done");
  } finally { await done(); }
});

it("still settles a run nobody drives when the file is opened, next to one that is driven", async () => {
  const { ctx, project, turns, done } = await setup();
  try {
    const live = ctx.agent.newThread(project.id, "coder", null, { title: "Live" });
    const left = ctx.agent.newThread(project.id, "coder", null, { title: "Left" });
    const { runId } = ctx.agent.send(project.id, live.id, { kind: "text", text: "go" });
    await expect.poll(() => turns.length).toBe(1);
    const orphan = ctx.agent.store.beginRun(project.id, left.id, "coder");

    ctx.emit("db/opened", project.id);
    expect(ctx.agent.store.run(project.id, runId)?.status).toBe("running");
    expect(ctx.agent.store.run(project.id, orphan.id)).toMatchObject({ status: "cancelled", stop: "interrupted" });
    turns[0]!.release();
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).toBe("done");
  } finally { await done(); }
});
