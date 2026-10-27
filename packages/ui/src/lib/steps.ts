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

/** Steps kept open at the end of a run of them; earlier successful ones fold. */
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
  return { tool: b.tool, args: b.args, output: b.commandResult?.output ?? null };
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

/**
 * The transcript with long runs of steps folded: in each unbroken run of
 * traces, successful ones before the last few fold into one row. A failed
 * step is never folded, so it splits the fold around it.
 */
export function foldSteps(messages: ThreadMessage[]): (ThreadMessage | { fold: ThreadMessage[]; work: WorkDone })[] {
  const out: (ThreadMessage | { fold: ThreadMessage[]; work: WorkDone })[] = [];
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role !== "agent" || messages[i].block.type !== "trace") { out.push(messages[i++]); continue; }
    let end = i;
    while (end < messages.length && messages[end].role === "agent" && messages[end].block.type === "trace") end++;
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
 * the bootstrap one — so a person's own message is never folded.
 */
export function startBriefId(messages: ThreadMessage[], ticketThread: boolean): string | null {
  if (!ticketThread) return null;
  const first = messages[0];
  const block = first?.block;
  if (first?.role !== "user" || block?.type !== "text" || block.steerId) return null;
  return /^(Implement|Continue|Bootstrap) [A-Z][A-Z0-9]*-\d+ — /.test(block.text) ? first.id : null;
}
