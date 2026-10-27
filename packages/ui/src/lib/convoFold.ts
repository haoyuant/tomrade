import { workDone, type WorkDone } from "./steps";

/** One line of a conversation read back from an agent's record, with the key the view holds it by. */
export interface ConvoLine {
  key: number;
  who: "person" | "agent" | "tool";
  text: string;
  detail?: { input: string; output?: string };
}

export type ConvoWordKey =
  | "convoCopy" | "convoCopied" | "convoInput" | "convoOutput" | "convoNoOutput" | "convoEarlier" | "convoReading" | "convoStart"
  | "convoSteps" | "convoFile" | "convoFiles" | "convoCommand" | "convoCommands" | "convoPassed" | "convoFailed";
/** The words these rows need, from whichever window shows them: the Terminal window's `say`, or the panel's `t` over the same keys. */
export type ConvoSay = (key: ConvoWordKey, vars?: Record<string, string | number>) => string;

/** What a folded stretch of steps came to, beside its count: "2 files changed", "3 commands", "tests 12 passed". */
export function workParts(work: WorkDone, say: ConvoSay): string[] {
  return [
    work.files ? say(work.files === 1 ? "convoFile" : "convoFiles", { n: work.files }) : null,
    work.commands ? say(work.commands === 1 ? "convoCommand" : "convoCommands", { n: work.commands }) : null,
    work.failed ? say("convoFailed", { n: work.failed }) : work.passed !== null ? say("convoPassed", { n: work.passed }) : null
  ].filter((part): part is string => !!part);
}

/** A folded stretch of steps, said by what it came to: "5 steps · 2 files changed · 3 commands · tests 12 passed". */
export const workLabel = (work: WorkDone, say: ConvoSay): string => [say("convoSteps", { n: work.steps }), ...workParts(work, say)].join(" · ");

/** Steps kept open at the end of a run of tool calls; the earlier ones fold, as the assistant's own steps do. */
const OPEN_TOOLS = 3;

export type ConvoEntry = ConvoLine | { fold: ConvoLine[]; work: WorkDone };

/** A tool line reads "Tool · what": the tool's name, and for one that writes, the file it wrote. */
const asStep = (l: ConvoLine) => ({ tool: l.text.split(/[\s·:(]/)[0] ?? "", args: { path: l.text.split(" · ")[1] }, output: l.detail?.output ?? null });

/** A record's lines with each long run of tool calls folded but its last three. */
export function foldTools(lines: ConvoLine[]): ConvoEntry[] {
  const out: ConvoEntry[] = [];
  let run: ConvoLine[] = [];
  const flush = () => {
    const folded = run.slice(0, Math.max(0, run.length - OPEN_TOOLS));
    if (folded.length > 1) out.push({ fold: folded, work: workDone(folded.map(asStep)) });
    else out.push(...folded);
    out.push(...run.slice(folded.length));
    run = [];
  };
  for (const line of lines) {
    if (line.who === "tool") run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}
