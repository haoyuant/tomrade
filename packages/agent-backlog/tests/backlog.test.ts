import { describe, expect, it } from "vitest";
import { emptyDossier, overlap, readiness, renderDossier } from "@tomradex/agent-backlog";
import { findSimilar, planSchema, proposeDependencies, PLAYBOOKS, REVIEW_TIMEOUT_MS } from "@tomradex/agent-backlog";
import { completeJson, FakeLlm, type ChatModel, type CompletionRequest, type LlmService } from "@tomradex/llm";
import { fresh } from "@tomradex/testkit";
import type { Item } from "@tomradex/domain";

const item = (title: string, extra: Partial<Item> = {}): Item => ({
  id: title,
  projectId: "p",
  boardId: "b",
  keyNum: 1,
  key: "TOM-1",
  title,
  body: null,
  kind: "ticket",
  status: "backlog",
  priority: 2,
  parentId: null,
  rank: 0,
  labels: [],
  blocks: [],
  blockedBy: [],
  updatedAt: 0,
  updatedBy: "human",
  version: 1,
  humanLocked: false,
  ...extra
});

describe("readiness", () => {
  it("collects universal requirements without requiring a software platform", () => {
    const d = emptyDossier();
    expect(readiness(d)).toEqual({ filled: 0, required: 5, missing: ["goal", "materials", "constraints", "outcomes", "successSignal"] });
    d.goal = "hydrate";
    d.materials = ["-"];
    expect(readiness(d).filled).toBe(2);
    expect(renderDossier(d)).toContain("hydrate");
    d.constraints = ["-"];
    d.outcomes = ["A completed human activity"];
    d.successSignal = "The person confirms completion";
    expect(readiness(d).missing).toEqual([]);
    expect(d.platform).toBe("");
  });
});

describe("planSchema", () => {
  it("reads priorities written as words and drops what it cannot read instead of failing the plan", () => {
    const plan = planSchema.parse({
      epics: [{ title: "Capture", features: [{ title: "a", priority: "high" }, { title: "b", priority: "紧急" }, { title: "c", priority: "soon", workType: "design" }, { title: "d", priority: 2, workType: "general", body: null }] }]
    });
    expect(plan.epics[0].features.map((f) => [f.priority, f.workType, f.body])).toEqual([[3, undefined, ""], [4, undefined, ""], [undefined, undefined, ""], [2, "general", ""]]);
  });
});

describe("overlap", () => {
  it("scores latin words and CJK bigrams", () => {
    expect(overlap("Send interval reminders", "Send reminders at an interval")).toBeGreaterThan(0.5);
    expect(overlap("每天提醒喝水", "喝水提醒功能")).toBeGreaterThan(0.3);
    expect(overlap("Send reminders", "Delete the database")).toBe(0);
  });
});

describe("findSimilar without a model", () => {
  it("falls back to lexical verdicts", async () => {
    const existing = [item("Send interval water reminders"), item("Export data as CSV")];
    const dup = await findSimilar(null, { title: "Send water reminders at intervals" }, existing);
    expect(dup.verdict).not.toBe("none");
    expect(dup.matches[0].title).toBe("Send interval water reminders");
    const none = await findSimilar(null, { title: "Add a dark theme" }, existing);
    expect(none.matches).toHaveLength(0);
  });
});

describe("findSimilarBatch without a model", () => {
  it("answers every proposal from one pass", async () => {
    const { findSimilarBatch } = await import("@tomradex/agent-backlog");
    const existing = [item("Send interval water reminders"), item("Export data as CSV")];
    const results = await findSimilarBatch(null, [{ title: "Send water reminders at intervals" }, { title: "Add a dark theme" }], existing);
    expect(results).toHaveLength(2);
    expect(results[0].verdict).not.toBe("none");
    expect(results[1].matches).toHaveLength(0);
  });
});

describe("the backlog playbooks", () => {
  it("ship as SKILL.md files and load complete", () => {
    expect(PLAYBOOKS.map((p) => p.id).sort()).toEqual(["backlog.decompose", "backlog.groom", "backlog.intake", "backlog.quick-feature"]);
    for (const playbook of PLAYBOOKS) {
      expect(playbook.when.length, playbook.id).toBeGreaterThan(20);
      expect(playbook.body.length, playbook.id).toBeGreaterThan(100);
      expect(playbook.tools.length, playbook.id).toBeGreaterThan(0);
    }
    // details the method depends on survived the move to files
    expect(PLAYBOOKS.find((p) => p.id === "backlog.quick-feature")!.body).toContain("dedup-before-create");
    expect(PLAYBOOKS.find((p) => p.id === "backlog.intake")!.body).toContain("plan_and_apply");
    // A new codebase's stack is settled with the user before planning, and recorded where the bootstrap reads it.
    for (const id of ["backlog.intake", "backlog.decompose"]) expect(PLAYBOOKS.find((p) => p.id === id)!.body, id).toMatch(/tech stack[\s\S]*record_decision/);
  });
});

describe("proposeDependencies", () => {
  it("keeps what the worker proposes only when it is new, points at open tickets, closes no cycle and is not implied by the rest", async () => {
    const { ctx, items, board, project } = await fresh();
    const make = (title: string, status: Item["status"] = "todo") => items.create({ projectId: project.id, boardId: board.id, title, status, by: "human" });
    const [model, importer, view, done] = [make("Model"), make("Import"), make("View"), make("Shipped", "done")];
    items.update(project.id, model.id, { blocks: [importer.id] }, "human");
    const edge = (prerequisite: Item, dependent: Item) => ({ prerequisite: prerequisite.key, dependent: dependent.key, reason: "r" });
    const llm = new FakeLlm(() => ({
      add: [edge(importer, view), edge(model, view), edge(model, importer), edge(view, model), edge(model, done), edge(model, model), { prerequisite: "NOPE-1", dependent: view.key }],
      remove: [edge(importer, model)]
    }));
    const proposal = await proposeDependencies(ctx, llm, project.id, []);
    expect(proposal.add.map((e) => `${e.from}>${e.to}`)).toEqual([`${importer.key}>${view.key}`]);
    expect(proposal.remove).toEqual([]);
  });
});

describe("the dependency review's model call", () => {
  // Never answers: a model that reasons for longer than the review waits.
  const hung: ChatModel = { capabilities: { tools: false, streaming: true, json: true }, chat: async function* () { await new Promise(() => {}); } };
  const worker = (seen: CompletionRequest[]) => ({ completeJson: (schema, request) => (seen.push(request), completeJson(hung, schema, request, "DeepSeek (deepseek-flash)")) }) as Pick<LlmService, "completeJson"> as LlmService;

  it("is given up after its time limit, and ends with the run's stop", async () => {
    const { ctx, project } = await fresh();
    const seen: CompletionRequest[] = [];
    await expect(proposeDependencies(ctx, worker(seen), project.id, [], { timeoutMs: 50 })).rejects.toThrow(/did not answer within 0.05s/);
    const stop = new AbortController();
    const pending = proposeDependencies(ctx, worker(seen), project.id, [], { signal: stop.signal });
    stop.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
    expect(seen[1]).toMatchObject({ timeoutMs: REVIEW_TIMEOUT_MS, signal: stop.signal });
  });
});
