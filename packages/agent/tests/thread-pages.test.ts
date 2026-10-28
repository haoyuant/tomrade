import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-thread-pages-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

it("pages open and put-away conversations apart, newest first without overlap, and finds them by title", async () => {
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent] });
  const store = ctx.agent.store;
  const ids: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const th = ctx.agent.newThread(project.id, undefined, null, { title: `Chat ${i}` });
    // one tick apart, so the order by time is the order made
    store.touchThread(project.id, th.id, { title: `Chat ${i}` });
    ctx.db.for(project.id).prepare("UPDATE plugin_agent_threads SET updated_at = ? WHERE id = ?").run(1000 + i, th.id);
    ids.push(th.id);
  }
  ctx.agent.archiveThread(project.id, ids[1]!);
  ctx.db.for(project.id).prepare("UPDATE plugin_agent_threads SET updated_at = ? WHERE id = ?").run(1002, ids[1]!);

  const open = store.threadsPage(project.id, "assistant", false, null, 2);
  expect(open.map((th) => th.title)).toEqual(["Chat 5", "Chat 4"]);
  const last = open.at(-1)!;
  expect(store.threadsPage(project.id, "assistant", false, { at: last.updatedAt, id: last.id }, 2).map((th) => th.title)).toEqual(["Chat 3", "Chat 1"]);
  expect(store.threadsPage(project.id, "assistant", true, null, 10).map((th) => th.title)).toEqual(["Chat 2"]);

  expect(store.threadsMatching(project.id, "assistant", false, "chat 3", 10).map((th) => th.title)).toEqual(["Chat 3"]);
  expect(store.threadsMatching(project.id, "assistant", true, "chat", 10).map((th) => th.title)).toEqual(["Chat 2"]);
  // LIKE's wildcards are read as letters
  expect(store.threadsMatching(project.id, "assistant", false, "%", 10)).toEqual([]);
  await ctx.fiber.dispose();
});

it("sends a thread's messages after the one a reader holds, with the rest of the thread whole", async () => {
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings-after.json") }], Agent] });
  const th = ctx.agent.newThread(project.id, undefined, null, { title: "Long chat" });
  for (let i = 1; i <= 5; i++) ctx.agent.store.appendMessage(project.id, th.id, i % 2 ? "user" : "agent", { type: "text", text: `line ${i}` }, null);
  const whole = ctx.agent.thread(project.id, th.id);
  expect(whole.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  const after = ctx.agent.thread(project.id, th.id, 3);
  expect(after.messages.map((m) => m.seq)).toEqual([4, 5]);
  expect(after.thread.id).toBe(th.id);
  expect(ctx.agent.thread(project.id, th.id, 5).messages).toEqual([]);
  await ctx.fiber.dispose();
});
