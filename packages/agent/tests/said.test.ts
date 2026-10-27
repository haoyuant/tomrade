/** A conversation's last word: the first sentence of what the agent said last, kept with the thread once a turn ends. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, firstSentence } from "@tomradex/agent";

it("reads the first sentence of what was said, its markdown dropped and kept short", () => {
  expect(firstSentence("Wrote **releases/0.21.md**. It lists the 12 changes.")).toBe("Wrote releases/0.21.md.");
  expect(firstSentence("写好了 `releases/0.21.md`。里面列了 12 条。")).toBe("写好了 releases/0.21.md。");
  expect(firstSentence("## Done\n- tests pass")).toBe("Done tests pass");
  expect(firstSentence("version 0.21.3 is out")).toBe("version 0.21.3 is out");
  expect(firstSentence("x".repeat(300))).toHaveLength(120);
  expect(firstSentence("```ts\nconst a = 1;\n```")).toBeNull();
});

it("keeps what a conversation said last once its turn ends, and not while it runs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-said-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }]] });
  let release = () => {};
  let midway: string | null | undefined;
  ctx.agent.engine({
    id: "talker",
    title: "Talker",
    author: "ai:talker",
    available: async () => ({ ok: true }),
    async turn(input, io) {
      io.emit({ type: "text", text: "Reading the backlog first." });
      await new Promise<void>((resolve) => { release = resolve; });
      io.emit({ type: "text", text: "Found 3 duplicates. Kept the fullest of each." });
      return { stop: "end" };
    }
  });
  const thread = ctx.agent.newThread(project.id, "talker", null, { title: "Dedupe" });
  expect(ctx.agent.store.thread(project.id, thread.id)?.said).toBeNull();
  const sent = ctx.agent.send(project.id, thread.id, { kind: "text", text: "dedupe" });
  for (let i = 0; i < 100 && !ctx.agent.store.messages(project.id, thread.id).some((m) => m.block.type === "text" && m.role === "agent"); i++) await new Promise((r) => setTimeout(r, 10));
  midway = ctx.agent.store.thread(project.id, thread.id)?.said;
  release();
  for (let i = 0; i < 200 && ctx.agent.store.run(project.id, sent.runId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  expect(midway).toBeNull();
  expect(ctx.agent.store.thread(project.id, thread.id)?.said).toBe("Found 3 duplicates.");
  expect(ctx.agent.store.threads(project.id).find((th) => th.id === thread.id)?.said).toBe("Found 3 duplicates.");
  await ctx.fiber.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
