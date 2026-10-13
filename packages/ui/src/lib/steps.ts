import type { Block, ThreadMessage } from "@tomradex/agent";

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
