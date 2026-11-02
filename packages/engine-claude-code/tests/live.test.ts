import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import engineClaudeCode from "@tomradex/engine-claude-code";

/** A 32×32 square of solid red. */
const RED = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";

/** Opt-in: spawns the real `claude` CLI with the user's own login. TOMRADE_LIVE_CC=1 pnpm test */
describe.skipIf(!process.env.TOMRADE_LIVE_CC)("live Claude Code", () => {
  it("sees a picture sent into the running turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-live-picture-"));
    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }], [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();
    const thread = ctx.agent.newThread(project.id, "claude-code", null, { options: { model: "haiku" } });
    const file = ctx.agent.uploadMedia(project.id, thread.id, { name: "square.png", mime: "image/png", base64: RED });
    let taken: Promise<boolean> | null = null;
    const off = ctx.on("agent/event", (id: string, event: { type: string; message?: { block: { type: string } } }) => {
      if (id === thread.id && !taken && event.type === "message" && event.message?.block.type === "trace")
        taken = ctx.agent.steer(project.id, thread.id, "s", "What single colour fills the attached picture? Name it in English in your reply.", [file]);
    });
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "Call the tomrade list_items tool, then the count_items tool, then reply in one short sentence. Create nothing." });
    const t0 = Date.now();
    while (ctx.agent.store.run(project.id, runId)?.status === "running") {
      if (Date.now() - t0 > 150_000) throw new Error("live run did not settle");
      await new Promise((r) => setTimeout(r, 250));
    }
    off();
    const said = ctx.agent.store.messages(project.id, thread.id).map((m) => (m.block.type === "text" ? `${m.role}${m.block.steerId ? "(steer)" : ""}: ${m.block.text}` : `${m.role}: ${m.block.type}`));
    console.log(said.join("\n"));
    expect(await taken).toBe(true);
    expect(ctx.agent.store.runs(project.id, thread.id)).toHaveLength(1);
    const at = said.findIndex((line) => line.startsWith("user(steer)"));
    expect(at).toBeGreaterThan(0);
    expect(said.slice(at + 1).some((line) => /\bred\b/i.test(line))).toBe(true);
  }, 180_000);

  it("conducts one real turn, calling tomrade tools over MCP", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-${Date.now()}.json`);
    const { ctx, items, project, board } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();
    items.create({ projectId: project.id, boardId: board.id, title: "Ship the water reminder", by: "human" });

    const thread = ctx.agent.newThread(project.id, "claude-code");
    const { runId } = ctx.agent.send(project.id, thread.id, {
      kind: "text",
      text: "Use the tomrade list_items tool once, then reply with only the number of items you saw. Create nothing."
    });
    const t0 = Date.now();
    for (;;) {
      const run = ctx.agent.store.run(project.id, runId);
      if (run && run.status !== "running") break;
      if (Date.now() - t0 > 150_000) throw new Error("live run did not settle");
      await new Promise((r) => setTimeout(r, 250));
    }
    const run = ctx.agent.store.run(project.id, runId)!;
    const blocks = ctx.agent.store.messages(project.id, thread.id).map((m) => m.block);
    const traces = blocks.filter((b) => b.type === "trace");
    expect(run.status).toBe("done");
    expect(traces.some((t) => t.type === "trace" && t.tool === "list_items" && t.ok)).toBe(true);
    expect(run.changes).toBe(0);
    expect(ctx.agent.store.external(project.id, thread.id)["claude-code"]).toBeTruthy();
  }, 180_000);

  it("takes a steer into the running turn, and waits out one that lands after the reply", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-steer-${Date.now()}.json`);
    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();
    const runCase = async (prompt: string, steer: string, when: (event: { type: string; message?: { block: { type: string } } }) => boolean) => {
      const thread = ctx.agent.newThread(project.id, "claude-code", null, { options: { model: "haiku" } });
      let taken: Promise<boolean> | null = null;
      const off = ctx.on("agent/event", (id: string, event: { type: string; message?: { block: { type: string } } }) => {
        if (id === thread.id && !taken && when(event)) taken = ctx.agent.steer(project.id, thread.id, "s", steer);
      });
      const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: prompt });
      const t0 = Date.now();
      while (ctx.agent.store.run(project.id, runId)?.status === "running") {
        if (Date.now() - t0 > 150_000) throw new Error("live run did not settle");
        await new Promise((r) => setTimeout(r, 250));
      }
      off();
      const said = ctx.agent.store.messages(project.id, thread.id).map((m) => (m.block.type === "text" ? `${m.role}${m.block.steerId ? "(steer)" : ""}: ${m.block.text}` : `${m.role}: ${m.block.type}`));
      console.log(said.join("\n"));
      return { taken: await taken, run: ctx.agent.store.run(project.id, runId)!, said, runs: ctx.agent.store.runs(project.id, thread.id).length };
    };
    const during = await runCase("Call the tomrade list_items tool, then the count_items tool, then tell me in one short sentence how many items there are. Create nothing.",
      "Change of plan: answer in French and start with BONJOUR.", (e) => e.type === "message" && e.message?.block.type === "trace");
    expect(during.taken).toBe(true);
    expect(during.run.status).toBe("done");
    expect(during.runs).toBe(1);
    const at = during.said.findIndex((line) => line.startsWith("user(steer)"));
    expect(at).toBeGreaterThan(0);
    expect(during.said.slice(at + 1).some((line) => /BONJOUR/i.test(line))).toBe(true);

    const late = await runCase("In three short sentences, explain what a kanban board is. Do not use any tools.",
      "Also end with the word PINEAPPLE.", (e) => e.type === "delta");
    expect(late.taken).toBe(true);
    expect(late.run.status).toBe("done");
    expect(late.runs).toBe(1);
    const after = late.said.slice(late.said.findIndex((line) => line.startsWith("user(steer)")) + 1);
    expect(after.some((line) => /PINEAPPLE/.test(line))).toBe(true);
  }, 360_000);

  it("cuts a long command for a message steered in now, and takes one sent while the agent starts up", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-steer-now-${Date.now()}.json`);
    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();
    const runCase = async (prompt: string, steer: string, when: "at-once" | "in-a-command") => {
      const thread = ctx.agent.newThread(project.id, "claude-code", null, { options: { model: "haiku", codePermissionMode: "bypassPermissions" } });
      let taken: Promise<boolean> | null = null;
      const off = ctx.on("agent/event", (id: string, event: { type: string; activity?: string | null }) => {
        if (id !== thread.id || taken || when !== "in-a-command" || event.type !== "progress" || !event.activity?.startsWith("Bash")) return;
        taken = new Promise((r) => setTimeout(r, 3000)).then(() => ctx.agent.steer(project.id, thread.id, "s", steer));
      });
      const t0 = Date.now();
      const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: prompt });
      if (when === "at-once") taken = ctx.agent.steer(project.id, thread.id, "s", steer);
      while (ctx.agent.store.run(project.id, runId)?.status === "running") {
        if (Date.now() - t0 > 150_000) throw new Error("live run did not settle");
        await new Promise((r) => setTimeout(r, 250));
      }
      off();
      const messages = ctx.agent.store.messages(project.id, thread.id);
      const said = messages.map((m) => (m.block.type === "text" ? `${m.role}${m.block.steerId ? "(steer)" : ""}: ${m.block.text}` : `${m.role}: ${m.block.type}`));
      console.log(said.join("\n"));
      return { taken: await taken, run: ctx.agent.store.run(project.id, runId)!, said, blocks: messages.map((m) => m.block), runs: ctx.agent.store.runs(project.id, thread.id).length, ms: Date.now() - t0 };
    };
    const answered = (said: string[]) => said.slice(said.findIndex((line) => line.startsWith("user(steer)")) + 1).some((line) => /PINEAPPLE/.test(line));

    const cut = await runCase("Use the Bash tool to run exactly this command, then tell me what it printed: python3 -c \"import time; time.sleep(90); print(42)\"",
      "Stop that. Reply with only the word PINEAPPLE.", "in-a-command");
    expect(cut.taken).toBe(true);
    expect(cut.run.status).toBe("done");
    expect(cut.runs).toBe(1);
    // the command was ended for the message, not waited out
    expect(cut.ms).toBeLessThan(80_000);
    expect(cut.blocks.some((b) => b.type === "trace" && b.tool === "Bash" && !b.ok)).toBe(true);
    expect(answered(cut.said)).toBe(true);

    const early = await runCase("In two short sentences, explain what a kanban board is. Do not use any tools.", "Also end with the word PINEAPPLE.", "at-once");
    expect(early.taken).toBe(true);
    expect(early.run.status).toBe("done");
    expect(early.runs).toBe(1);
    expect(early.said.findIndex((line) => line.startsWith("user(steer)"))).toBeGreaterThan(0);
    expect(answered(early.said)).toBe(true);
  }, 360_000);

  it("marks a reply a steer cuts mid-stream as unfinished, and the answer to the steer starts with a whole sentence", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-steer-stream-${Date.now()}.json`);
    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();
    const thread = ctx.agent.newThread(project.id, "claude-code", null, { options: { model: "haiku" } });
    let streamed = 0;
    let taken: Promise<boolean> | null = null;
    const off = ctx.on("agent/event", (id: string, event: { type: string; text?: string }) => {
      if (id !== thread.id || taken || event.type !== "delta") return;
      streamed += event.text?.length ?? 0;
      if (streamed > 200) taken = ctx.agent.steer(project.id, thread.id, "s", "Actually, keep it to one sentence about why teams like it.");
    });
    const t0 = Date.now();
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "Write a 500-word essay about kanban boards. Do not use any tools." });
    while (ctx.agent.store.run(project.id, runId)?.status === "running") {
      if (Date.now() - t0 > 150_000) throw new Error("live run did not settle");
      await new Promise((r) => setTimeout(r, 250));
    }
    off();
    const said = ctx.agent.store.messages(project.id, thread.id).flatMap((m) => (m.block.type === "text" ? [{ steer: !!m.block.steerId, role: m.role, text: m.block.text }] : []));
    console.log(said.map((m) => `${m.role}${m.steer ? "(steer)" : ""}: ${m.text}`).join("\n"));
    expect(await taken).toBe(true);
    expect(ctx.agent.store.run(project.id, runId)!.status).toBe("done");
    const at = said.findIndex((m) => m.steer);
    expect(said[at - 1]).toMatchObject({ role: "agent", text: expect.stringMatching(/ …$/) });
    // not the cut word carried on
    expect(said[at + 1]?.text).toMatch(/^[^a-z]/);
  }, 180_000);

  it("waits out a Tomrade call in flight before steering in now, so the call runs once", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-steer-mcp-${Date.now()}.json`);
    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();
    const thread = ctx.agent.newThread(project.id, "claude-code", null, { options: { model: "haiku" } });
    let calls = 0;
    let taken: Promise<boolean> | null = null;
    ctx.tools.register({
      name: "slow_note", title: "Slow note", description: "Writes a note; takes about eight seconds.", input: z.object({ text: z.string() }), mcp: true,
      async execute(args) {
        if (++calls === 1) taken = new Promise((r) => setTimeout(r, 2000)).then(() => ctx.agent.steer(project.id, thread.id, "s", "Also end your reply with the word PINEAPPLE."));
        await new Promise((r) => setTimeout(r, 8000));
        return { written: args.text };
      }
    });
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "Call the tomrade slow_note tool once with text \"hello\", then reply with one short sentence saying what it returned." });
    const t0 = Date.now();
    while (ctx.agent.store.run(project.id, runId)?.status === "running") {
      if (Date.now() - t0 > 150_000) throw new Error("live run did not settle");
      await new Promise((r) => setTimeout(r, 250));
    }
    const said = ctx.agent.store.messages(project.id, thread.id).map((m) => (m.block.type === "text" ? `${m.role}${m.block.steerId ? "(steer)" : ""}: ${m.block.text}` : `${m.role}: ${m.block.type}`));
    console.log(said.join("\n"));
    expect(await taken).toBe(true);
    expect(calls).toBe(1);
    expect(ctx.agent.store.run(project.id, runId)!.status).toBe("done");
    expect(ctx.agent.store.runs(project.id, thread.id)).toHaveLength(1);
    const at = said.findIndex((line) => line.startsWith("user(steer)"));
    expect(at).toBeGreaterThan(0);
    expect(said.slice(at + 1).some((line) => /PINEAPPLE/.test(line))).toBe(true);
  }, 180_000);
});
