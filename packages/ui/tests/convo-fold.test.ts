import { expect, it } from "vitest";
import { codingFromLines, foldTools, workConclusion, workLabel, type ConvoEntry, type ConvoLine } from "../src/lib/convoFold";

let key = 0;
const line = (who: ConvoLine["who"], text: string, output?: string): ConvoLine => ({ key: key++, who, text, ...(output !== undefined ? { detail: { input: text, output } } : {}) });
const say = (k: string, vars?: Record<string, string | number>) => `${k}:${vars?.n ?? ""}`;

it("folds a long run of an agent record's tool calls but its last three, and says what they came to", () => {
  const lines = [line("person", "go"), line("tool", "Edit · src/a.ts"), line("tool", "Write · src/b.ts"), line("tool", "Bash · pnpm test", "Tests  4 passed"), line("tool", "Read · x"), line("tool", "Read · y"), line("tool", "Read · z"), line("agent", "done")];
  // read as chat: it writes nothing from here on
  const out = foldTools(lines, -1);
  expect(out.map((e) => ("fold" in e ? `fold${e.fold.length}` : e.who))).toEqual(["person", "fold3", "tool", "tool", "tool", "agent"]);
  const fold = out[1] as { fold: ConvoLine[]; work: Parameters<typeof workLabel>[0] };
  expect(workLabel(fold.work, say)).toBe("convoSteps:3 · convoFiles:2 · convoCommand:1 · convoPassed:4");
});

it("leaves a short run as it is", () => {
  const out = foldTools([line("tool", "Bash · ls"), line("tool", "Bash · pwd"), line("tool", "Read · a"), line("tool", "Read · b")]);
  expect(out.every((e) => !("fold" in e))).toBe(true);
});

const shape = (out: ConvoEntry[]) => out.map((e) => ("fold" in e ? `${e.coding ? "work" : "fold"}${e.fold.length}` : e.who));

it("folds each turn of writing code whole, with what the agent said between its calls, under its conclusion", () => {
  const lines = [line("person", "look"), line("tool", "Read · a"), line("agent", "it is a"), line("person", "fix it"), line("tool", "Read · a"), line("tool", "Edit · src/a.ts"), line("agent", "now tests"), line("tool", "Bash · pnpm test", "Tests  8 passed"), line("agent", "done"), line("person", "more"), line("tool", "Write · b.ts")];
  expect(codingFromLines(lines)).toBe(4);
  const out = foldTools(lines);
  expect(shape(out)).toEqual(["person", "tool", "agent", "person", "work4", "agent", "person", "work1"]);
  const work = out[4] as Extract<ConvoEntry, { fold: ConvoLine[] }>;
  expect(workConclusion(work.work, say, work.waiting)).toBe("convoFile:1 · convoCommand:1 · convoPassed:8");
  // a stretch that only read says how many steps it took
  expect(workConclusion({ steps: 2, files: 0, commands: 0, passed: null, failed: null }, say)).toBe("convoSteps:2");
});

it("says the last stretch waits on the person, with the command its last call names", () => {
  const lines = [line("person", "go"), line("tool", "Edit · a.ts", ""), line("tool", "Bash · pnpm test")];
  const out = foldTools(lines, 0, true);
  const work = out[1] as Extract<ConvoEntry, { fold: ConvoLine[] }>;
  expect(work.waiting).toBe("pnpm test");
  expect(workConclusion(work.work, say, work.waiting)).toBe("convoFile:1 · convoCommand:1 · convoWaitingFor:");
  expect((foldTools(lines, 0, false)[1] as Extract<ConvoEntry, { fold: ConvoLine[] }>).waiting).toBeNull();
});
