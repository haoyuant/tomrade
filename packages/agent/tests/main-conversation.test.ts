/**
 * What the main conversation is told about each workstream's repository
 * before it plans code work there.
 */
import { expect, it } from "vitest";
import { promptSections, type TurnInput, type TurnIO } from "@tomradex/agent";

const turn = (repositories: TurnInput["repositories"]): TurnInput =>
  ({ threadId: "t", projectId: "p", purpose: "backlog", input: { kind: "text", text: "hi" }, messages: [], cards: [], brief: null, pending: null, options: undefined, repositories }) as TurnInput;
const io = { playbooks: { index: () => [] } } as unknown as TurnIO;
const repo = (over: Partial<NonNullable<TurnInput["repositories"]>[number]>) => ({ workstream: "App", name: "app", path: "/code/app", defaultBranch: "main", ...over });

it("says an empty repository bootstraps before its first code ticket, and that the stack is settled now", () => {
  const text = promptSections(turn([repo({ readiness: "empty" })]), io).join("\n\n");
  expect(text).toContain("- App: app at /code/app (default branch main) — EMPTY: no project in it yet.");
  expect(text).toContain("bootstrap ticket (stack, scaffold, CLAUDE.md), which Tomrade files at Start");
  expect(text).toContain("settle the stack with the user now (ask_user");
  expect(text).toContain("record it with record_decision");
});

it("says a scaffolded repository lacks CLAUDE.md, and nothing about one that is documented or unknown", () => {
  const bare = promptSections(turn([repo({ readiness: "scaffolded", hasBrief: false })]), io).join("\n\n");
  expect(bare).toContain("— has code but no CLAUDE.md yet");
  const documented = promptSections(turn([repo({ readiness: "scaffolded", hasBrief: true }), repo({ workstream: "Web", name: "web", readiness: "unknown" })]), io).join("\n\n");
  expect(documented).not.toContain("no CLAUDE.md");
  expect(documented).not.toContain("EMPTY");
  expect(documented).toMatch(/- Web: web at \/code\/app \(default branch main\)(\n|$)/);
});
