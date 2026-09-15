import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Agent, promptSections, type TurnInput } from "@tomrade/agent";
import { Tools } from "@tomrade/tools";
import { Settings } from "@tomrade/settings";
import { fresh, settle } from "@tomrade/testkit";

it("honors the ticket method and serializes human takeover against restart", async () => {
  const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: path.join(os.tmpdir(), `general-settings-${crypto.randomUUID()}.json`) }], Agent] });
  await settle();
  let entered = false;
  let release!: () => void;
  const finishing = new Promise<void>(resolve => { release = resolve; });
  ctx.agent.engine({ id: "takeover-test", title: "Takeover test", author: "ai:test", capabilities: ["general"], available: async () => ({ ok: true }), async turn(_input, io) {
    entered = true;
    if (!io.signal.aborted) await new Promise<void>(resolve => io.signal.addEventListener("abort", () => resolve(), { once: true }));
    await finishing;
    return { stop: "end" };
  } });
  try {
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Draft a document", workType: "general", playbookId: "document.write", by: "human" });
    expect(items.get(project.id, item.id)?.playbookId).toBe("document.write");
    await expect(ctx.agent.startGeneral(project.id, item.id)).rejects.toThrow("files.write");
    const disposeCapability = ctx.agent.capability("files.write");
    const started = await ctx.agent.startGeneral(project.id, item.id);
    await expect.poll(() => entered).toBe(true);
    expect(ctx.agent.store.run(project.id, started.runId)?.execution?.playbook.id).toBe("document.write");
    const takeover = ctx.agent.takeoverGeneral(project.id, item.id);
    await expect(ctx.agent.startGeneral(project.id, item.id)).rejects.toThrow("already starting");
    expect(() => ctx.agent.send(project.id, started.threadId, { kind: "text", text: "Restart through the conversation" })).toThrow("takeover is in progress");
    release();
    expect(await takeover).toEqual({ stopped: 1 });
    expect(ctx.agent.store.run(project.id, started.runId)?.status).toBe("cancelled");
    expect(items.get(project.id, item.id)?.status).toBe("doing");
    disposeCapability();
  } finally {
    release();
    await ctx.fiber.dispose();
  }
});

it("executes and resumes general work without Git, preserves its method, and does not equate engine success with acceptance", async () => {
  const world = await fresh({ plugins: [Tools, [Settings, { path: path.join(os.tmpdir(), `general-settings-${crypto.randomUUID()}.json`) }], Agent] });
  await settle();
  const { ctx, items, project, board } = world;
  const turns: TurnInput[] = [];
  const prompts: string[] = [];
  ctx.agent.engine({ id: "general-test", title: "General test", author: "ai:test", capabilities: ["general"], available: async () => ({ ok: true }), async turn(input, io) {
    turns.push(input);
    prompts.push(promptSections(input, io).join("\n"));
    await io.tools.execute("open_playbook", { id: "task.assist" });
    fs.writeFileSync(path.join(input.cwd!, "draft.txt"), "Prepared instructions");
    if (turns.length === 2) await io.tools.execute("submit_delivery", { id: input.ticket!.id, submission: { report: "Prepared workshop instructions; a human must arrange the venue", artifactIds: [] } });
    return { stop: "end" };
  } });
  const item = items.create({ projectId: project.id, boardId: board.id, title: "Prepare the offline workshop", body: "Produce a preparation checklist", workType: "general", by: "human" });
  const wait = async (runId: string) => {
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).not.toBe("running");
    return ctx.agent.store.run(project.id, runId)!;
  };
  await expect(ctx.agent.startGeneral(project.id, item.id, { playbook: "document.write" })).rejects.toThrow("files.write");
  expect(items.deliveries.list(project.id, item.id)).toEqual([]);
  const first = await ctx.agent.startGeneral(project.id, item.id);
  expect((await wait(first.runId)).status).toBe("done");
  expect(ctx.agent.store.run(project.id, first.runId)?.playbooks).toMatchObject([{ id: "task.assist", source: "plugin", digest: expect.any(String), body: expect.any(String) }]);
  expect(items.get(project.id, item.id)?.status).toBe("doing");
  expect(turns[0]).toMatchObject({ purpose: "general", ticket: { workType: "general", branch: null }, execution: { playbook: { id: "task.assist", source: "plugin" } } });
  expect(turns[0].workdir).toBeUndefined();
  expect(fs.existsSync(path.join(turns[0].cwd!, "draft.txt"))).toBe(true);
  expect(prompts[0]).not.toContain("Code conventions:");
  expect(prompts[0]).toContain("A successful agent turn does not complete a ticket");
  const resumed = await ctx.agent.startGeneral(project.id, item.id);
  expect(resumed).toMatchObject({ continued: true, threadId: first.threadId });
  expect((await wait(resumed.runId)).status).toBe("done");
  expect(turns[1].cwd).toBe(turns[0].cwd);
  expect(turns[1].execution).toEqual(turns[0].execution);
  expect(ctx.agent.store.run(project.id, first.runId)?.execution).toEqual(turns[0].execution);
  expect(items.get(project.id, item.id)?.status).toBe("verifying");
  expect(items.get(project.id, item.id)?.evidence.submissions.at(-1)?.submittedBy).toBe("ai:test");
  items.update(project.id, item.id, { status: "done" }, "human");
  await expect(ctx.agent.startGeneral(project.id, item.id)).rejects.toThrow("Reopen");
  items.update(project.id, item.id, { status: "todo" }, "human");
  const next = await ctx.agent.startGeneral(project.id, item.id);
  expect(next.threadId).not.toBe(first.threadId);
  expect((await wait(next.runId)).status).toBe("done");
  expect(turns[2].cwd).not.toBe(turns[0].cwd);
  const old = ctx.agent.send(project.id, first.threadId, { kind: "text", text: "Continue old work" });
  expect((await wait(old.runId)).status).toBe("error");
  expect(turns).toHaveLength(3);
  await ctx.fiber.dispose();
});
