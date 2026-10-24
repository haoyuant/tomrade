/**
 * The main conversation's prompt: what it is told about the code before it
 * judges what the code lacks, and where what it learns is to be kept.
 */
import { expect, it } from "vitest";
import { promptSections, type TurnInput, type TurnIO } from "@tomradex/agent";

const turn = (over: Partial<TurnInput>): TurnInput =>
  ({ threadId: "t", projectId: "p", purpose: "backlog", input: { kind: "text", text: "hi" }, messages: [], cards: [], brief: null, pending: null, options: undefined, ...over }) as TurnInput;
const io = { playbooks: { index: () => [] } } as unknown as TurnIO;

it("tells the main conversation to read the repository before saying what is missing, and to keep what it learns in the brief", () => {
  const text = promptSections(turn({ repositories: [{ workstream: "Shop", name: "shop", path: "/code/shop", defaultBranch: "main" }] }), io).join("\n\n");
  expect(text).toContain("read the repository first: CLAUDE.md or AGENTS.md, README, and the module concerned");
  expect(text).toContain("nothing is missing just because no ticket mentions it");
  expect(text).toContain("goes into update_project_brief");
  expect(text).toContain("No project brief is recorded yet");

  const briefed = promptSections(turn({ brief: "Products are pulled from the supplier feed." }), io).join("\n\n");
  expect(briefed).toContain("Project brief:\nProducts are pulled from the supplier feed.");
  expect(briefed).not.toContain("No project brief is recorded yet");
});

it("leaves a ticket's coding turn without the main-conversation rules and the missing-brief line", () => {
  const text = promptSections(turn({ purpose: "code", ticket: { id: "i", key: "TOM-1", title: "T", branch: "b" } }), io).join("\n\n");
  expect(text).not.toContain("read the repository first");
  expect(text).not.toContain("No project brief is recorded yet");
});
