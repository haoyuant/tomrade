import type { Block, ThreadMessage } from "@tomradex/agent";
import type { MessageKey } from "./i18n";

export function traceState(block: Extract<Block, { type: "trace" }>): { failed: boolean; icon: "i-check" | "i-warn" | "i-stop" | "i-clock" | "i-search"; label: MessageKey | null } {
  const status = block.commandResult?.status;
  if (!status) return { failed: !block.ok, icon: block.ok ? "i-check" : "i-warn", label: null };
  const states = {
    success: { failed: false, icon: "i-check", label: "agentPanel.commandSuccess" },
    "no-match": { failed: false, icon: "i-search", label: "agentPanel.commandNoMatch" },
    "condition-false": { failed: false, icon: "i-search", label: "agentPanel.commandConditionFalse" },
    failed: { failed: true, icon: "i-warn", label: "agentPanel.commandFailed" },
    declined: { failed: false, icon: "i-stop", label: "agentPanel.commandDeclined" },
    "timed-out": { failed: false, icon: "i-clock", label: "agentPanel.commandTimedOut" },
    interrupted: { failed: false, icon: "i-stop", label: "agentPanel.commandInterrupted" }
  } as const;
  return states[status];
}

/** Steps kept open at the end of a run of them before the conversation writes code; earlier successful ones fold. */
const OPEN_STEPS = 3;

/** What a stretch of steps came to, for the line that stands in for them folded. */
export interface WorkDone {
  steps: number;
  /** Distinct files a step wrote or edited. */
  files: number;
  commands: number;
  /** From the last test output among them that counts its results; null when none did. */
  passed: number | null;
  failed: number | null;
}

/** One step as the summary reads it: a tool's name, its arguments when there are any, what it printed. */
export interface WorkStep {
  tool: string;
  args?: unknown;
  output?: string | null;
}

// Tool names across the built-in agent, Pi, Claude Code and Codex records: the ones that change a file, and the shells.
const FILE_TOOL = /^(?:write|edit|multi_?edit|apply_?patch|write_?file|edit_?file|create_?file|str_?replace\w*|notebook_?edit)$/i;
const COMMAND_TOOL = /^(?:bash|shell|exec|run_?command|command|terminal)$/i;

/** Whether a tool by this name changes a file. */
export const changesFile = (tool: string): boolean => FILE_TOOL.test(tool);

const pathOf = (args: unknown): string | null => {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const p = a.path ?? a.file_path ?? a.filePath ?? a.file;
  return typeof p === "string" && p ? p : null;
};

/** The count a test runner prints at its end (vitest, jest, pytest, mocha…): its last mention in the latest such output. */
const lastCount = (outputs: string[], word: "passed" | "failed"): number | null => {
  for (let i = outputs.length - 1; i >= 0; i--) {
    const hits = [...outputs[i]!.matchAll(new RegExp(`\\b(\\d+) ${word}\\b`, "g"))];
    if (hits.length) return Number(hits.at(-1)![1]);
  }
  return null;
};

export function workDone(steps: WorkStep[]): WorkDone {
  const files = new Set<string>();
  let commands = 0;
  const outputs: string[] = [];
  for (const step of steps) {
    if (FILE_TOOL.test(step.tool)) files.add(pathOf(step.args) ?? `#${files.size}`);
    if (COMMAND_TOOL.test(step.tool)) commands++;
    if (step.output && /\b\d+ (?:passed|failed)\b/.test(step.output)) outputs.push(step.output);
  }
  // the last run's own counts: an earlier run's failures were what the later one fixed
  const last = outputs.slice(-1);
  return { steps: steps.length, files: files.size, commands, passed: lastCount(last, "passed"), failed: lastCount(last, "failed") || null };
}

const traceStep = (m: ThreadMessage): WorkStep => {
  const b = m.block as Block & { type: "trace" };
  // the built-in shell's output is its summary and, when long, the tail the summary cut
  const said = COMMAND_TOOL.test(b.tool) ? [b.summary, b.tail].filter(Boolean).join("\n") : "";
  return { tool: b.tool, args: b.args, output: b.commandResult?.output ?? (said || null) };
};

/**
 * Where a conversation turns to writing code: the first step that changes a file, once something was said
 * before it — a thread that starts on code has nothing to set apart.
 */
export function firstCodeStep(messages: ThreadMessage[]): string | null {
  let talked = false;
  for (const m of messages) {
    if (m.role === "agent" && m.block.type === "text") talked = true;
    if (m.role === "agent" && m.block.type === "trace" && FILE_TOOL.test(m.block.tool)) return talked ? m.id : null;
  }
  return null;
}

/** Whether the run has changed a file: the moment its coding can be moved out to a conversation of its own. */
export function writesCode(messages: ThreadMessage[], runId: string): boolean {
  return messages.some((m) => m.runId === runId && m.role === "agent" && m.block.type === "trace" && FILE_TOOL.test(m.block.tool));
}

