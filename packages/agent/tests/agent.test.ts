import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { fresh, settle } from "@tomrade/testkit";
import { Tools } from "@tomrade/tools";
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

async function settled(ctx: Context, runId: string, timeout = 8000): Promise<RunView> {
  const t0 = Date.now();
  for (;;) {
    const run = ctx.agent.store.run(runId);
    if (run && run.status !== "running") return run;
    if (Date.now() - t0 > timeout) throw new Error("run did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the loop engine on the platform", () => {
  it("answers chit-chat with no tools and no writes", async () => {
    const { ctx, agent, project } = await boot([{ text: "It never rains in the backlog." }]);
    const thread = agent.newThread(project.id);
    expect(thread.engine).toBe("loop");
    const { runId } = agent.send(thread.id, { kind: "text", text: "今天天气怎么样" });
    const run = await settled(ctx, runId);
    expect(run.status).toBe("done");
    expect(run.changes).toBe(0);
    const blocks = agent.store.messages(thread.id).map((m) => m.block);
    expect(blocks.some((b) => b.type === "text" && b.text.includes("never rains"))).toBe(true);
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
    const { runId } = agent.send(thread.id, { kind: "text", text: "加一个连续7天达标给徽章的功能" });
    const run = await settled(ctx, runId);
    expect(run.status).toBe("done");
    const created = items.list({ projectId: project.id }).filter((i) => i.title === title);
    expect(created).toHaveLength(1);
    expect(run.changes).toBe(1);
    const ledger = agent.store.messages(thread.id).filter((m) => m.block.type === "trace").map((m) => (m.block.type === "trace" ? `${m.block.tool}:${m.block.ok}` : ""));
    expect(ledger).toEqual(["create_item:false", "find_similar:true", "create_item:true"]);
    // the run-scoped undo reaches it
    const undone = agent.revert(runId);
    expect(undone.reverted).toBe(1);
    expect(items.list({ projectId: project.id }).filter((i) => i.title === title)).toHaveLength(0);
  });

  it("suspends on ask_user and resumes with the answer", async () => {
    const script = (_req: ChatRequest, step: number): FakeTurn =>
      step === 0 ? { toolCalls: [{ name: "ask_user", args: { question: "Merge the two duplicates?", options: ["Do it", "Leave them"] } }] } : { text: "Leaving them alone." };
    const { ctx, agent, project } = await boot(script);
    const thread = agent.newThread(project.id);
    const first = agent.send(thread.id, { kind: "text", text: "整理一下 backlog" });
    const run1 = await settled(ctx, first.runId);
    expect(run1.status).toBe("asked");
    const detail = agent.thread(thread.id);
    expect(detail.pending?.question.options).toEqual(["Do it", "Leave them"]);

    const second = agent.send(thread.id, { kind: "answer", questionId: detail.pending!.question.id, value: "Leave them" });
    const run2 = await settled(ctx, second.runId);
    expect(run2.status).toBe("done");
    expect(agent.thread(thread.id).pending).toBeNull();
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
    const { runId } = agent.send(thread.id, { kind: "text", text: "拆一下这个需求" });
    const run = await settled(ctx, runId);
    expect(run.status).toBe("done");
    // 1 root epic + 2 epics + 3 features
    expect(run.changes).toBe(6);
    const all = items.list({ projectId: project.id });
    const root = all.find((i) => i.title === "Water reminder");
    expect(root?.kind).toBe("epic");
    expect(all.filter((i) => i.parentId === root?.id)).toHaveLength(2);

    const undone = agent.revert(runId);
    expect(undone.reverted).toBe(6);
    expect(items.list({ projectId: project.id }).find((i) => i.title === "Water reminder")).toBeUndefined();
  });
});

describe("the scripted engine", () => {
  it("walks the intake wizard deterministically and stores the dossier card", async () => {
    const { ctx, agent, project } = await boot([]);
    const thread = agent.newThread(project.id, "scripted");
    let { runId } = agent.send(thread.id, { kind: "text", text: "hi" });
    let run = await settled(ctx, runId);
    expect(run.status).toBe("asked");
    let pending = agent.thread(thread.id).pending!;
    expect(pending.question.options).toContain("Requirement intake (fixed questions)");

    const answers = [
      "Requirement intake (fixed questions)",
      "Help me drink enough water every day",
      "Just me",
      "Flutter mobile app",
      "log water, remind me, show progress",
      "-",
      "7-day streak of hitting the goal"
    ];
    for (const answer of answers) {
      pending = agent.thread(thread.id).pending!;
      ({ runId } = agent.send(thread.id, { kind: "answer", questionId: pending.question.id, value: answer }));
      run = await settled(ctx, runId);
    }
    // All six fields answered → the confirm question is now waiting.
    pending = agent.thread(thread.id).pending!;
    expect(pending.question.text).toContain("Plan the backlog");
    ({ runId } = agent.send(thread.id, { kind: "answer", questionId: pending.question.id, value: "Stop" }));
    run = await settled(ctx, runId);
    expect(run.status).toBe("done");
    const card = agent.thread(thread.id).cards.find((c) => c.id === "dossier");
    expect(card).toBeTruthy();
    expect((card!.data as { platform: string }).platform).toBe("Flutter mobile app");
    expect(run.changes).toBe(0);
  });
});
