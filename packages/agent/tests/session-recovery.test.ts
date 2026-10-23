import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Agent, conversationRecap, type TurnIO, type TurnInput, type TurnResult } from "@tomradex/agent";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-session-"));
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent] });
  const done = async () => { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); };
  return { ctx, project, done };
}

it("forgets a session the engine no longer has, says so, and runs the turn again with the conversation carried in", async () => {
  const { ctx, project, done } = await setup();
  try {
    const calls: { resume?: string; recap: string }[] = [];
    let next = 1;
    const turn = async (input: TurnInput, io: TurnIO): Promise<TurnResult> => {
      calls.push({ resume: io.resume, recap: io.recap?.() ?? "" });
      if (io.resume === "dead") return { stop: "error", error: "no rollout found", lostSession: true };
      io.emit({ type: "text", text: `answer ${next}` });
      return { stop: "end", resume: io.resume ?? `session-${next++}` };
    };
    ctx.agent.engine({ id: "keeper", title: "Keeper", author: "ai:keeper", available: async () => ({ ok: true }), turn });
    const thread = ctx.agent.newThread(project.id, "keeper");
    const first = ctx.agent.send(project.id, thread.id, { kind: "text", text: "set up the kanban" });
    await expect.poll(() => ctx.agent.store.run(project.id, first.runId)?.status).toBe("done");
    expect(calls[0]).toEqual({ resume: undefined, recap: "" });
    expect(ctx.agent.store.external(project.id, thread.id)).toEqual({ keeper: "session-1" });

    // the session moved away (another CODEX_HOME, a cleared history)
    ctx.agent.store.setExternal(project.id, thread.id, "keeper", "dead");
    const second = ctx.agent.send(project.id, thread.id, { kind: "text", text: "fix kanban" });
    await expect.poll(() => ctx.agent.store.run(project.id, second.runId)?.status).toBe("done");
    expect(calls.slice(1).map((c) => c.resume)).toEqual(["dead", undefined]);
    expect(calls[2].recap).toContain("User: set up the kanban");
    expect(calls[2].recap).toContain("Assistant: answer 1");
    expect(calls[2].recap).not.toContain("fix kanban");
    expect(ctx.agent.store.external(project.id, thread.id)).toEqual({ keeper: "session-2" });
    const notes = ctx.agent.store.messages(project.id, thread.id).filter((m) => m.block.type === "note").map((m) => (m.block as { text: string }).text);
    expect(notes.some((text) => text.includes("Keeper no longer has this conversation's session"))).toBe(true);
    expect(ctx.agent.store.run(project.id, second.runId)?.error ?? null).toBeNull();
  } finally { await done(); }
});

it("does not retry a lost session more than once", async () => {
  const { ctx, project, done } = await setup();
  try {
    let calls = 0;
    ctx.agent.engine({ id: "broken", title: "Broken", author: "ai:broken", available: async () => ({ ok: true }),
      turn: async () => { calls++; return { stop: "error", error: "gone", lostSession: true }; } });
    const thread = ctx.agent.newThread(project.id, "broken");
    ctx.agent.store.setExternal(project.id, thread.id, "broken", "dead");
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "hi" });
    await expect.poll(() => ctx.agent.store.run(project.id, runId)?.status).toBe("error");
    expect(calls).toBe(2);
  } finally { await done(); }
});

it("tries an engine for real, keeps the answer while its settings stay, and leaves no thread behind", async () => {
  const { ctx, project, done } = await setup();
  try {
    let fail = false;
    ctx.agent.engine({ id: "echo", title: "Echo", author: "ai:echo", available: async () => ({ ok: true }),
      turn: async (_input, io) => {
        if (fail) return { stop: "error", error: "401 invalid api key", details: "raw provider words" };
        io.emit({ type: "text", text: "OK" });
        return { stop: "end" };
      } });
    const before = ctx.agent.store.threads(project.id).length;
    const tried = await ctx.agent.tryEngine(project.id, "echo");
    expect(tried).toMatchObject({ ok: true, reply: "OK" });
    expect(ctx.agent.store.threads(project.id)).toHaveLength(before);
    expect((await ctx.agent.engineViews()).find((v) => v.id === "echo")?.tried).toEqual(tried);

    fail = true;
    const failed = await ctx.agent.tryEngine(project.id, "echo");
    expect(failed).toMatchObject({ ok: false, error: "401 invalid api key", details: "raw provider words" });

    // new settings, new question: the old answer no longer speaks for it
    const all = ctx.settings.get() as { agent?: Record<string, unknown> };
    ctx.settings.set({ ...all, agent: { ...(all.agent ?? {}), engines: { echo: { model: "other" } } } });
    expect((await ctx.agent.engineViews()).find((v) => v.id === "echo")?.tried).toBeUndefined();
  } finally { await done(); }
});

it("passes a try when the agent answers it, and fails it when the turn only carries a refusal", async () => {
  const { ctx, project, done } = await setup();
  try {
    // What the agent says instead of the answer: nothing, or its provider's failure as ordinary text.
    let said = "";
    ctx.agent.engine({ id: "mute", title: "Mute", author: "ai:mute", available: async () => ({ ok: true }),
      turn: async (_input, io) => {
        if (said) io.emit({ type: "text", text: said });
        return { stop: "end" };
      } });
    const tried = (text: string) => { said = text; return ctx.agent.tryEngine(project.id, "mute"); };

    const silent = await tried("");
    expect(silent).toMatchObject({ ok: false, error: "the agent ended its turn without a reply" });
    expect(silent.reply).toBeUndefined();

    // A working agent answers in its own words: a greeting, another language, a code
    // block, a paragraph, or the asked-for word followed by a passing mention of a
    // failure. None of these is a refusal, and none may be blocked.
    for (const answer of [
      "Sure, OK.",
      "好的",
      "```OK```",
      "An error message is only what the program prints when something goes wrong; the one you saw came from the cache, so the request itself was fine and this agent is answering normally.",
      "OK — the provider reported an error earlier, but I'm answering now.",
    ]) expect(await tried(answer)).toMatchObject({ ok: true, reply: answer });

    // A turn that ended normally with the provider's refusal where a reply goes is not
    // an answer, whatever the engine calls the turn.
    for (const refusal of [
      "AWS Bedrock didn't answer after 3 attempts — it looks temporarily unavailable. Wait a minute and send /retry, or switch models with /model.",
      "400 internal error",
      "You have no credits remaining. Add credits in the provider's dashboard.",
      "HTTP 200 OK",
      "Error: model not found",
    ]) expect(await tried(refusal)).toMatchObject({ ok: false, error: refusal, reply: refusal });
  } finally { await done(); }
});

it("recaps text the person and the agent said, newest first to survive, without the message being answered", () => {
  const at = (role: "user" | "agent" | "system", text: string, seq: number) => ({ id: String(seq), threadId: "t", seq, role, block: { type: "text" as const, text }, runId: null, at: seq });
  const long = "x".repeat(20_000);
  const recap = conversationRecap([at("user", long, 1), at("agent", "recent answer", 2), at("user", "now", 3)]);
  expect(recap).toContain("Assistant: recent answer");
  expect(recap).toContain("…");
  expect(recap.length).toBeLessThan(17_000);
  expect(conversationRecap([])).toBe("");
});
