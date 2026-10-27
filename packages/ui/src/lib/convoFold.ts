import { changesFile, workDone, type WorkDone } from "./steps";

/** One line of a conversation read back from an agent's record, with the key the view holds it by. */
export interface ConvoLine {
  key: number;
  /** `mark`: a moment of the session's own, said in the view's words — a claim, a pull request linked, a return to a ticket. */
  who: "person" | "agent" | "tool" | "mark";
  text: string;
  detail?: { input: string; output?: string };
}

export type ConvoWordKey =
  | "convoCopy" | "convoCopied" | "convoInput" | "convoOutput" | "convoNoOutput" | "convoEarlier" | "convoReading" | "convoStart"
  | "convoSteps" | "convoFile" | "convoFiles" | "convoCommand" | "convoCommands" | "convoPassed" | "convoFailed" | "convoWaitingFor" | "convoWaiting";
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

/**
 * A stretch of writing code, said by its conclusion alone: "2 files changed · tests 8 passed", and what it waits on —
 * "waiting for you to allow `pnpm test`". Its count of steps only when nothing else can be said.
 */
export function workConclusion(work: WorkDone, say: ConvoSay, waiting?: string | null): string {
  const parts = workParts(work, say);
  if (waiting !== undefined && waiting !== null) parts.push(waiting ? say("convoWaitingFor", { what: waiting }) : say("convoWaiting"));
  return (parts.length ? parts : [say("convoSteps", { n: work.steps })]).join(" · ");
}

/** Steps kept open at the end of a run of tool calls before the conversation writes code; the earlier ones fold, as the assistant's own steps do. */
const OPEN_TOOLS = 3;

/** A folded stretch of tool calls; `coding` and `waiting` as the assistant's own steps have them. */
export type ConvoEntry = ConvoLine | { fold: ConvoLine[]; work: WorkDone; coding?: boolean; waiting?: string | null };

/** A tool line reads "Tool · what": the tool's name, and for one that writes, the file it wrote. */
export const asStep = (l: Pick<ConvoLine, "text" | "detail">) => ({ tool: l.text.split(/[\s·:(]/)[0] ?? "", args: { path: l.text.split(" · ")[1] }, output: l.detail?.output ?? null });

/** Where a record's writing code begins, as an index: the run of tool calls that first changes a file. -1 when it never writes. */
export function codingFromLines(lines: ConvoLine[]): number {
  let at = lines.findIndex((l) => l.who === "tool" && changesFile(asStep(l).tool));
  while (at > 0 && lines[at - 1]!.who === "tool") at--;
  return at;
}

/**
 * A record's lines with its tool calls folded. Before it writes code, each long run of them folds but its last three.
 * From `codeFrom` on, a turn's whole stretch of tool calls — with what the agent said between them — folds into one
 * row, its conclusion left open. `waiting`: the session waits on the person now, so the last stretch says so, with
 * the command it waits on when the record names one (its last call, which has no output yet).
 */
export function foldTools(lines: ConvoLine[], codeFrom = codingFromLines(lines), waiting = false): ConvoEntry[] {
  const out: ConvoEntry[] = [];
  const coding = codeFrom >= 0 ? codeFrom : lines.length;
  let run: ConvoLine[] = [];
  const flush = () => {
    const folded = run.slice(0, Math.max(0, run.length - OPEN_TOOLS));
    if (folded.length > 1) out.push({ fold: folded, work: workDone(folded.map(asStep)) });
    else out.push(...folded);
    out.push(...run.slice(folded.length));
    run = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (i >= coding && line.who === "tool") {
      flush();
      let last = i;
      for (let j = i + 1; j < lines.length && lines[j]!.who !== "person" && lines[j]!.who !== "mark"; j++) if (lines[j]!.who === "tool") last = j;
      const fold = lines.slice(i, last + 1);
      const tools = fold.filter((l) => l.who === "tool");
      const asked = tools.at(-1)!;
      const tail = waiting && !lines.slice(last + 1).some((l) => l.who === "person");
      out.push({ fold, work: workDone(tools.map(asStep)), coding: true, waiting: tail ? (asked.detail?.output === undefined ? (asked.text.split(" · ")[1] ?? "") : "") : null });
      i = last + 1;
      continue;
    }
    if (line.who === "tool" && i < coding) run.push(line);
    else {
      flush();
      out.push(line);
    }
    i++;
  }
  flush();
  return out;
}
