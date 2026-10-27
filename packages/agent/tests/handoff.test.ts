/** A conversation's session held elsewhere: a plugin refuses the send with its reason, and the thread's warm runtime is closed for the other process. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-handoff-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }]] });
  const released: { projectId: string; threadId: string }[] = [];
  let release = () => {};
  let holding = false;
  ctx.agent.engine({
    id: "cli",
    title: "CLI",
    author: "ai:cli",
    available: async () => ({ ok: true }),
    async turn(input, io) {
      if (input.input.kind === "text" && input.input.text === "hold") await new Promise<void>((resolve) => { release = resolve; holding = true; io.signal.addEventListener("abort", () => resolve(), { once: true }); });
      io.emit({ type: "text", text: "ok" });
      return { stop: "end", resume: "cli-1" };
    },
    release: (thread) => void released.push(thread)
  });
  const done = async () => {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { ctx, project, released, held: () => holding, letGo: () => release(), done };
}

it("refuses a send with the reason a plugin gives, and takes it again once none does", async () => {
  const { ctx, project, done } = await setup();
  try {
    const thread = ctx.agent.newThread(project.id, "cli");
    let elsewhere: string | undefined = "This conversation goes on in a terminal; bring it back first.";
    const off = ctx.on("agent/before-send", (th) => (th.id === thread.id ? elsewhere : undefined));
    expect(() => ctx.agent.send(project.id, thread.id, { kind: "text", text: "hi" })).toThrow("This conversation goes on in a terminal; bring it back first.");
    expect(ctx.agent.activeRuns()).toEqual([]);
    elsewhere = undefined;
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "hi" });
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).toBe("done");
    off();
  } finally { await done(); }
});

it("closes the thread's warm runtime through its engine, and refuses to while a turn runs", async () => {
  const { ctx, project, released, held, letGo, done } = await setup();
  try {
    const thread = ctx.agent.newThread(project.id, "cli");
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "hold" });
    await expect.poll(held).toBe(true);
    expect(() => ctx.agent.releaseRuntime(project.id, thread.id)).toThrow("a run is in progress on this thread");
    expect(released).toEqual([]);
    letGo();
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).toBe("done");
    ctx.agent.releaseRuntime(project.id, thread.id);
    expect(released).toEqual([{ projectId: project.id, threadId: thread.id }]);
    expect(() => ctx.agent.releaseRuntime(project.id, "nope")).toThrow("unknown thread nope");
  } finally { await done(); }
});
