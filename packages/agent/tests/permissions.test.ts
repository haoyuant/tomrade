import { expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent } from "@tomradex/agent";

it("queues live permissions, rejects stale responses, resumes the same run and cancels without approval", async () => {
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: `/tmp/tomrade-permission-${Date.now()}.json` }], Agent] });
  await settle();
  const answers: (string | null)[] = [];
  ctx.agent.engine({ id: "permissions", title: "Permissions", author: "ai:test", available: async () => ({ ok: true }),
    async turn(_input, io) {
      const one = io.requestPermission!("Read file?", ["Allow once", "Deny"]);
      const two = io.requestPermission!("Run command?", ["Allow once", "Deny"]);
      answers.push(await one, await two);
      return { stop: io.signal.aborted ? "cancelled" : "end" };
    } });
  try {
    const thread = ctx.agent.newThread(project.id, "permissions");
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    await expect.poll(() => ctx.agent.thread(project.id, thread.id).pending?.question.text).toBe("Read file?");
    const question = ctx.agent.thread(project.id, thread.id).pending!.question;
    expect(ctx.agent.store.run(project.id, runId)?.status).toBe("running");
    expect(() => ctx.agent.send(project.id, thread.id, { kind: "answer", questionId: "stale", value: "Allow once" })).toThrow();
    expect(ctx.agent.send(project.id, thread.id, { kind: "answer", questionId: question.id, value: "Deny" })).toEqual({ runId });
    await expect.poll(() => ctx.agent.thread(project.id, thread.id).pending?.question.text).toBe("Run command?");
    expect(() => ctx.agent.send(project.id, thread.id, { kind: "answer", questionId: question.id, value: "Allow once" })).toThrow();
    ctx.agent.cancel(runId);
    await expect.poll(() => answers).toEqual(["Deny", null]);
    expect(ctx.agent.thread(project.id, thread.id).pending).toBeNull();
    expect(ctx.agent.store.runs(project.id, thread.id)).toHaveLength(1);
  } finally { await ctx.fiber.dispose(); }
});

it("stores modes per coding thread and applies a change on the next turn without relabeling the active run", async () => {
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: `/tmp/tomrade-modes-${Date.now()}.json` }], Agent] });
  await settle();
  const seen: (string | undefined)[] = [];
  ctx.agent.engine({ id: "modes", title: "Modes", author: "ai:test", available: async () => ({ ok: true }),
    permissionModes: { default: "full", choices: [{ value: "full", label: "Full" }, { value: "local", label: "Local" }] },
    async turn(input, io) {
      seen.push(input.permissionMode);
      await io.requestPermission!("Continue?", ["Allow once", "Deny"]);
      return { stop: "end" };
    } });
  try {
    const thread = ctx.agent.newThread(project.id, "modes", null, { itemId: "ticket" });
    const other = ctx.agent.newThread(project.id, "modes", null, { itemId: "other" });
    const first = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    await expect.poll(() => ctx.agent.thread(project.id, thread.id).pending?.kind).toBe("permission");
    expect(seen).toEqual(["full"]);
    expect(() => ctx.agent.setPermissionMode(project.id, thread.id, "invalid")).toThrow();
    ctx.agent.setPermissionMode(project.id, thread.id, "local");
    expect(ctx.agent.thread(project.id, thread.id)).toMatchObject({ activePermissionMode: "full", thread: { permissionMode: "local" } });
    expect(ctx.agent.thread(project.id, other.id).thread.permissionMode).toBeNull();
    ctx.agent.cancel(first.runId);
    await expect.poll(() => ctx.agent.store.run(project.id, first.runId)?.status).not.toBe("running");
    const second = ctx.agent.send(project.id, thread.id, { kind: "text", text: "again" });
    await expect.poll(() => seen).toEqual(["full", "local"]);
    ctx.agent.cancel(second.runId);
    await expect.poll(() => ctx.agent.store.run(project.id, second.runId)?.status).not.toBe("running");
  } finally { await ctx.fiber.dispose(); }
});

it("starts the main conversation in the engine's default, and lets the person change it there too", async () => {
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: `/tmp/tomrade-main-modes-${Date.now()}.json` }], Agent] });
  await settle();
  const seen: (string | undefined)[] = [];
  ctx.agent.engine({ id: "main-modes", title: "Main modes", author: "ai:test", available: async () => ({ ok: true }),
    permissionModes: { default: "full", choices: [{ value: "full", label: "Full" }, { value: "ask", label: "Ask" }] },
    async turn(input) { seen.push(input.permissionMode); return { stop: "end" }; } });
  try {
    const main = ctx.agent.newThread(project.id, "main-modes");
    const ticket = ctx.agent.newThread(project.id, "main-modes", null, { itemId: "ticket" });
    const run = async (threadId: string) => {
      const { runId } = ctx.agent.send(project.id, threadId, { kind: "text", text: "go" });
      await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).not.toBe("running");
    };
    await run(main.id);
    await run(ticket.id);
    expect(seen).toEqual(["full", "full"]);
    ctx.agent.setPermissionMode(project.id, main.id, "ask");
    await run(main.id);
    expect(seen.at(-1)).toBe("ask");
  } finally { await ctx.fiber.dispose(); }
});

it("stops the run's wall clock while a permission waits, and restarts it after the answer", async () => {
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: `/tmp/tomrade-wall-${Date.now()}.json` }], [Agent, { maxWallMs: 10_000 }]] });
  await settle();
  const answers: (string | null)[] = [];
  ctx.agent.engine({ id: "slow-human", title: "Slow human", author: "ai:test", available: async () => ({ ok: true }),
    async turn(_input, io) {
      answers.push(await io.requestPermission!("Run it?", ["Allow once", "Deny"], io.signal));
      await new Promise<void>((resolve) => io.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { stop: "cancelled" };
    } });
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
    expect(cond()).toBe(true);
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const thread = ctx.agent.newThread(project.id, "slow-human");
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    await until(() => ctx.agent.thread(project.id, thread.id).pending?.kind === "permission");
    vi.advanceTimersByTime(60_000);
    await new Promise((r) => setImmediate(r));
    const question = ctx.agent.thread(project.id, thread.id).pending!.question;
    expect(ctx.agent.store.run(project.id, runId)?.status).toBe("running");
    ctx.agent.send(project.id, thread.id, { kind: "answer", questionId: question.id, value: "Allow once" });
    await until(() => answers.length === 1);
    vi.advanceTimersByTime(9_000);
    await new Promise((r) => setImmediate(r));
    expect(ctx.agent.store.run(project.id, runId)?.status).toBe("running");
    vi.advanceTimersByTime(2_000);
    await until(() => ctx.agent.store.run(project.id, runId)?.status === "cancelled");
    expect(answers).toEqual(["Allow once"]);
  } finally {
    vi.useRealTimers();
    await ctx.fiber.dispose();
  }
});
