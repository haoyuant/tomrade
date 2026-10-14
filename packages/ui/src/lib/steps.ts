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

/**
 * The transcript with long runs of steps folded: in each unbroken run of
 * traces, successful ones before the last few fold into one row. A failed
 * step is never folded, so it splits the fold around it.
 */
export function foldSteps(messages: ThreadMessage[]): (ThreadMessage | { fold: ThreadMessage[] })[] {
  const out: (ThreadMessage | { fold: ThreadMessage[] })[] = [];
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role !== "agent" || messages[i].block.type !== "trace") { out.push(messages[i++]); continue; }
    let end = i;
    while (end < messages.length && messages[end].role === "agent" && messages[end].block.type === "trace") end++;
    let held: ThreadMessage[] = [];
    const flush = () => {
      if (held.length > 1) out.push({ fold: held });
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
