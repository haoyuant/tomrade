import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { fresh, settle } from "@tomradex/testkit";
import { Tools, defineTool } from "@tomradex/tools";
import { z } from "zod";
import { Settings } from "@tomradex/settings";
import { FakeChatModel, fakeChat, type ChatRequest, type FakeTurn } from "@tomradex/llm";
import { Agent, type RunView } from "@tomradex/agent";
import engineLoop from "@tomradex/engine-loop";
import engineScripted from "@tomradex/engine-scripted";
import backlog from "@tomradex/agent-backlog";

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
  it("waits for whoever reads the folder at each end of a run: before the engine starts, and before the run settles", async () => {
    const { ctx, agent, project } = await boot([]);
    const order: string[] = [];
    ctx.on("agent/run-boundary", async (_run, _thread, phase) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(phase);
      // A reader that fails costs the run nothing.
      if (phase === "before") throw new Error("could not read the folder");
    });
    ctx.on("agent/run-ended", (run) => void order.push(`ended:${run.stop}`));
    agent.engine({ id: "capture", title: "Capture", author: "ai:test", available: async () => ({ ok: true }), turn: async () => (order.push("engine"), { stop: "end" }) });
    const thread = agent.newThread(project.id, "capture");
    const { runId } = agent.send(project.id, thread.id, { kind: "text", text: "hello" });
    await settled(ctx, project.id, runId);
    expect(order).toEqual(["before", "engine", "after", "ended:end"]);
  });

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

  it("never gives a conversation without a ticket to a terminal-only agent, even when it is the default", async () => {
    const { agent, project, ctx } = await boot([]);
    agent.engine({ id: "termy", title: "Termy", author: "ai:termy", capabilities: ["code"], terminalOnly: true, available: async () => ({ ok: true }), turn: async () => ({ stop: "end" }) });
    ctx.settings.set({ ...ctx.settings.get(), agent: { ...ctx.settings.get().agent, defaultEngine: "termy" } });
    expect(agent.newThread(project.id).engine).not.toBe("termy");
    expect(agent.newThread(project.id, "termy").engine).not.toBe("termy");
    // A ticket started in a terminal keeps the agent it was started with.
    expect(agent.newThread(project.id, "termy", null, { itemId: "ticket" }).engine).toBe("termy");
  });

  it("folds what an engine knew under its error, and describes an error it threw", async () => {
    const { ctx, agent, project } = await boot([]);
    agent.engine({
      id: "explaining",
      title: "Explaining engine",
      author: "ai:test",
      available: async () => ({ ok: true }),
      turn: async () => ({ stop: "error", error: "Agent stopped", details: "── stderr ──\nquota exhausted" })
    });
    agent.engine({
      id: "throwing",
      title: "Throwing engine",
      author: "ai:test",
      available: async () => ({ ok: true }),
      turn: async () => { throw Object.assign(new Error("request failed", { cause: new Error("socket hang up") }), { status: 502 }); }
    });
    const errorOf = async (engine: string) => {
      const thread = agent.newThread(project.id, engine);
      const { runId } = agent.send(project.id, thread.id, { kind: "text", text: "hello" });
      await settled(ctx, project.id, runId);
      return agent.store.messages(project.id, thread.id).find((entry) => entry.block.type === "error")?.block;
    };
    expect(await errorOf("explaining")).toEqual({ type: "error", text: "Agent stopped", details: "── stderr ──\nquota exhausted" });
    const thrown = await errorOf("throwing");
    expect(thrown).toMatchObject({ type: "error", text: "request failed" });
    expect(thrown?.type === "error" && thrown.details).toMatch(/status: 502[\s\S]*caused by Error: socket hang up/);
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

  it("keeps what a stopped run had already said, marked unfinished, and says it stopped", async () => {
    const { ctx, agent, project } = await boot([]);
    let streaming = false;
    agent.engine({
      id: "streaming",
      title: "Streaming engine",
      author: "ai:test",
      available: async () => ({ ok: true }),
      turn: (_input, io) =>
        new Promise((resolve) => {
          io.delta("Here is the first half of ");
          io.delta("my answer");
          streaming = true;
          io.signal.addEventListener("abort", () => resolve({ stop: "end" }));
        })
    });
    const thread = agent.newThread(project.id, "streaming");
    const { runId } = agent.send(project.id, thread.id, { kind: "text", text: "go" });
    for (const t0 = Date.now(); !streaming; ) {
      if (Date.now() - t0 > 4000) throw new Error("the engine never streamed");
      await new Promise((r) => setTimeout(r, 10));
    }
    agent.cancel(runId);
    expect((await settled(ctx, project.id, runId)).status).toBe("cancelled");
    const blocks = agent.store.messages(project.id, thread.id).filter((m) => m.runId === runId).map((m) => m.block);
    expect(blocks).toContainEqual({ type: "text", text: "Here is the first half of my answer …" });
    expect(blocks).toContainEqual({ type: "note", text: "Stopped." });
  });

  it("says a run ended at its time limit, not that someone stopped it, and where to raise it", async () => {
    const base = await fresh({ plugins: [Tools, [...tmpSettings()], fakeChat(new FakeChatModel([])), Agent] });
    await settle();
    const { ctx, project } = base;
    const agent = ctx.agent;
    agent.engine({
      id: "slow",
      title: "Slow engine",
      author: "ai:test",
      available: async () => ({ ok: true }),
      turn: (_input, io) => new Promise((resolve) => io.signal.addEventListener("abort", () => resolve({ stop: "end" })))
    });
    const thread = agent.newThread(project.id, "slow");
    const notes = (runId: string) => agent.store.messages(project.id, thread.id).filter((m) => m.runId === runId && m.block.type === "note").map((m) => (m.block as { text: string }).text);
    const hint = "To give a conversation more time, raise “Time limit per run” in Settings → Assistant.";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let runId = "";
    try {
      runId = agent.send(project.id, thread.id, { kind: "text", text: "go" }).runId;
      // a conversation without a ticket gets a quarter hour, not three minutes
      await vi.advanceTimersByTimeAsync(14 * 60_000);
      expect(agent.store.run(project.id, runId)?.status).toBe("running");
      await vi.advanceTimersByTimeAsync(60_500);
    } finally {
      vi.useRealTimers();
    }
    expect((await settled(ctx, project.id, runId)).status).toBe("cancelled");
    expect(notes(runId)).toEqual([`Stopped: the run reached its time limit (15 min). ${hint}`]);

    // the next run takes the limit Settings now hold
    ctx.settings.set({ ...ctx.settings.get(), agent: { ...(ctx.settings.get().agent as object), maxRunMinutes: 1 } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      runId = agent.send(project.id, thread.id, { kind: "text", text: "again" }).runId;
      await vi.advanceTimersByTimeAsync(60_500);
    } finally {
      vi.useRealTimers();
    }
    expect((await settled(ctx, project.id, runId)).status).toBe("cancelled");
    expect(notes(runId)).toEqual([`Stopped: the run reached its time limit (1 min). ${hint}`]);
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

  it("shows plan_and_apply's tree and writes it, as one transaction revertible as one run, only once the person agrees", async () => {
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
    const first = agent.send(project.id, thread.id, { kind: "text", text: "拆一下这个需求" });
    const planned = await settled(ctx, project.id, first.runId);
    expect(planned).toMatchObject({ status: "asked", changes: 0 });
    expect(items.list({ projectId: project.id })).toHaveLength(0);
    const proposal = agent.store.messages(project.id, thread.id).map((m) => m.block).find((b) => b.type === "card" && b.schema === "backlog.proposal");
    expect(proposal).toMatchObject({ data: { rootTitle: "Water reminder", epics: [{ title: "Tracking" }, { title: "Reminders" }] } });
    const pending = agent.thread(project.id, thread.id).pending!;
    // 1 root epic + 2 epics + 3 features
    expect(pending.question).toMatchObject({ text: expect.stringContaining("writes 6 items"), options: ["Apply", "Cancel"] });

    const { runId } = agent.send(project.id, thread.id, { kind: "answer", questionId: pending.question.id, value: "Apply" });
    const run = await settled(ctx, project.id, runId);
    expect(run).toMatchObject({ status: "done", changes: 6 });
    const all = items.list({ projectId: project.id });
    const root = all.find((i) => i.title === "Water reminder");
    expect(root?.kind).toBe("epic");
    expect(all.filter((i) => i.parentId === root?.id)).toHaveLength(2);

    const undone = agent.revert(project.id, runId);
    expect(undone.reverted).toBe(6);
    expect(items.list({ projectId: project.id }).find((i) => i.title === "Water reminder")).toBeUndefined();
  });

  it("plans in the person's language, and writes nothing when they turn the plan down", async () => {
    const planned: string[] = [];
    const respond = (system: string) => {
      if (!system.includes("You decompose")) return { duplicates: [], related: [] };
      planned.push(system);
      return { epics: [{ title: "记录", body: "", features: [{ title: "一键记录一杯水", body: "" }] }] };
    };
    const script = (_req: ChatRequest, step: number): FakeTurn =>
      step === 0 ? { toolCalls: [{ name: "plan_and_apply", args: { requirement: "A water reminder", rootTitle: "Water reminder" } }] } : { text: "好的，不写了。" };
    const { ctx, agent, items, project } = await boot(script, respond);
    ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
    const thread = agent.newThread(project.id);
    const first = agent.send(project.id, thread.id, { kind: "text", text: "拆一下" });
    expect((await settled(ctx, project.id, first.runId)).status).toBe("asked");
    expect(planned[0]).toContain("Write every title, body and note in Simplified Chinese");
    const pending = agent.thread(project.id, thread.id).pending!;
    expect(pending.question).toMatchObject({ text: expect.stringContaining("写入 backlog 吗"), options: ["写入", "取消"] });
    const second = agent.send(project.id, thread.id, { kind: "answer", questionId: pending.question.id, value: "取消" });
    expect(await settled(ctx, project.id, second.runId)).toMatchObject({ status: "done", changes: 0 });
    expect(items.list({ projectId: project.id })).toHaveLength(0);
  });

  it("changes a setting when asked, lists it under the run, and takes it back with the run", async () => {
    const script = (_req: ChatRequest, step: number): FakeTurn =>
      step === 0 ? { toolCalls: [{ name: "update_settings", args: { changes: { theme: "dark", language: "zh" } } }] } : { text: "Switched to Dark, in Chinese." };
    const { ctx, agent, project } = await boot(script);
    const thread = agent.newThread(project.id);
    const { runId } = agent.send(project.id, thread.id, { kind: "text", text: "换成深色主题，界面用中文" });
    const run = await settled(ctx, project.id, runId);
    expect(run.changes).toBe(2);
    expect(ctx.settings.get()).toMatchObject({ theme: "dark", language: "zh" });
    const foot = agent.store.messages(project.id, thread.id).map((m) => m.block).find((b) => b.type === "changes");
    expect(foot).toMatchObject({ count: 2, items: [{ key: "Appearance", label: "sunrise → dark", op: "updated" }, { key: "Language", label: "system → zh", op: "updated" }] });

    expect(agent.revert(project.id, runId).reverted).toBe(2);
    expect(ctx.settings.get()).toMatchObject({ theme: "sunrise", language: "system" });
  });
});

describe("a waiting workflow on a model engine", () => {
  const nameWorkflow = (agent: Agent, received: string[]) =>
    agent.workflow<Record<string, never>, { asked: boolean }>({
      id: "name_the_project",
      title: "Name the project",
      description: "Ask for a project name.",
      input: z.object({}),
      state: z.object({ asked: z.boolean() }),
      entry: "ask",
      accepts: "text",
      start: () => ({ asked: false }),
      steps: {
        ask(state, io, answer) {
          if (answer === undefined) return { ask: { text: "What should the project be called?", freeText: true }, state: { asked: true } };
          received.push(String(answer));
          io.emit({ type: "text", text: `Named it ${String(answer)}.` });
          return { done: { name: answer } };
        }
      }
    });

  it("lets the model judge a typed reply instead of feeding it to the waiting question", async () => {
    const systems: string[] = [];
    const script = (req: ChatRequest, step: number): FakeTurn => {
      // The pending question rides in the volatile tail, after the cached system text.
      systems.push([req.system ?? "", req.systemTail ?? ""].join("\n\n"));
      if (step === 0) return { toolCalls: [{ name: "name_the_project", args: {} }] };
      if (step === 1) return { toolCalls: [{ name: "cancel_workflow", args: {} }] };
      return { text: "Skipping the name; planning instead." };
    };
    const { ctx, agent, project } = await boot(script);
    const received: string[] = [];
    nameWorkflow(agent, received);
    const thread = agent.newThread(project.id);
    let { runId } = agent.send(project.id, thread.id, { kind: "text", text: "set it up" });
    expect((await settled(ctx, project.id, runId)).status).toBe("asked");
    ({ runId } = agent.send(project.id, thread.id, { kind: "text", text: "直接拆解成backlog" }));
    expect((await settled(ctx, project.id, runId)).status).toBe("done");
    expect(systems[1]).toContain('A workflow is waiting on: "What should the project be called?"');
    expect(received).toEqual([]);
    expect(agent.thread(project.id, thread.id).pending).toBeNull();
  });

  it("never ends a request on the assistant, even when a workflow answered last", async () => {
    const script = (_req: ChatRequest, step: number): FakeTurn => (step === 0 ? { toolCalls: [{ name: "name_the_project", args: {} }] } : { text: "Done." });
    const { ctx, agent, project, model } = await boot(script);
    const received: string[] = [];
    nameWorkflow(agent, received);
    const thread = agent.newThread(project.id);
    let { runId } = agent.send(project.id, thread.id, { kind: "text", text: "set it up" });
    await settled(ctx, project.id, runId);
    const pending = agent.thread(project.id, thread.id).pending!;
    ({ runId } = agent.send(project.id, thread.id, { kind: "answer", questionId: pending.question.id, value: "Memer" }));
    expect((await settled(ctx, project.id, runId)).status).toBe("done");
    expect(received).toEqual(["Memer"]);
    // "Named it Memer." came after the user's answer; thinking-mode endpoints refuse a request that ends there.
    expect(model.requests.at(-1)!.messages.at(-1)!.role).toBe("user");
  });

  it("keeps the fixed questionnaire away from a model engine", async () => {
    const results: string[] = [];
    const script = (req: ChatRequest, step: number): FakeTurn => {
      if (step > 0) results.push(JSON.stringify(req.messages.at(-1)));
      return step === 0 ? { toolCalls: [{ name: "intake_wizard", args: {} }] } : { text: "Asking conversationally instead." };
    };
    const { ctx, agent, project, model } = await boot(script);
    const thread = agent.newThread(project.id);
    const { runId } = agent.send(project.id, thread.id, { kind: "text", text: "我有个新想法" });
    expect((await settled(ctx, project.id, runId)).status).toBe("done");
    expect(model.requests[0].tools?.map((t) => t.name)).not.toContain("intake_wizard");
    expect(results[0]).toContain("fixed questionnaire for engines without a model");
  });
});

describe("dependencies after ticket changes", () => {
  const keyIn = (user: string, title: string) => new RegExp(`(\\S+) "${title}"`).exec(user)?.[1] ?? "";

  it("asks once whether to add what the worker proposes after a turn that creates tickets, and applies it as its own revertible run", async () => {
    const reviews: string[] = [];
    const planned: string[] = [];
    const respond = (system: string, user: string) => {
      if (system.includes("You decompose")) {
        planned.push(system);
        return { epics: [{ title: "Timeline", body: "", features: [{ title: "Define the record model", body: "" }, { title: "Show the chronicle view", body: "" }] }] };
      }
      if (system.includes("dependencies between backlog tickets")) {
        reviews.push(user);
        return { add: [{ prerequisite: keyIn(user, "Define the record model"), dependent: keyIn(user, "Show the chronicle view"), reason: "The view reads the model." }] };
      }
      return { duplicates: [], related: [] };
    };
    const script = (_req: ChatRequest, step: number): FakeTurn =>
      step === 0 ? { toolCalls: [{ name: "plan_and_apply", args: { requirement: "A life log app", rootTitle: "Life log" } }] } : { text: "Planned." };
    const { ctx, agent, items, project } = await boot(script, respond);
    const thread = agent.newThread(project.id);
    const first = agent.send(project.id, thread.id, { kind: "text", text: "plan it" });
    expect((await settled(ctx, project.id, first.runId)).status).toBe("asked");
    expect(planned[0]).toContain("Write every title, body and note in English");
    expect(reviews).toHaveLength(0);
    const plan = agent.thread(project.id, thread.id).pending!;
    const written = agent.send(project.id, thread.id, { kind: "answer", questionId: plan.question.id, value: "Apply" });
    expect((await settled(ctx, project.id, written.runId)).status).toBe("asked");
    expect(reviews).toHaveLength(1);
    const byTitle = (title: string) => items.list({ projectId: project.id }).find((i) => i.title === title)!;
    const model = byTitle("Define the record model");
    const view = byTitle("Show the chronicle view");
    expect(reviews[0]).toContain(`created: ${model.key} "Define the record model"`);
    const pending = agent.thread(project.id, thread.id).pending!;
    expect(pending.question.text).toContain(`+ ${model.key} Define the record… → ${view.key} Show the chronicle… — The view reads the model.`);
    expect(pending.question.options).toEqual(["Update now", "Not now"]);

    const second = agent.send(project.id, thread.id, { kind: "answer", questionId: pending.question.id, value: "Update now" });
    const applied = await settled(ctx, project.id, second.runId);
    expect(byTitle("Define the record model").blocks).toEqual([view.id]);
    // The edit is the answer's run: counted, revertible, and not itself a change that asks again.
    expect(applied).toMatchObject({ status: "done", changes: 1 });
    expect(reviews).toHaveLength(1);
    expect(agent.thread(project.id, thread.id).pending).toBeNull();
    agent.revert(project.id, second.runId);
    expect(byTitle("Define the record model").blocks).toEqual([]);
  });

  it("carries a cancelled ticket's dependencies to its replacement, checking after the question its turn ended on", async () => {
    const reviews: string[] = [];
    const respond = (system: string, user: string) => {
      if (!system.includes("dependencies between backlog tickets")) return { duplicates: [], related: [] };
      reviews.push(user);
      return { add: [{ prerequisite: keyIn(user, "New sync design"), dependent: ids.shipKey, reason: "Sync ships on the new design." }] };
    };
    let ids = { old: "", shipKey: "" };
    const script = (_req: ChatRequest, step: number): FakeTurn => {
      if (step === 0) return { toolCalls: [{ name: "find_similar", args: { title: "New sync design" } }] };
      if (step === 1) return { toolCalls: [{ name: "change_status", args: { id: ids.old, status: "cancelled" } }, { name: "create_item", args: { title: "New sync design" } }] };
      if (step === 2) return { toolCalls: [{ name: "ask_user", args: { question: "Anything else?", options: ["No"] } }] };
      return { text: "OK." };
    };
    const { ctx, agent, items, board, project } = await boot(script, respond);
    const old = items.create({ projectId: project.id, boardId: board.id, title: "Old sync design", by: "human" });
    const ship = items.create({ projectId: project.id, boardId: board.id, title: "Ship sync", by: "human" });
    items.update(project.id, old.id, { blocks: [ship.id] }, "human");
    ids = { old: old.id, shipKey: ship.key };
    const thread = agent.newThread(project.id);
    const first = agent.send(project.id, thread.id, { kind: "text", text: "the sync design changed completely" });
    expect((await settled(ctx, project.id, first.runId)).status).toBe("asked");
    // The turn already ends on its own question; the check waits for the next turn rather than being dropped.
    expect(reviews).toHaveLength(0);
    const asked = agent.thread(project.id, thread.id).pending!;
    const second = agent.send(project.id, thread.id, { kind: "answer", questionId: asked.question.id, value: "No" });
    expect((await settled(ctx, project.id, second.runId)).status).toBe("asked");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain(`cancelled: ${old.key} "Old sync design" (it blocked ${ship.key})`);
    const replacement = items.list({ projectId: project.id }).find((i) => i.title === "New sync design")!;
    expect(reviews[0]).toContain(`created: ${replacement.key} "New sync design"`);
    expect(agent.thread(project.id, thread.id).pending!.question.text).toContain(`+ ${replacement.key} New sync design → ${ship.key} Ship sync`);
  });

  it("says why a check asked for by name could not run, instead of reading as nothing to change", async () => {
    const results: string[] = [];
    const respond = (system: string): unknown => {
      if (system.includes("dependencies between backlog tickets")) throw new Error('LLM request failed 402: {"error":{"message":"Insufficient Balance","type":"insufficient_balance_error"}}');
      return { duplicates: [], related: [] };
    };
    // Each run asks for the check, then reads its result; the step count runs on across runs.
    const script = (req: ChatRequest): FakeTurn => {
      const last = JSON.stringify(req.messages.at(-1));
      if (last.includes("recheck the dependencies")) return { toolCalls: [{ name: "review_dependencies", args: {} }] };
      results.push(last);
      return { text: "Reported." };
    };
    const { ctx, agent, items, board, project } = await boot(script, respond);
    items.create({ projectId: project.id, boardId: board.id, title: "Anything", by: "human" });
    const notes = (threadId: string, runId: string) => agent.store.messages(project.id, threadId).filter((m) => m.runId === runId && m.block.type === "note").map((m) => (m.block as { text: string }).text);

    const thread = agent.newThread(project.id);
    const failed = agent.send(project.id, thread.id, { kind: "text", text: "recheck the dependencies" });
    expect((await settled(ctx, project.id, failed.runId)).status).toBe("done");
    expect(results[0]).toContain("LLM request failed 402: Insufficient Balance");
    expect(notes(thread.id, failed.runId)).toEqual(["Could not check dependencies: LLM request failed 402: Insufficient Balance"]);

    // No worker at all reads the same way, naming where to set one up.
    (ctx.get("llm") as { worker: () => Promise<unknown> }).worker = async () => ({ ok: false });
    const again = agent.newThread(project.id);
    const unset = agent.send(project.id, again.id, { kind: "text", text: "recheck the dependencies" });
    expect((await settled(ctx, project.id, unset.runId)).status).toBe("done");
    expect(results[1]).toContain("no worker model is set up and ready");
    expect(notes(again.id, unset.runId)).toEqual(["Could not check dependencies: no worker model is set up and ready (Settings → Models)"]);
  });
});

describe("a conversation's project", () => {
  it("names the project it belongs to and keeps every tool inside it, even when that project is empty", async () => {
    const systems: string[] = [];
    const results: string[] = [];
    let other = "";
    const script = (req: ChatRequest, step: number): FakeTurn => {
      // The pending question rides in the volatile tail, after the cached system text.
      systems.push([req.system ?? "", req.systemTail ?? ""].join("\n\n"));
      if (step > 0) results.push(JSON.stringify(req.messages.at(-1)));
      if (step === 0) return { toolCalls: [{ name: "list_projects", args: {} }, { name: "list_items", args: {} }] };
      if (step === 1) return { toolCalls: [{ name: "list_items", args: { projectId: other } }] };
      return { text: "This project is new and empty." };
    };
    const { ctx, agent, items, board, project, projects } = await boot(script);
    items.create({ projectId: project.id, boardId: board.id, title: "Old project work", by: "human" });
    other = project.id;
    const memer = projects.create({ name: "Memer", keyPrefix: "MEM" });
    const thread = agent.newThread(memer.id);
    const { runId } = agent.send(memer.id, thread.id, { kind: "text", text: "现在要干啥" });
    expect((await settled(ctx, memer.id, runId)).status).toBe("done");
    expect(systems[0]).toContain('This conversation belongs to the project "Memer" (its keys look like MEM-1)');
    expect(results[0]).toMatch(/Memer[^}]*current\\":true/);
    expect(results[0]).toContain("[]");
    // The other project's work is refused, not read.
    expect(results[1]).toContain("is another project");
    expect(results[1]).not.toContain("Old project work");
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

  it("stops a run whose project is closed under it, and the run ends without writing there or rejecting unhandled", async () => {
    const { agent, project, projects } = await boot([]);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let working = false;
      let stopped = false;
      agent.engine({
        id: "waiting",
        title: "Waiting engine",
        author: "ai:test",
        available: async () => ({ ok: true }),
        turn: (_input, io) => new Promise((resolve) => {
          working = true;
          io.signal.addEventListener("abort", () => { stopped = true; resolve({ stop: "cancelled" }); }, { once: true });
        })
      });
      const thread = agent.newThread(project.id, "waiting");
      agent.send(project.id, thread.id, { kind: "text", text: "take your time" });
      await vi.waitFor(() => expect(working).toBe(true));
      projects.remove(project.id);
      await vi.waitFor(() => expect(agent.activeRuns()).toHaveLength(0));
      await new Promise((r) => setTimeout(r, 50));
      expect(stopped).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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

  it("takes empty overrides for an engine that has never been configured", async () => {
    const { agent, project } = await boot([]);
    const thread = agent.newThread(project.id, "loop");

    expect(agent.optionsOf(agent.store.thread(project.id, thread.id)!, "loop")).toEqual({});
    // An empty override set is not a preference: it is stored as none, and the engine's settings stay in charge.
    expect(agent.setOptions(project.id, thread.id, {}).options).toBeNull();
    expect(agent.optionsOf(agent.store.thread(project.id, thread.id)!, "loop")).toEqual({});
  });

  it("starts a thread whose engine has an options schema but no saved settings", async () => {
    const { agent, project } = await boot([]);
    // The built-in agent's shape: every field optional, so an empty object is the default everything.
    agent.engine({
      id: "knobs",
      title: "Knobs",
      author: "ai:test",
      available: async () => ({ ok: true }),
      options: z.object({ profile: z.string().optional(), effort: z.string().optional() }),
      turn: async () => ({ stop: "end" })
    });
    const thread = agent.newThread(project.id, "knobs");

    // What the Start dialog sends when model and effort both stay default.
    expect(() => agent.setOptions(project.id, thread.id, {})).not.toThrow();
    expect(agent.optionsOf(agent.store.thread(project.id, thread.id)!, "knobs")).toEqual({});
  });

  it("drops options the engine rejects rather than leaving a thread that cannot run", async () => {
    const { agent, project } = await boot([]);
    const thread = agent.newThread(project.id, "loop", null, { options: { effort: 42 } });

    expect(thread.engine).toBe("loop");
    expect(thread.options).toBeNull();
  });
});

describe("the scripted engine", () => {
  it("starts the intake wizard from the dossier the thread already holds", async () => {
    const { ctx, agent, project } = await boot([]);
    const thread = agent.newThread(project.id, "scripted");
    agent.store.setCard(project.id, thread.id, { id: "dossier", schema: "backlog.dossier", title: "Requirement dossier", data: { goal: "Keep a person's life in one timeline", outcomes: ["Browse by time"] } }, "human");
    let { runId } = agent.send(project.id, thread.id, { kind: "text", text: "hi" });
    await settled(ctx, project.id, runId);
    const menu = agent.thread(project.id, thread.id).pending!;
    ({ runId } = agent.send(project.id, thread.id, { kind: "answer", questionId: menu.question.id, value: "Requirement intake (fixed questions)" }));
    await settled(ctx, project.id, runId);
    // What the dossier already holds is never asked again, and the wizard does not write over it.
    expect(agent.thread(project.id, thread.id).pending!.question.text).toContain("(3/5) What materials");
    const pending = agent.thread(project.id, thread.id).pending!;
    ({ runId } = agent.send(project.id, thread.id, { kind: "answer", questionId: pending.question.id, value: "-" }));
    await settled(ctx, project.id, runId);
    const dossier = agent.thread(project.id, thread.id).cards.find((c) => c.id === "dossier")!.data as { goal: string; outcomes: string[]; materials: string[] };
    expect(dossier).toMatchObject({ goal: "Keep a person's life in one timeline", outcomes: ["Browse by time"], materials: ["-"] });
  });

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
    for (const [i, answer] of answers.entries()) {
      pending = agent.thread(project.id, thread.id).pending!;
      // Typed into the composer or given through the question, an engine without a model takes it as the answer.
      ({ runId } = agent.send(project.id, thread.id, i === 2 ? { kind: "text", text: answer } : { kind: "answer", questionId: pending.question.id, value: answer }));
      run = await settled(ctx, project.id, runId);
    }
    expect((agent.thread(project.id, thread.id).cards.find((c) => c.id === "dossier")!.data as { materials: string[] }).materials).toEqual(["Existing notes"]);
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
