import { describe, expect, it } from "vitest";
import { emptyDossier, overlap, readiness, renderDossier } from "@tomrade/agent-backlog";
import { findSimilar, PLAYBOOKS } from "@tomrade/agent-backlog";
import type { Item } from "@tomrade/domain";

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
  updatedAt: 0,
  updatedBy: "human",
  version: 1,
  humanLocked: false,
  ...extra
});

describe("readiness", () => {
  it("counts the six required fields and names the missing ones", () => {
    const d = emptyDossier();
    expect(readiness(d)).toEqual({ filled: 0, required: 6, missing: ["goal", "users", "platform", "coreLoop", "outOfScope", "successSignal"] });
    d.goal = "hydrate";
    d.outOfScope = ["-"];
    expect(readiness(d).filled).toBe(2);
    expect(renderDossier(d)).toContain("hydrate");
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
    const { findSimilarBatch } = await import("@tomrade/agent-backlog");
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
  });
});
