/**
 * The system prompt's two parts: what a provider caches across a conversation's
 * turns, and what each turn changes. The stable part must not move when cards,
 * a pending question, media or the files index do.
 */
import { expect, it } from "vitest";
import { promptParts, promptSections, type TurnInput, type TurnIO } from "@tomradex/agent";

const io = { playbooks: { index: () => [{ id: "backlog.intake", when: "a new requirement" }] } } as unknown as TurnIO;
const base = (): TurnInput =>
  ({
    threadId: "t",
    projectId: "p",
    project: { name: "Shop", keyPrefix: "SH" },
    purpose: "backlog",
    input: { kind: "text", text: "hi" },
    messages: [],
    cards: [],
    brief: "Products are pulled from the supplier feed.",
    rules: "- Write tickets in Chinese",
    pending: null,
    options: undefined,
    repositories: [{ workstream: "App", name: "app", path: "/code/app", defaultBranch: "main" }]
  }) as TurnInput;

it("keeps the stable part byte-identical across turns while the volatile part changes", () => {
  const first = promptParts(base(), io);
  const second = promptParts(
    {
      ...base(),
      cards: [{ id: "dossier", schema: "backlog.dossier", title: "Requirement dossier", data: { goal: "compare prices" } }],
      pending: { threadId: "t", kind: "workflow", workflow: "plan_and_apply", question: { id: "q1", text: "Apply the plan?", options: ["Apply", "Cancel"] } },
      filesIndex: { markdown: "Files: spec.md", digest: "d2" },
      messages: [{ id: "m1", threadId: "t", seq: 1, role: "assistant", block: { type: "media", media: { id: "img1", name: "chart.png", mime: "image/png" } }, runId: null, at: 1 }]
    } as TurnInput,
    io
  );
  expect(second.stable).toEqual(first.stable);
  expect(first.stable.join("\n")).toContain("Project brief:\nProducts are pulled from the supplier feed.");
  expect(first.stable.join("\n")).toContain("- Write tickets in Chinese");
  expect(first.stable.join("\n")).toContain("Playbooks");
  expect(first.stable.join("\n")).toContain("Workstream repositories");
  expect(first.volatile).toEqual([]);
  expect(second.volatile.join("\n")).toContain("Conversation media");
  expect(second.volatile.join("\n")).toContain("Files: spec.md");
  expect(second.volatile.join("\n")).toContain('Card "Requirement dossier"');
  expect(second.volatile.join("\n")).toContain("A workflow is waiting on");
  // Nothing time-bound in the cached part.
  expect(first.stable.join("\n")).not.toMatch(/\b20\d\d-\d\d-\d\d\b|\d{13}/);
});

it("still hands engines one list, stable first", () => {
  const input = { ...base(), cards: [{ id: "c", schema: "s", title: "Card", data: {} }] } as TurnInput;
  const parts = promptParts(input, io);
  expect(promptSections(input, io)).toEqual([...parts.stable, ...parts.volatile]);
});
