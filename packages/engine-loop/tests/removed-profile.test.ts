/** A thread that picked a profile since removed is answered by the first profile, as with no pick, instead of failing. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import type { ChatModel } from "@tomradex/llm";
import loop from "@tomradex/engine-loop";

it("runs a turn and reports media on the first profile when the picked one is gone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loop-removed-"));
  const used: string[] = [];
  const model = (id: string): ChatModel => ({
    capabilities: { tools: true, streaming: true, json: true, mediaInput: ["image/png"] },
    async *chat() {
      used.push(id);
      yield { type: "text", delta: "done" };
      yield { type: "stop", reason: "end" };
    }
  });
  const models = {
    name: "fake-models",
    apply(ctx: Context) {
      ctx.provide("llm", {
        for: () => model("first"),
        forProfile: (id: string) => {
          if (id !== "first") throw new Error(`Unknown model profile "${id}"`);
          return model(id);
        },
        profiles: () => [{ id: "first", title: "First" }],
        ready: () => ({ ok: true, profile: { id: "first", title: "First", provider: "fake", model: "fake" } }),
        test: async () => ({ ok: true }),
        listing: async () => ({ ok: true, models: [], capabilities: {} }),
        lend: () => () => {},
        worker: async () => ({ ok: true, via: "profile", title: "First" })
      } as never);
    }
  };
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], models, [Agent, { mediaDir: path.join(root, "media") }], loop] });
  try {
    const thread = ctx.agent.newThread(project.id, "loop");
    ctx.agent.setOptions(project.id, thread.id, { profile: "gone" });
    expect(ctx.agent.engines.get("loop")!.media!({ profile: "gone" })).toEqual({ input: ["image/png"], output: [] });
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "hello" });
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status, { timeout: 5_000 }).not.toBe("running");
    expect(ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(used).toEqual(["first"]);
  } finally {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
