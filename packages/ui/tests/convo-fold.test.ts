import { expect, it } from "vitest";
import { foldTools, workLabel, type ConvoLine } from "../src/lib/convoFold";

let key = 0;
const line = (who: ConvoLine["who"], text: string, output?: string): ConvoLine => ({ key: key++, who, text, ...(output !== undefined ? { detail: { input: text, output } } : {}) });
const say = (k: string, vars?: Record<string, string | number>) => `${k}:${vars?.n ?? ""}`;

it("folds a long run of an agent record's tool calls but its last three, and says what they came to", () => {
  const lines = [line("person", "go"), line("tool", "Edit · src/a.ts"), line("tool", "Write · src/b.ts"), line("tool", "Bash · pnpm test", "Tests  4 passed"), line("tool", "Read · x"), line("tool", "Read · y"), line("tool", "Read · z"), line("agent", "done")];
  const out = foldTools(lines);
  expect(out.map((e) => ("fold" in e ? `fold${e.fold.length}` : e.who))).toEqual(["person", "fold3", "tool", "tool", "tool", "agent"]);
  const fold = out[1] as { fold: ConvoLine[]; work: Parameters<typeof workLabel>[0] };
  expect(workLabel(fold.work, say)).toBe("convoSteps:3 · convoFiles:2 · convoCommand:1 · convoPassed:4");
});

it("leaves a short run as it is", () => {
  const out = foldTools([line("tool", "Bash · ls"), line("tool", "Bash · pwd"), line("tool", "Read · a"), line("tool", "Read · b")]);
  expect(out.every((e) => !("fold" in e))).toBe(true);
});