const isTrace = (m: ThreadMessage | undefined): boolean => m?.role === "agent" && m.block.type === "trace";

/**
 * Where a conversation's writing code begins, as an index: the stretch of steps that first changes a file, or the top
 * of a conversation opened to implement a ticket. -1 when it never writes.
 */
export function codingFrom(messages: ThreadMessage[], fromTop: boolean): number {
  if (fromTop) return 0;
  let at = messages.findIndex((m) => isTrace(m) && FILE_TOOL.test((m.block as Block & { type: "trace" }).tool));
  while (at > 0 && isTrace(messages[at - 1])) at--;
  return at;
}

/** What a permission question asks to run, in a few words: the command it names, else its last line. */
export function askedFor(text: string): string {
  const quoted = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  let said = "";
  if (quoted) {
    try { said = JSON.parse(`"${quoted[1]}"`) as string; } catch { said = quoted[1]!; }
  }
  if (!said) said = text.trim().split(/\n{2,}/).at(-1)!.split("\n")[0]!;
  said = said.trim();
  return said.length > 60 ? `${said.slice(0, 59)}…` : said;
}

/** A folded stretch of steps. `coding`: it is writing code, so the whole stretch folds to what it came to; `waiting`: what the person is asked to allow right after it. */
export interface StepFold {
  fold: ThreadMessage[];
  work: WorkDone;
  coding?: boolean;
  waiting?: string | null;
}

/**
 * The transcript with its steps folded. Before the conversation writes code, in each unbroken run of traces the
 * successful ones before the last few fold into one row, and a failed step splits the fold around it. From
 * `codeFrom` on, a run's whole stretch of steps folds into one row that says what it came to — with what it said
 * and was asked between them — and only its conclusion stays open; when the run then waits on `waiting`, the row
 * says what it waits to be allowed.
 */
export function foldSteps(messages: ThreadMessage[], codeFrom = -1, waiting: { id: string; text: string } | null = null): (ThreadMessage | StepFold)[] {
  const out: (ThreadMessage | StepFold)[] = [];
  const coding = codeFrom >= 0 ? codeFrom : messages.length;
  let i = 0;
  while (i < messages.length) {
    if (!isTrace(messages[i])) { out.push(messages[i++]); continue; }
    if (i >= coding) {
      const runId = messages[i].runId;
      // a stretch: this run's steps, and what it said or was asked between them — with the person's answer, not
      // what they sent into the run — ending at its last step
      let last = i;
      for (let j = i + 1; j < messages.length; j++) {
        const m = messages[j];
        const b = m.block;
        const answer = m.role === "user" && b.type === "text" && !b.steerId && messages[j - 1]!.block.type === "question";
        if (m.runId !== runId || !(answer || (m.role === "agent" && (b.type === "trace" || b.type === "text" || (b.type === "question" && b.id !== waiting?.id))))) break;
        if (b.type === "trace") last = j;
      }
      const fold = messages.slice(i, last + 1);
      let next = last + 1;
      while (next < messages.length && messages[next].runId === runId && messages[next].role === "agent" && messages[next].block.type === "text") next++;
      const after = messages[next]?.block;
      const asked = waiting && after?.type === "question" && after.id === waiting.id ? askedFor(waiting.text) : null;
      out.push({ fold, work: workDone(fold.filter(isTrace).map(traceStep)), coding: true, waiting: asked });
      i = last + 1;
      continue;
    }
    let end = i;
    while (end < messages.length && end < coding && isTrace(messages[end])) end++;
    let held: ThreadMessage[] = [];
    const flush = () => {
      if (held.length > 1) out.push({ fold: held, work: workDone(held.map(traceStep)) });
      else out.push(...held);
      held = [];
    };
    for (let k = i; k < end; k++) {
      const m = messages[k];
      if (k < end - OPEN_STEPS && (m.block as Block & { type: "trace" }).ok) held.push(m);
      else { flush(); out.push(m); }
    }
    flush();
    i = end;
  }
  return out;
}

/**
 * The message that opened a ticket's session: the machine-written brief, not
 * the person's words. It is long and English by design, so the panel folds it
 * behind a label instead of pushing the real conversation off the screen.
 * Recognized by the opener the starter wrote — firstPrompt, continuePrompt or
 * the bootstrap one — so a person's own message is never folded. The opener
 * of a conversation writing code in the background for another is folded in
 * any thread: it is the machine's handover, not the person's words.
 */
export function startBriefId(messages: ThreadMessage[], ticketThread: boolean): string | null {
  const first = messages[0];
  const block = first?.block;
  if (first?.role !== "user" || block?.type !== "text" || block.steerId) return null;
  if (block.text.startsWith("Carry on in the background — ")) return first.id;
  if (!ticketThread) return null;
  return /^(Implement|Continue|Bootstrap) [A-Z][A-Z0-9]*-\d+ — /.test(block.text) ? first.id : null;
}
