import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Tools, type RunHandle } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { FakeChatModel, fakeChat } from "@tomradex/llm";
import { Agent } from "@tomradex/agent";
import engineLoop from "@tomradex/engine-loop";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-review-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("review_delivery from an agent conversation", () => {
  it("is refused to a conversation that works on the ticket, and allowed to another on the user's word", async () => {
    const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(new FakeChatModel([])), [Agent, {}], engineLoop] });
    await settle();
    const ticket = items.create({ projectId: project.id, boardId: board.id, title: "Write the guide", status: "doing", by: "human" });
    items.submitDelivery(project.id, ticket.id, { report: "Draft is in Files" }, "ai:loop");
    const handle = (threadId: string): RunHandle => ({ id: `run-${threadId}`, threadId, projectId: project.id, author: "ai:loop", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() });
    const review = (threadId: string) => ctx.tools.execute("review_delivery", { id: ticket.key, decision: "accepted", userSaid: "looks good, accept it" }, { by: "ai:loop", projectId: project.id, run: handle(threadId) });

    const working = ctx.agent.newThread(project.id, undefined, null, { itemId: ticket.id });
    await expect(review(working.id)).rejects.toThrow(`this conversation works on ${ticket.key}`);
    expect(items.get(project.id, ticket.id)?.status).toBe("verifying");

    const assistant = ctx.agent.newThread(project.id);
    expect(await review(assistant.id)).toMatchObject({ status: "done" });
    await ctx.fiber.dispose();
  });
});
