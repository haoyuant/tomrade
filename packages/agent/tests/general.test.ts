import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Agent, generalPrompt, promptSections, type TurnInput } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";

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

it("prepares a delivery for a terminal agent, and puts the knobs picked at Start on the thread", async () => {
  const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: path.join(os.tmpdir(), `general-settings-${crypto.randomUUID()}.json`) }], Agent] });
  await settle();
  const turns: TurnInput[] = [];
  ctx.agent.engine({ id: "knobs-test", title: "Knobs test", author: "ai:test", capabilities: ["general"], available: async () => ({ ok: true }), async turn(input) {
    turns.push(input);
    return { stop: "end" };
  } });
  try {
    ctx.settings.set({ ...ctx.settings.get(), agent: { defaultEngine: "knobs-test", confirmWritesOver: 0, engines: { "knobs-test": { model: "sonnet", effort: "low" } }, playbookChoices: {} } });
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Prepare the offline workshop", workType: "general", by: "human" });
    const prepared = await ctx.agent.prepareGeneral(project.id, item.id, { options: { effort: "high" }, surface: "code" });
    expect(prepared).toMatchObject({ continued: false, engine: "knobs-test", playbook: { id: "task.assist", source: "plugin" } });
    expect(prepared.opener).toBe(`Work on ${item.key}: Prepare the offline workshop. Follow the selected delivery playbook and submit results for review.`);
    expect(prepared.prompt).toContain(prepared.opener);
    expect(prepared.prompt).toContain("You are delivering");
    expect(prepared.prompt).toContain(`Working directory: ${prepared.cwd}`);
    expect(prepared.prompt).toContain("Selected playbook task.assist");
    expect(ctx.agent.store.thread(project.id, prepared.threadId)).toMatchObject({ surface: "code", options: { effort: "high" }, execution: { playbook: { id: "task.assist" } } });
    // Nothing ran: the terminal agent is the user's own process.
    expect(ctx.agent.store.messages(project.id, prepared.threadId)).toEqual([]);
    expect(items.get(project.id, item.id)).toMatchObject({ status: "doing", playbookId: "task.assist" });

    // Starting headless on the same delivery continues the thread; the turn sees settings with the overrides on top.
    const started = await ctx.agent.startGeneral(project.id, item.id, { options: { model: "opus" } });
    expect(started).toMatchObject({ continued: true, threadId: prepared.threadId });
    await expect.poll(() => ctx.agent.store.run(project.id, started.runId)?.status).not.toBe("running");
    expect(turns[0]?.options).toEqual({ model: "opus", effort: "low" });
    expect(ctx.agent.store.thread(project.id, prepared.threadId)?.surface).toBe("assistant");
    expect(ctx.agent.setOptions(project.id, prepared.threadId, null).options).toBeNull();
    expect(ctx.agent.optionsOf(ctx.agent.store.thread(project.id, prepared.threadId)!, "knobs-test")).toEqual({ model: "sonnet", effort: "low" });
  } finally {
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

it("starts ahead of open dependencies only when asked to, tells the agent, and never stops a delivery for them", async () => {
  const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: path.join(os.tmpdir(), `general-settings-${crypto.randomUUID()}.json`) }], Agent] });
  await settle();
  const turns: TurnInput[] = [];
  ctx.agent.engine({ id: "deps-test", title: "Deps test", author: "ai:test", capabilities: ["general"], available: async () => ({ ok: true }), async turn(input) {
    turns.push(input);
    return { stop: "end" };
  } });
  try {
    ctx.settings.set({ ...ctx.settings.get(), agent: { defaultEngine: "deps-test", confirmWritesOver: 0, engines: {}, playbookChoices: {} } });
    const data = items.create({ projectId: project.id, boardId: board.id, title: "Collect the sales figures", workType: "general", by: "human" });
    const report = items.create({ projectId: project.id, boardId: board.id, title: "Write the quarterly report", workType: "general", by: "human" });
    items.update(project.id, data.id, { blocks: [report.id] }, "human");

    await expect(ctx.agent.prepareGeneral(project.id, report.id)).rejects.toThrow(`${report.key} waits on ${data.key}`);
    const prepared = await ctx.agent.prepareGeneral(project.id, report.id, { allowBlocked: true });
    expect(prepared.prompt).toContain(`Waits on (still open): ${data.key} Collect the sales figures (backlog)`);

    // A dependency added while the work is under way is news for the agent, not a reason to refuse the next turn.
    const review = items.create({ projectId: project.id, boardId: board.id, title: "Get the numbers reviewed", workType: "general", by: "human" });
    items.update(project.id, review.id, { blocks: [report.id] }, "human");
    const { runId } = ctx.agent.send(project.id, prepared.threadId, { kind: "text", text: "Draft what you can" });
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).toBe("done");
    expect(turns.at(-1)?.ticket?.waitsOn?.map((d) => d.key)).toEqual([data.key, review.key]);
    expect(promptSections(turns.at(-1)!, { playbooks: { index: () => [], open: () => null } } as never, { playbooks: false }).join("\n")).toContain(`${review.key} Get the numbers reviewed (backlog)`);

    items.update(project.id, data.id, { status: "done" }, "human");
    const next = ctx.agent.send(project.id, prepared.threadId, { kind: "text", text: "The figures are in" });
    await expect.poll(() => ctx.agent.store.run(project.id, next.runId)?.status).toBe("done");
    expect(turns.at(-1)?.ticket?.waitsOn?.map((d) => d.key)).toEqual([review.key]);
  } finally {
    await ctx.fiber.dispose();
  }
});

it("refuses an agent closing a General delivery an agent ran, while a person still can", async () => {
  const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: path.join(os.tmpdir(), `general-settings-${crypto.randomUUID()}.json`) }], Agent] });
  await settle();
  ctx.agent.engine({ id: "close-test", title: "Close test", author: "ai:test", capabilities: ["general"], available: async () => ({ ok: true }), async turn() {
    return { stop: "end" };
  } });
  try {
    const item = items.create({ projectId: project.id, boardId: board.id, title: "Plan the team offsite", workType: "general", by: "human" });
    await ctx.agent.prepareGeneral(project.id, item.id, { engine: "close-test" });
    expect(() => items.update(project.id, item.id, { status: "done" }, "ai:loop")).toThrow("human acceptance");
    expect(items.update(project.id, item.id, { status: "done" }, "human").status).toBe("done");
  } finally {
    await ctx.fiber.dispose();
  }
});

it("tells a delivery that its description's tomrade-file links are files get_item lists, and only when there are some", () => {
  const playbook = { id: "general.deliver", source: "builtin", digest: "x", body: "Deliver." } as Parameters<typeof generalPrompt>[0]["playbook"];
  const brief = (body: string) => generalPrompt({ ticket: { key: "TOM-1", title: "Poster", body }, cwd: "/tmp", playbook, continued: false });
  expect(brief("Use ![logo](tomrade-file://0f1e2d3c-4b5a-4968-8776-655443322110)")).toContain("get_item lists them under attachments");
  expect(brief("Plain words")).not.toContain("tomrade-file");
});
