/** Steering: a message sent while a turn runs reaches the model inside that turn, where it is placed in the transcript. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, type MediaRef, type SteerInput } from "@tomradex/agent";
import { fakeChat, type ChatEvent, type ChatModel, type ChatRequest } from "@tomradex/llm";
import loop from "@tomradex/engine-loop";

const PICTURE = { name: "shot.png", mime: "image/png", base64: Buffer.from("a picture").toString("base64") };

async function setup(steps: ((steer: () => void) => ChatEvent[])[], mediaInput?: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-steer-"));
  const requests: ChatRequest[] = [];
  let step = 0;
  let steer = () => {};
  const model: ChatModel = {
    capabilities: { tools: true, streaming: true, json: true, ...(mediaInput ? { mediaInput } : {}) },
    async *chat(request) {
      requests.push(structuredClone(request));
      for (const ev of steps[step++]?.(steer) ?? [{ type: "stop", reason: "end" }]) yield ev;
    }
  };
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop] });
  const thread = ctx.agent.newThread(project.id, "loop");
  const taken: Promise<boolean>[] = [];
  const files: MediaRef[] = [];
  steer = () => void taken.push(ctx.agent.steer(project.id, thread.id, "s1", "make it blue", files));
  const done = async () => {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { ctx, project, thread, requests, taken, files, done };
}

const userTexts = (request: ChatRequest) =>
  request.messages.filter((m) => m.role === "user").flatMap((m) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])));

it("hands a message sent mid-turn to the model after the running tool, in the same run", async () => {
  const { ctx, project, thread, requests, taken, done } = await setup([
    (steer) => { steer(); return [{ type: "tool_call", id: "a", name: "list_items", args: {} }, { type: "stop", reason: "tool_use" }]; },
    () => [{ type: "text", delta: "blue it is" }, { type: "stop", reason: "end" }]
  ]);
  try {
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "paint it" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(await Promise.all(taken)).toEqual([true]);
    expect(requests).toHaveLength(2);
    expect(userTexts(requests[1]).at(-1)).toContain("make it blue");
    const blocks = ctx.agent.thread(project.id, thread.id).messages.map((m) => `${m.role}:${m.block.type}${m.block.type === "text" ? ":" + m.block.text : ""}`);
    expect(blocks).toEqual(["user:text:paint it", "agent:trace", "user:text:make it blue", "agent:text:blue it is"]);
    const steered = ctx.agent.thread(project.id, thread.id).messages.find((m) => m.block.type === "text" && m.block.steerId === "s1");
    expect(steered?.runId).toBe(run.runId);
    expect(ctx.agent.store.runs(project.id, thread.id)).toHaveLength(1);
  } finally { await done(); }
});

it("keeps the turn going when the message lands while the model writes its last reply", async () => {
  const { ctx, project, thread, requests, done } = await setup([
    (steer) => { steer(); return [{ type: "text", delta: "red, done" }, { type: "stop", reason: "end" }]; },
    () => [{ type: "text", delta: "blue instead" }, { type: "stop", reason: "end" }]
  ]);
  try {
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "paint it" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(requests).toHaveLength(2);
    expect(userTexts(requests[1]).at(-1)).toContain("make it blue");
    expect(ctx.agent.thread(project.id, thread.id).messages.map((m) => (m.block.type === "text" ? m.block.text : m.block.type))).toEqual(["paint it", "red, done", "make it blue", "blue instead"]);
  } finally { await done(); }
});

const pictures = (request: ChatRequest) => request.messages.at(-1)!.content.flatMap((b) => (b.type === "media" ? [b.media.name] : []));
const steeredLine = (ctx: Awaited<ReturnType<typeof setup>>["ctx"], projectId: string, threadId: string) =>
  ctx.agent.thread(projectId, threadId).messages.find((m) => m.block.type === "text" && m.block.steerId === "s1")?.block;

it("hands a picture sent mid-turn to the model with its words, in the same run", async () => {
  const { ctx, project, thread, requests, taken, files, done } = await setup([
    (steer) => { steer(); return [{ type: "tool_call", id: "a", name: "list_items", args: {} }, { type: "stop", reason: "tool_use" }]; },
    () => [{ type: "text", delta: "I see it" }, { type: "stop", reason: "end" }]
  ], ["image/png"]);
  try {
    files.push(ctx.agent.uploadMedia(project.id, thread.id, PICTURE));
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "paint it" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(await Promise.all(taken)).toEqual([true]);
    expect(pictures(requests[1])).toEqual(["shot.png"]);
    expect(requests[1].messages.at(-1)!.content.map((b) => b.type)).toEqual(["tool_result", "text", "media"]);
    expect(steeredLine(ctx, project.id, thread.id)).toMatchObject({ text: "make it blue", attachments: [{ name: "shot.png" }] });
  } finally { await done(); }
});

it("keeps the turn going for a picture that lands during the last reply", async () => {
  const { ctx, project, thread, requests, files, done } = await setup([
    (steer) => { steer(); return [{ type: "text", delta: "red, done" }, { type: "stop", reason: "end" }]; },
    () => [{ type: "text", delta: "blue instead" }, { type: "stop", reason: "end" }]
  ], ["image/png"]);
  try {
    files.push(ctx.agent.uploadMedia(project.id, thread.id, PICTURE));
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "paint it" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(pictures(requests[1])).toEqual(["shot.png"]);
  } finally { await done(); }
});

it("refuses a picture a model without eyes would never see, and leaves the words to the caller", async () => {
  const { ctx, project, thread, requests, taken, files, done } = await setup([
    (steer) => { steer(); return [{ type: "tool_call", id: "a", name: "list_items", args: {} }, { type: "stop", reason: "tool_use" }]; },
    () => [{ type: "text", delta: "ok" }, { type: "stop", reason: "end" }]
  ]);
  try {
    files.push(ctx.agent.uploadMedia(project.id, thread.id, PICTURE));
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "paint it" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(await Promise.all(taken)).toEqual([false]);
    expect(requests.flatMap((r) => r.messages).flatMap((m) => m.content).some((b) => b.type === "media")).toBe(false);
    expect(steeredLine(ctx, project.id, thread.id)).toBeUndefined();
  } finally { await done(); }
});

it("forwards a picture to an agent that says it takes them, and to no other", async () => {
  const { ctx, project, thread, done } = await setup([]);
  const ready = new Set<string>();
  const steerable = (id: string, takesMedia: boolean, got: SteerInput[]) => ctx.agent.engine({
    id, title: id, author: `ai:${id}`, steering: "forward", media: () => ({ input: ["image/png"], output: [] }), available: async () => ({ ok: true }),
    turn: async (_input, io) => {
      if (takesMedia) io.steersMedia?.();
      io.steerTo?.(async (steer) => { got.push(steer); io.steered?.(steer.id); return true; });
      ready.add(id);
      while (!got.length && !stop) await new Promise((r) => setTimeout(r, 10));
      return { stop: "end" };
    }
  });
  let stop = false;
  try {
    const got: SteerInput[] = [];
    steerable("sees", true, got);
    ctx.agent.setEngine(project.id, thread.id, "sees");
    const file = ctx.agent.uploadMedia(project.id, thread.id, PICTURE);
    let run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    await expect.poll(() => ctx.agent.steer(project.id, thread.id, "s1", "", [file])).toBe(true);
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(got).toMatchObject([{ id: "s1", text: "", media: [{ name: "shot.png", base64: PICTURE.base64 }] }]);
    expect(steeredLine(ctx, project.id, thread.id)).toMatchObject({ text: "", attachments: [{ name: "shot.png" }] });

    const blind: SteerInput[] = [];
    steerable("blind", false, blind);
    ctx.agent.setEngine(project.id, thread.id, "blind");
    run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    await expect.poll(() => ready.has("blind")).toBe(true);
    expect(await ctx.agent.steer(project.id, thread.id, "s2", "look", [file])).toBe(false);
    expect(blind).toEqual([]);
    expect(await ctx.agent.steer(project.id, thread.id, "s3", "just words")).toBe(true);
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
  } finally { stop = true; await done(); }
});

it("refuses a message when nothing runs or the engine cannot be steered", async () => {
  const { ctx, project, thread, done } = await setup([]);
  try {
    expect(await ctx.agent.steer(project.id, thread.id, "x", "hello")).toBe(false);
    ctx.agent.engine({ id: "still", title: "Still", author: "ai:still", available: async () => ({ ok: true }), turn: async (_input, io) => { await new Promise((r) => setTimeout(r, 200)); io.emit({ type: "text", text: "ok" }); return { stop: "end" }; } });
    ctx.agent.setEngine(project.id, thread.id, "still");
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    expect(await ctx.agent.steer(project.id, thread.id, "y", "hello")).toBe(false);
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect((await ctx.agent.engineViews()).find((e) => e.id === "loop")?.steers).toBe(true);
  } finally { await done(); }
});

it("tells the model not to repeat a reply the person has already read", async () => {
  const { ctx, project, thread, requests, done } = await setup([
    (steer) => { steer(); return [{ type: "text", delta: "red, done" }, { type: "stop", reason: "end" }]; },
    () => [{ type: "text", delta: "and blue" }, { type: "stop", reason: "end" }]
  ]);
  try {
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "paint it" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(userTexts(requests[1]).at(-1)).toMatch(/already on the user's screen.*do not repeat it/s);
  } finally { await done(); }
});

it("adds no such note to a message taken between tool steps", async () => {
  const { ctx, project, thread, requests, done } = await setup([
    (steer) => { steer(); return [{ type: "tool_call", id: "a", name: "list_items", args: {} }, { type: "stop", reason: "tool_use" }]; },
    () => [{ type: "text", delta: "blue it is" }, { type: "stop", reason: "end" }]
  ]);
  try {
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "paint it" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(userTexts(requests[1]).at(-1)).not.toMatch(/already on the user's screen/);
  } finally { await done(); }
});
