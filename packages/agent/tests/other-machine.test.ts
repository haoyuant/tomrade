/** A run another machine drives arrives with the project's sync: this machine shows it, never settles it, and goes on only once it took over. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-other-machine-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }]] });
  ctx.agent.engine({
    id: "coder",
    title: "Coder",
    author: "ai:coder",
    available: async () => ({ ok: true }),
    async turn(_input, io) {
      io.emit({ type: "text", text: "On it." });
      return { stop: "end" };
    }
  });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  (ctx as unknown as { provide(name: string, value: unknown): void }).provide("ipc", {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    send: () => {}
  });
  await expect.poll(() => handlers.has("agent.takeOver")).toBe(true);
  // what a sync brings in: the run stamped with the machine that drives it
  const fromOtherMachine = (runId: string) => ctx.db.for(project.id).prepare("UPDATE plugin_agent_runs SET device = ? WHERE id = ?").run("other-machine", runId);
  const done = async () => {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { ctx, project, handlers, fromOtherMachine, done };
}

it("settles this machine's runs left running, and leaves another machine's going", async () => {
  const { ctx, project, fromOtherMachine, done } = await setup();
  try {
    const store = ctx.agent.store;
    const ours = store.createThread(project.id, "coder", "Here");
    const theirs = store.createThread(project.id, "coder", "There");
    const ourRun = store.beginRun(project.id, ours.id, "coder");
    const theirRun = store.beginRun(project.id, theirs.id, "coder");
    fromOtherMachine(theirRun.id);
    expect(store.run(project.id, ourRun.id)?.elsewhere).toBeUndefined();
    expect(store.run(project.id, theirRun.id)?.elsewhere).toBe(true);

    expect(store.reconcileInterrupted(project.id, "Interrupted.")).toEqual([ours.id]);
    expect(store.run(project.id, ourRun.id)).toMatchObject({ status: "cancelled", stop: "interrupted" });
    expect(store.run(project.id, theirRun.id)).toMatchObject({ status: "running", elsewhere: true });
    expect(store.messages(project.id, theirs.id)).toEqual([]);
  } finally {
    await done();
  }
});

it("refuses to send into a conversation another machine runs until it is taken over here", async () => {
  const { ctx, project, handlers, fromOtherMachine, done } = await setup();
  try {
    const store = ctx.agent.store;
    const thread = store.createThread(project.id, "coder", "There");
    const theirRun = store.beginRun(project.id, thread.id, "coder");
    fromOtherMachine(theirRun.id);

    expect(() => ctx.agent.send(project.id, thread.id, { kind: "text", text: "go on" })).toThrow(/running on another machine/);
    expect(store.runs(project.id, thread.id)).toHaveLength(1);

    expect(handlers.get("agent.takeOver")!(project.id, thread.id)).toBe(true);
    expect(store.run(project.id, theirRun.id)).toMatchObject({ status: "cancelled", stop: "taken-over" });
    expect(store.run(project.id, theirRun.id)?.elsewhere).toBeUndefined();
    expect(store.messages(project.id, thread.id).map((m) => m.block)).toEqual([{ type: "note", text: "Stopped: the conversation was taken over from the machine running this turn." }]);
    expect(handlers.get("agent.takeOver")!(project.id, thread.id)).toBe(false);

    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go on" });
    await expect.poll(() => store.run(project.id, runId)?.status).toBe("done");
    expect(store.run(project.id, runId)?.elsewhere).toBeUndefined();
  } finally {
    await done();
  }
});
