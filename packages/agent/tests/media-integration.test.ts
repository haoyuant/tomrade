import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomrade/testkit";
import { Tools } from "@tomrade/tools";
import { Settings } from "@tomrade/settings";
import { Agent } from "@tomrade/agent";
import { fakeChat, type ChatModel, type ChatRequest } from "@tomrade/llm";
import loop from "@tomrade/engine-loop";

it("transports attachments through the loop, persists generated media, and guards format/project scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-media-flow-"));
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    capabilities: { tools: true, streaming: true, json: true, mediaInput: ["image/png"] },
    async *chat(request) {
      requests.push(structuredClone(request));
      yield { type: "media", media: { name: "answer.png", mime: "image/png", base64: "YWJj" } };
      yield { type: "stop", reason: "end" };
    }
  };
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop] });
  try {
    const thread = ctx.agent.newThread(project.id, "loop");
    const ref = ctx.agent.uploadMedia(project.id, thread.id, { name: "input.png", mime: "image/png", base64: "aGVsbG8=" });
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "", attachments: [ref] });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(requests[0].messages[0].content).toContainEqual({ type: "media", media: expect.objectContaining({ base64: "aGVsbG8=" }) });
    const output = ctx.agent.thread(project.id, thread.id).messages.find(message => message.block.type === "media")!;
    expect(output.block.type).toBe("media");
    if (output.block.type === "media") expect(ctx.agent.readMedia(project.id, thread.id, output.block.media.id).base64).toBe("YWJj");
    const next = ctx.agent.send(project.id, thread.id, { kind: "text", text: "Describe the previous image" });
    await expect.poll(() => ctx.agent.store.run(project.id, next.runId)?.status).toBe("done");
    expect(requests[1].messages.flatMap(message => message.content)).toContainEqual({ type: "media", media: expect.objectContaining({ base64: "YWJj" }) });
    const other = ctx.agent.newThread(project.id, "loop");
    expect(() => ctx.agent.send(project.id, other.id, { kind: "text", text: "borrow", attachments: [ref] })).toThrow();
    const pdf = ctx.agent.uploadMedia(project.id, thread.id, { name: "x.pdf", mime: "application/pdf", base64: "YWJj" });
    expect(() => ctx.agent.send(project.id, thread.id, { kind: "text", text: "read", attachments: [pdf] })).toThrow("does not accept");
    ctx.agent.deleteThread(project.id, thread.id);
    expect(fs.readdirSync(path.join(root, "media"))).toHaveLength(0);
  } finally { await ctx.fiber.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
