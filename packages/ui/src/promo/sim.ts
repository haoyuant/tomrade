import type { Priority } from "@tomradex/domain";
import { COL_GAP, COL_W } from "./stage";
import { clamp, ease, lerp } from "./time";

export type Status = "todo" | "doing" | "verifying" | "done";
export const COLUMNS: Status[] = ["todo", "doing", "verifying", "done"];
/** How a card reads: its status, or Doing while its agent waits for the person. */
export type Variant = Status | "waiting";
export const VARIANTS: Variant[] = ["todo", "doing", "waiting", "verifying", "done"];

/** One ticket's part in a film's story. */
export interface Plan {
  key: string;
  agent: "Claude Code" | "Codex";
  priority: Priority;
  start: Status;
  moves: { at: number; to: Status }[];
  pr: number;
  /** While its agent waits for an answer. */
  waiting?: [number, number];
  /** When it is on the board, from and until, if not throughout. */
  lives?: [number, number][];
  /** An agent wrote it, so it carries the agent's tick from the start. */
  written?: boolean;
}

export const run = (claim: number, pr: number, done: number): Plan["moves"] => [{ at: claim, to: "doing" }, { at: pr, to: "verifying" }, { at: done, to: "done" }];

export const liveAt = (plan: Plan, t: number): boolean => !plan.lives || plan.lives.some(([from, until]) => t >= from && t < until);
export const statusAt = (plan: Plan, t: number): Status => plan.moves.reduce<Status>((status, move) => (move.at <= t ? move.to : status), plan.start);
export const variantAt = (plan: Plan, t: number): Variant => (plan.waiting && t >= plan.waiting[0] && t < plan.waiting[1] ? "waiting" : statusAt(plan, t));
/** When the ticket last changed column, or never. */
export const movedAt = (plan: Plan, t: number): number => plan.moves.reduce((at, move) => (move.at <= t ? move.at : at), -1);
export const claimedAt = (plan: Plan): number => plan.moves.find((move) => move.to === "doing")?.at ?? -1;

/** Each column's tickets from the top: To Do in its own order, the rest with the latest arrival first. */
export function columnsAt(plans: Plan[], t: number): Record<Status, number[]> {
  const out: Record<Status, number[]> = { todo: [], doing: [], verifying: [], done: [] };
  plans.forEach((plan, n) => {
    if (liveAt(plan, t)) out[statusAt(plan, t)].push(n);
  });
  for (const status of COLUMNS) if (status !== "todo") out[status].sort((a, b) => movedAt(plans[b], t) - movedAt(plans[a], t) || a - b);
  return out;
}

/** A place a card is headed for from `at` on, in the column track's own pixels; `hop` when it changes column. */
export interface Stop { at: number; x: number; y: number; hop: boolean }
export type Heights = (ticket: number, variant: Variant) => number;

const CARD_GAP = 8;

/** Every card's stops through the story, from the heights the cards measure at. */
export function paths(plans: Plan[], heights: Heights): Stop[][] {
  const times = [...new Set(plans.flatMap((plan) => [...plan.moves.map((move) => move.at), ...(plan.waiting ?? []), ...(plan.lives ?? []).flat()]))].filter(Number.isFinite).sort((a, b) => a - b);
  const out: Stop[][] = plans.map(() => []);
  for (const at of [-1, ...times]) {
    const columns = columnsAt(plans, at);
    COLUMNS.forEach((status, c) => {
      let y = 0;
      for (const n of columns[status]) {
        const x = c * (COL_W + COL_GAP);
        const last = out[n][out[n].length - 1];
        if (!last || last.x !== x || last.y !== y) out[n].push({ at, x, y, hop: !!last && last.x !== x });
        y += heights(n, variantAt(plans[n], at)) + CARD_GAP;
      }
    });
  }
  return out;
}

/** How long a card takes to cross to another column, and to make room in its own. */
export const HOP = 0.58;
const SHIFT = 0.42;

/** Where a card is at t, and how far off the board it is lifted while it crosses to another column. */
export function place(path: Stop[], t: number, hop: (at: number) => number = () => HOP): { x: number; y: number; lift: number } {
  let { x, y } = path[0];
  let lift = 0;
  for (let i = 1; i < path.length && path[i].at <= t; i += 1) {
    const stop = path[i];
    const next = path[i + 1];
    const until = next && next.at <= t ? next.at : t;
    const u = clamp((until - stop.at) / (stop.hop ? hop(stop.at) : SHIFT));
    const k = ease.inOut(u);
    x = lerp(x, stop.x, k);
    y = lerp(y, stop.y, k);
    lift = until === t && stop.hop ? Math.sin(Math.PI * u) : 0;
  }
  return { x, y, lift };
}
