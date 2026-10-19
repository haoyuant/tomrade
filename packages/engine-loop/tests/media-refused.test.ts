/**
 * A model that refuses an attachment it cannot read does not fail the turn: the step goes again
 * without that kind of media, the model is told a file was left out, and the person is told once.
 * Any other refusal still fails the turn.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { LlmError, MediaRefused, fakeChat, type ChatModel, type ChatRequest } from "@tomradex/llm";
import loop from "@tomradex/engine-loop";

async function drive(refusal: Error) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loop-media-"));
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    capabilities: { tools: true, streaming: true, json: true, mediaInput: ["image/png", "application/pdf"] },
    async *chat(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) throw refusal;
      yield { type: "text", delta: "read it" };
      yield { type: "stop", reason: "end" };
    }
  };
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop] });
  try {
    const thread = ctx.agent.newThread(project.id, "loop");
    const attachments = [
      ctx.agent.uploadMedia(project.id, thread.id, { name: "shot.png", mime: "image/png", base64: "aGVsbG8=" }),
      ctx.agent.uploadMedia(project.id, thread.id, { name: "spec.pdf", mime: "application/pdf", base64: "YWJj" })
    ];
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "what do these say?", attachments });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).not.toBe("running");
    const status = ctx.agent.store.run(project.id, run.runId)?.status;
    const notes = ctx.agent.store.messages(project.id, thread.id).flatMap((m) => (m.block.type === "note" ? [m.block.text] : []));
    return { requests, status, notes };
  } finally {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const sent = (request: ChatRequest) => request.messages.flatMap((m) => m.content);

it("goes on without the media kind the model refused, and says so once", async () => {
  const { requests, status, notes } = await drive(new MediaRefused("unknown variant `file`", ["pdf"]));
  expect(status).toBe("done");
  expect(requests).toHaveLength(2);
  expect(sent(requests[0]).filter((b) => b.type === "media")).toHaveLength(2);
  const retried = sent(requests[1]);
  expect(retried.filter((b) => b.type === "media").map((b) => b.type === "media" && b.media.mime)).toEqual(["image/png"]);
  expect(retried).toContainEqual({ type: "text", text: "(attachment spec.pdf left out: this model cannot read pdf files)" });
  expect(notes).toEqual([expect.stringContaining("cannot read PDFs")]);
});

it("still fails the turn on any other refusal", async () => {
  const { requests, status, notes } = await drive(new LlmError("LLM request failed 400: max_tokens is too large"));
  expect(status).toBe("error");
  expect(requests).toHaveLength(1);
  expect(notes).toEqual([]);
});
