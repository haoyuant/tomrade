/**
 * Media output is asked for turn by turn: an ordinary turn carries none, and
 * make_media asks the thread's model for that one kind when it can make it.
 * A model that cannot, or turns the request down, hands it to another profile
 * that can (an Image API one for pictures), and a model that refused is not
 * asked again that turn. With nothing able to make it, the session says so.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { NativeMediaRefused, fakeChat, type ChatEvent, type ChatModel, type ChatRequest, type LlmService } from "@tomradex/llm";
import loop from "@tomradex/engine-loop";

type Reply = (request: ChatRequest, step: number) => ChatEvent[] | Error;

const recording = (mediaOutput: string[], reply: Reply, tools = true) => {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    capabilities: { tools, streaming: true, json: true, mediaOutput },
    async *chat(request: ChatRequest) {
      requests.push(request);
      const out = reply(request, requests.length - 1);
      if (out instanceof Error) throw out;
      yield* out;
    }
  };
  return { model, requests };
};

/** Profiles by id, the first being the thread's. */
const profiles = (models: Record<string, ChatModel>) => ({
  name: "fake-profiles",
  apply(ctx: Context) {
    const provide = (name: string, service: LlmService) =>
      ctx.provide(name, { ...service, forProfile: (id: string) => models[id], profiles: () => Object.keys(models).map((id) => ({ id, title: id })) });
    fakeChat(Object.values(models)[0]).apply({ provide } as unknown as Context);
  }
});

async function drive(models: Record<string, ChatModel>, text = "draw me a cat") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loop-media-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], profiles(models), [Agent, { mediaDir: path.join(root, "media") }], loop] });
  const thread = ctx.agent.newThread(project.id, "loop");
  const run = ctx.agent.send(project.id, thread.id, { kind: "text", text });
  await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).not.toBe("running");
  const status = ctx.agent.store.run(project.id, run.runId)?.status;
  const messages = ctx.agent.store.messages(project.id, thread.id);
  const notes = messages.flatMap((m) => (m.block.type === "note" ? [m.block.text] : []));
  const media = messages.flatMap((m) => (m.block.type === "media" ? [m.block.media.mime] : []));
  await ctx.fiber.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  return { status, notes, media };
}

const answer: ChatEvent[] = [{ type: "text", delta: "done" }, { type: "stop", reason: "end" }];
const png: ChatEvent[] = [{ type: "media", media: { name: "cat.png", mime: "image/png", base64: "aGVsbG8=" } }, { type: "stop", reason: "end" }];
const wav: ChatEvent[] = [{ type: "media", media: { name: "hi.wav", mime: "audio/wav", base64: "aGVsbG8=" } }, { type: "stop", reason: "end" }];
const make = (kind: string, id = kind): ChatEvent[] => [{ type: "tool_call", id, name: "make_media", args: { kind, prompt: "a cat" } }, { type: "stop", reason: "tool_use" }];
/** The tool results the agent read, in order. */
const results = (requests: ChatRequest[]) => requests.flatMap((r) => r.messages.at(-1)?.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])) ?? []);
const thread = (requests: ChatRequest[]) => requests.filter((r) => !r.mediaOutput);

it("sends no media request on an ordinary turn of a model that can make images and audio", async () => {
  const chat = recording(["image", "audio"], () => answer);
  const { status } = await drive({ omni: chat.model }, "hello");
  expect(status).toBe("done");
  expect(chat.requests).toHaveLength(1);
  expect(chat.requests[0].mediaOutput).toBeUndefined();
  expect((chat.requests[0].tools ?? []).map((t) => t.name)).toContain("make_media");
});

it("has the thread's own model make an image when it can, in a request of its own", async () => {
  const chat = recording(["image"], (request, step) => (request.mediaOutput ? png : step === 0 ? make("image") : answer));
  const { status, media, notes } = await drive({ omni: chat.model });
  expect(status).toBe("done");
  const asked = chat.requests.filter((r) => r.mediaOutput);
  expect(asked).toHaveLength(1);
  expect(asked[0].mediaOutput).toEqual(["image"]);
  expect(asked[0].tools).toBeUndefined();
  expect(media).toEqual(["image/png"]);
  expect(notes).toEqual([]);
  expect(results(chat.requests)[0]).toMatch(/^Shown in the conversation: cat\.png/);
});

it("goes to the image profile when the model refuses, and does not ask it again this turn; speech stays its own", async () => {
  const chat = recording(["image", "audio"], (request, step) =>
    request.mediaOutput?.includes("image") ? new NativeMediaRefused("modalities not supported") : request.mediaOutput ? wav : [make("image", "a"), make("image", "b"), make("audio", "c"), answer][thread(chat.requests).length - 1] ?? answer
  );
  const images = recording(["image"], () => png, false);
  const { status, media, notes } = await drive({ omni: chat.model, pictures: images.model });
  expect(status).toBe("done");
  expect(chat.requests.filter((r) => r.mediaOutput?.includes("image"))).toHaveLength(1);
  expect(chat.requests.filter((r) => r.mediaOutput?.includes("audio"))).toHaveLength(1);
  expect(images.requests).toHaveLength(2);
  expect(images.requests[0].messages.at(-1)?.content).toEqual([{ type: "text", text: "a cat" }]);
  expect(media).toEqual(["image/png", "image/png", "audio/wav"]);
  expect(notes).toEqual(["The model turned down making images itself here, so for the rest of this turn it is not asked to again."]);
});

it("hands a picture on a text-only model (DeepSeek) straight to the image profile", async () => {
  const chat = recording([], (_request, step) => (step === 0 ? make("image") : answer));
  const images = recording(["image"], () => png, false);
  const { status, media, notes } = await drive({ deepseek: chat.model, pictures: images.model });
  expect(status).toBe("done");
  expect(chat.requests.every((r) => !r.mediaOutput)).toBe(true);
  expect(images.requests).toHaveLength(1);
  expect(images.requests[0].mediaOutput).toEqual(["image"]);
  expect(media).toEqual(["image/png"]);
  expect(notes).toEqual([]);
});

it("says in plain words when nothing can make it, and the agent answers in words", async () => {
  const chat = recording([], (_request, step) => (step === 0 ? make("image") : answer));
  const { status, media, notes } = await drive({ deepseek: chat.model });
  expect(status).toBe("done");
  expect(media).toEqual([]);
  expect(notes).toEqual(["None of your models can make images. To get pictures, add a model profile with the OpenAI Images API in Settings → Assistant."]);
  expect(results(chat.requests)[0]).toMatch(/^ERROR: no model profile here can make images/);
});
