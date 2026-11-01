import type { NightShift, NodeConfig, ShiftStep, ShiftTicket, TicketState } from "./rules.js";

/** A change to a run's plan, already checked once: a pass applies it, so nothing else writes the run. */
export interface ShiftEdit {
  add: ShiftTicket[];
  /** `stop` is the person's word to end an agent at work; without it, only a ticket not begun leaves. */
  remove: { itemId: string; stop: boolean }[];
  /** A node's config by ticket id; null clears it back to the run's. */
  nodes: Record<string, NodeConfig | null>;
}

const AT_WORK = new Set<TicketState>(["running", "limited", "needs-you"]);

/** Why a ticket cannot leave as asked; null when it can. What is settled stays, as the run's history. */
export function cannotRemove(ticket: Pick<ShiftTicket, "state">, stop: boolean): "settled" | "working" | null {
  if (ticket.state === "queued") return null;
  if (!AT_WORK.has(ticket.state)) return "settled";
  return stop ? null : "working";
}

/**
 * The change as the run stands when a pass reaches it. The run may have moved on since it was checked:
 * a ticket that has started since is left alone and said so, never stopped on a word about a ticket not begun.
 */
export function applyEdit(shift: NightShift, edit: ShiftEdit, now: number): { shift: NightShift; steps: ShiftStep[]; stopping: ShiftTicket[] } {
  const steps: ShiftStep[] = [];
  const stopping: ShiftTicket[] = [];
  const say = (kind: ShiftStep["kind"], t: ShiftTicket, why: ShiftStep["why"] = null) => steps.push({ at: now, kind, itemId: t.itemId, key: t.key, title: t.title, why });
  const leaving = new Map(edit.remove.map((r) => [r.itemId, r.stop]));
  const tickets = shift.tickets.flatMap((t): ShiftTicket[] => {
    const stop = leaving.get(t.itemId);
    if (stop !== undefined) {
      if (cannotRemove(t, stop)) {
        say("edit-refused", t, { kind: "edit-late" });
        return [t];
      }
      say("removed", t);
      if (t.state === "queued") return [];
      stopping.push(t);
      return [{ ...t, state: "skipped", why: { kind: "removed" }, limitedUntil: null }];
    }
    if (!(t.itemId in edit.nodes)) return [t];
    if (t.state !== "queued") {
      say("edit-refused", t, { kind: "edit-late" });
      return [t];
    }
    say("reconfigured", t);
    const { config: _config, configFrom: _from, ...rest } = t;
    const config = edit.nodes[t.itemId];
    return [config && Object.keys(config).length ? { ...rest, config, configFrom: { kind: "manual" } } : rest];
  });
  const known = new Set(tickets.map((t) => t.itemId));
  for (const t of edit.add) {
    if (known.has(t.itemId)) continue;
    known.add(t.itemId);
    tickets.push({ ...t, joinedAt: now });
    say("joined", t);
  }
  return { shift: { ...shift, tickets }, steps, stopping };
}
