import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { fresh, settle } from "@tomrade/testkit";
import { Tools, defineTool } from "@tomrade/tools";
import { z } from "zod";
import { Settings } from "@tomrade/settings";
import { FakeChatModel, fakeChat, type ChatRequest, type FakeTurn } from "@tomrade/llm";
import { Agent, type RunView } from "@tomrade/agent";
import engineLoop from "@tomrade/engine-loop";
import engineScripted from "@tomrade/engine-scripted";
import backlog from "@tomrade/agent-backlog";

const tmpSettings = () => [Settings, { path: path.join(os.tmpdir(), `tomrade-agent-test-${Date.now()}-${Math.random()}.json`) }] as const;

async function boot(turns: FakeTurn[] | ((req: ChatRequest, step: number) => FakeTurn), respond?: (system: string, user: string) => unknown) {
  const model = new FakeChatModel(turns);
  const base = await fresh({
    plugins: [Tools, [...tmpSettings()], fakeChat(model, respond), Agent, engineLoop, engineScripted, backlog]
  });
  await settle();
  return { ...base, model, agent: base.ctx.agent };
}

async function settled(ctx: Context, projectId: string, runId: string, timeout = 8000): Promise<RunView> {
  const t0 = Date.now();
  for (;;) {
    const run = ctx.agent.store.run(projectId, runId);
    if (run && run.status !== "running") return run;
    if (Date.now() - t0 > timeout) throw new Error("run did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the loop engine on the platform", () => {
  it("shows an engine-returned error in the thread instead of leaving a blank turn", async () => {
    const { ctx, agent, project } = await boot([]);
    agent.engine({
      id: "failing",
      title: "Failing engine",
      author: "ai:test",
      available: async () => ({ ok: true }),
      turn: async () => ({ stop: "error", error: "The selected model is unavailable." })
    });
    const thread = agent.newThread(project.id, "failing");
    const { runId } = agent.send(project.id, thread.id, { kind: "text", text: "hello" });
    expect((await settled(ctx, project.id, runId)).status).toBe("error");
    const errors = agent.store.messages(project.id, thread.id).filter((entry) => entry.block.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.block).toEqual({ type: "error", text: "The selected model is unavailable." });
  });

  it("hands a tool the run's signal, so cancelling the run stops the call", async () => {
    const { ctx, agent, project } = await boot([]);
    let started = false;
    let stopped = false;
    ctx.tools.register(
      defineTool({
        name: "wait_for_cancel",
        title: "Wait",
        description: "test",
        input: z.object({}),
        execute: (_args, inv) =>
          new Promise((resolve) => {
            started = true;
            inv.signal?.addEventListener("abort", () => {
              stopped = true;
              resolve("stopped");
            });
          })
      })
    );
    agent.engine({
      id: "waiting",
      title: "Waiting engine",
      author: "ai:test",
      available: async () => ({ ok: true }),
      turn: async (_input, io) => {
        await io.tools.execute("wait_for_cancel", {});
        return { stop: "end" };
      }
    });
    const thread = agent.newThread(project.id, "waiting");
    const { runId } = agent.send(project.id, thread.id, { kind: "text", text: "go" });
    for (const t0 = Date.now(); !started; ) {
      if (Date.now() - t0 > 4000) throw new Error("the tool never started");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(agent.cancel(runId)).toBe(true);
    expect((await settled(ctx, project.id, runId)).status).toBe("cancelled");
    expect(stopped).toBe(true);
  });

  it("answers chit-chat with no tools and no writes", async () => {
    const { ctx, agent, project } = await boot([{ text: "It never rains in the backlog." }]);
    const thread = agent.newThread(project.id);
    const lifecycle: string[] = [];
    ctx.on("agent/event", (threadId, event) => {
      if (threadId === thread.id) lifecycle.push(event.type);
    });
    expect(thread.engine).toBe("loop");
    const { runId } = agent.send(project.id, thread.id, { kind: "text", text: "今天天气怎么样" });
    const run = await settled(ctx, project.id, runId);
    expect(run.status).toBe("done");
    expect(run.changes).toBe(0);
    const blocks = agent.store.messages(project.id, thread.id).map((m) => m.block);
    expect(blocks.some((b) => b.type === "text" && b.text.includes("never rains"))).toBe(true);
    expect(lifecycle[0]).toBe("message");
    expect(lifecycle).toContain("run");
    expect(lifecycle.at(-1)).toBe("done");
  });

  it("carries what the user was viewing into the prompt and persists it on the message", async () => {
    let history: ChatRequest["messages"] = [];
    const { ctx, agent, project } = await boot((req) => {
      history = req.messages;
      return { text: "Raised it." };
    });
    const thread = agent.newThread(project.id);
    const { runId } = agent.send(project.id, thread.id, {
      kind: "text",
      text: "把这个的优先级提一下",
      focus: [
        { kind: "item", id: "it_1", key: "TOM-7", title: "Fix login" },
        { kind: "board", id: "bd_1", title: "Sprint" }
      ]
    });
    const run = await settled(ctx, project.id, runId);
    expect(run.status).toBe("done");
    const userText = history[0]?.content[0]?.type === "text" ? history[0].content[0].text : "";
    expect(userText).toContain('(viewing: item TOM-7 "Fix login", board "Sprint" [bd_1])');
    // the snapshot lives on the message, so later turns and the panel both see it
    const stored = agent.store.messages(project.id, thread.id).find((m) => m.role === "user")?.block;
    expect(stored?.type === "text" && stored.focus?.[0]?.key).toBe("TOM-7");
  });

  it("recovers from the dedup policy refusal, then creates once", async () => {
    const title = "Award a badge for a 7-day streak";
    const script = (req: ChatRequest, step: number): FakeTurn => {
      if (step === 0) return { toolCalls: [{ name: "create_item", args: { title } }] };
      const lastResult = JSON.stringify(req.messages.at(-1));
      if (step === 1) {
        expect(lastResult).toContain("Duplicate check required");
        return { toolCalls: [{ name: "find_similar", args: { title } }] };
      }
      if (step === 2) return { toolCalls: [{ name: "create_item", args: { title } }] };
      return { text: "Created it." };
    };
    const { ctx, agent, items, project } = await boot(script, () => ({ duplicates: [], related: [] }));
    const thread = agent.newThread(project.id);
    const { runId } = agent.send(project.id, thread.id, { kind: "text", text: "加一个连续7天达标给徽章的功能" });
    const run = await settled(ctx, project.id, runId);
    expect(run.status).toBe("done");
    const created = items.list({ projectId: project.id }).filter((i) => i.title === title);
    expect(created).toHaveLength(1);
    expect(run.changes).toBe(1);
    const ledger = agent.store.messages(project.id, thread.id).filter((m) => m.block.type === "trace").map((m) => (m.block.type === "trace" ? `${m.block.tool}:${m.block.ok}` : ""));
    expect(ledger).toEqual(["create_item:false", "find_similar:true", "create_item:true"]);
    // the run-scoped undo reaches it
    const undone = agent.revert(project.id, runId);
    expect(undone.reverted).toBe(1);
    expect(items.list({ projectId: project.id }).filter((i) => i.title === title)).toHaveLength(0);
  });

  it("suspends on ask_user and resumes with the answer", async () => {
    const script = (_req: ChatRequest, step: number): FakeTurn =>
      step === 0 ? { toolCalls: [{ name: "ask_user", args: { question: "Merge the two duplicates?", options: ["Do it", "Leave them"] } }] } : { text: "Leaving them alone." };
    const { ctx, agent, project } = await boot(script);
    const thread = agent.newThread(project.id);
    const first = agent.send(project.id, thread.id, { kind: "text", text: "整理一下 backlog" });
    const run1 = await settled(ctx, project.id, first.runId);
    expect(run1.status).toBe("asked");
    const detail = agent.thread(project.id, thread.id);
    expect(detail.pending?.question.options).toEqual(["Do it", "Leave them"]);

    const second = agent.send(project.id, thread.id, { kind: "answer", questionId: detail.pending!.question.id, value: "Leave them" });
    const run2 = await settled(ctx, project.id, second.runId);
    expect(run2.status).toBe("done");
    expect(agent.thread(project.id, thread.id).pending).toBeNull();
  });

  it("runs plan_and_apply as one transaction and reverts it as one run", async () => {
    const respond = (system: string) => {
      if (system.includes("decompose a product requirement") || system.includes("You decompose"))
        return {
          epics: [
            { title: "Tracking", body: "Log intake", features: [{ title: "Log a glass with one tap", body: "" }, { title: "Set a daily goal", body: "" }] },
            { title: "Reminders", body: "", features: [{ title: "Send interval reminders", body: "" }] }
          ]
        };
      return { duplicates: [], related: [] };
    };
    const script = (_req: ChatRequest, step: number): FakeTurn =>
      step === 0 ? { toolCalls: [{ name: "plan_and_apply", args: { requirement: "A Flutter app that reminds me to drink water", rootTitle: "Water reminder" } }] } : { text: "Planned and applied." };
    const { ctx, agent, items, project } = await boot(script, respond);
    const thread = agent.newThread(project.id);
    const { runId } = agent.send(project.id, thread.id, { kind: "text", text: "拆一下这个需求" });
    const run = await settled(ctx, project.id, runId);
    expect(run.status).toBe("done");
    // 1 root epic + 2 epics + 3 features
    expect(run.changes).toBe(6);
    const all = items.list({ projectId: project.id });
    const root = all.find((i) => i.title === "Water reminder");
    expect(root?.kind).toBe("epic");
    expect(all.filter((i) => i.parentId === root?.id)).toHaveLength(2);

    const undone = agent.revert(project.id, runId);
    expect(undone.reverted).toBe(6);
    expect(items.list({ projectId: project.id }).find((i) => i.title === "Water reminder")).toBeUndefined();
  });
});

describe("crash recovery", () => {
  it("reconciles a run left running by a killed process when the app restarts", async () => {
    const cacheDir = path.join(os.tmpdir(), `tomrade-agent-restart-${Date.now()}-${Math.random()}`);
    const plugins = [Tools, [...tmpSettings()], Agent] as const;

    const first = await fresh({ cacheDir, plugins: [...plugins] });
    const thread = first.ctx.agent.newThread(first.project.id);
    const stale = first.ctx.agent.store.beginRun(first.project.id, thread.id, "loop"); // the process dies mid-turn — no dispose, no cleanup
    expect(stale.status).toBe("running");
    await first.ctx.fiber.dispose();

    // The next launch is a new process against the same cache — this is what "app restart" means here.
    // The test harness keeps its catalog in memory, so the old project is opened by hand, the way
    // the catalog would open it; reconciliation runs on `db/opened`.
    const second = await fresh({ cacheDir, plugins: [Tools, [...tmpSettings()], Agent] });
    second.ctx.db.open(first.project.id);
    const after = second.ctx.agent.store.run(first.project.id, stale.id)!;
    expect(after.status).toBe("cancelled");
    expect(after.error).toContain("Interrupted");
    const note = second.ctx.agent.store.messages(first.project.id, thread.id).find((m) => m.runId === stale.id && m.block.type === "note");
    expect(note && note.block.type === "note" && note.block.text).toContain("Interrupted");
  });

  it("cancel() reconciles a run with no in-memory process instead of silently doing nothing", async () => {
    const { agent, project } = await boot([{ text: "hi" }]);
    const thread = agent.newThread(project.id);
    const stale = agent.store.beginRun(project.id, thread.id, "loop"); // never went through send(), so it's not in activeById

    expect(agent.cancel(stale.id)).toBe(true);
    expect(agent.store.run(project.id, stale.id)!.status).toBe("cancelled");
    // already terminal — cancelling again is a genuine no-op
    expect(agent.cancel(stale.id)).toBe(false);
  });
});

describe("the knobs a thread opens on", () => {
  it("keeps the options a new thread was opened with instead of resetting to the engine's defaults", async () => {
    const { agent, project } = await boot([]);
    const thread = agent.newThread(project.id, "loop", null, { options: { effort: "high" } });

    expect(thread.options).toEqual({ effort: "high" });
    expect(agent.store.thread(project.id, thread.id)!.options).toEqual({ effort: "high" });
    expect(agent.optionsOf(agent.store.thread(project.id, thread.id)!, "loop")).toEqual({ effort: "high" });
  });

  it("does not carry knobs onto the engine that takes over when the one asked for is gone", async () => {
    const { agent, project } = await boot([]);
    const thread = agent.newThread(project.id, "unplugged", null, { options: { effort: "high" } });

    expect(thread.engine).toBe("loop"); // the first registered engine answers
    expect(thread.options).toBeNull();
  });

  it("drops options the engine rejects rather than leaving a thread that cannot run", async () => {
    const { agent, project } = await boot([]);
    const thread = agent.newThread(project.id, "loop", null, { options: { effort: 42 } });

    expect(thread.engine).toBe("loop");
    expect(thread.options).toBeNull();
  });
});

describe("the scripted engine", () => {
  it("walks the intake wizard deterministically and stores the dossier card", async () => {
    const { ctx, agent, project } = await boot([]);
    const thread = agent.newThread(project.id, "scripted");
    let { runId } = agent.send(project.id, thread.id, { kind: "text", text: "hi" });
    let run = await settled(ctx, project.id, runId);
    expect(run.status).toBe("asked");
    let pending = agent.thread(project.id, thread.id).pending!;
    expect(pending.question.options).toContain("Requirement intake (fixed questions)");

    const answers = [
      "Requirement intake (fixed questions)",
      "Help me drink enough water every day",
      "Existing notes",
      "Flutter mobile app only",
      "log water, remind me, show progress",
      "7-day streak of hitting the goal"
    ];
    for (const answer of answers) {
      pending = agent.thread(project.id, thread.id).pending!;
      ({ runId } = agent.send(project.id, thread.id, { kind: "answer", questionId: pending.question.id, value: answer }));
      run = await settled(ctx, project.id, runId);
    }
    // Universal fields answered → the confirm question is now waiting.
    pending = agent.thread(project.id, thread.id).pending!;
    expect(pending.question.text).toContain("Plan the backlog");
    ({ runId } = agent.send(project.id, thread.id, { kind: "answer", questionId: pending.question.id, value: "Stop" }));
    run = await settled(ctx, project.id, runId);
    expect(run.status).toBe("done");
    const card = agent.thread(project.id, thread.id).cards.find((c) => c.id === "dossier");
    expect(card).toBeTruthy();
    expect((card!.data as { constraints: string[] }).constraints).toEqual(["Flutter mobile app only"]);
    expect(run.changes).toBe(0);
  });
});
