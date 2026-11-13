import type { Priority } from "@tomradex/domain";
import { COL_GAP, COL_W } from "./stage";
import { clamp, ease, lerp } from "./time";

export type Status = "todo" | "doing" | "verifying" | "done";
export const COLUMNS: Status[] = ["todo", "doing", "verifying", "done"];
/** How a card reads: its status, or Doing while its agent waits for the person. */
export type Variant = Status | "waiting";
export const VARIANTS: Variant[] = ["todo", "doing", "waiting", "verifying", "done"];

export interface Plan {
  key: string;
  agent: "Claude Code" | "Codex";
  priority: Priority;
  start: Status;
  moves: { at: number; to: Status }[];
  pr: number;
  /** While its agent waits for an answer. */
  waiting?: [number, number];
}

const run = (claim: number, pr: number, done: number): Plan["moves"] => [{ at: claim, to: "doing" }, { at: pr, to: "verifying" }, { at: done, to: "done" }];

/** When the person answers the one question. */
export const ANSWERED = 12.75;
/** When the auto run starts. */
export const RUN_FROM = 14.15;

/** The night's writes come one after another, this far apart. */
const night = (step: number): number => RUN_FROM + 0.3 + step * 0.185;

/**
 * The board's story: three tickets by day, the question, then the auto run through the night, three at once. The
 * night's steps are numbered in the order they happen, so no two cards leave at the same moment.
 */
export const PLAN: Plan[] = [
  { key: "APP-41", agent: "Claude Code", priority: 3, start: "todo", pr: 212, moves: run(5.75, 7.7, 9.3) },
  { key: "APP-42", agent: "Codex", priority: 4, start: "todo", pr: 213, moves: run(6.45, 8.7, night(1)) },
  { key: "APP-43", agent: "Codex", priority: 2, start: "todo", pr: 215, moves: run(7.1, night(2), night(6)), waiting: [10.75, ANSWERED] },
  { key: "APP-44", agent: "Claude Code", priority: 3, start: "todo", pr: 216, moves: run(9.7, night(4), night(9)) },
  { key: "APP-45", agent: "Claude Code", priority: 2, start: "todo", pr: 217, moves: run(night(0), night(7), night(12)) },
  { key: "APP-46", agent: "Codex", priority: 2, start: "todo", pr: 218, moves: run(night(3), night(10), night(14)) },
  { key: "APP-47", agent: "Claude Code", priority: 1, start: "todo", pr: 219, moves: run(night(5), night(13), night(16)) },
  { key: "APP-48", agent: "Codex", priority: 2, start: "todo", pr: 220, moves: run(night(8), night(15), night(18)) },
  { key: "APP-49", agent: "Claude Code", priority: 1, start: "todo", pr: 221, moves: run(night(11), night(17), night(19)) },
  { key: "APP-39", agent: "Codex", priority: 2, start: "verifying", pr: 209, moves: [{ at: 8.2, to: "done" }] },
  { key: "APP-38", agent: "Claude Code", priority: 2, start: "done", pr: 207, moves: [] }
];

/** The tickets the auto run takes on. */
export const RUN = [1, 2, 3, 4, 5, 6, 7, 8];

export const statusAt = (plan: Plan, t: number): Status => plan.moves.reduce<Status>((status, move) => (move.at <= t ? move.to : status), plan.start);
export const variantAt = (plan: Plan, t: number): Variant => (plan.waiting && t >= plan.waiting[0] && t < plan.waiting[1] ? "waiting" : statusAt(plan, t));
/** When the ticket last changed column, or never. */
export const movedAt = (plan: Plan, t: number): number => plan.moves.reduce((at, move) => (move.at <= t ? move.at : at), -1);
export const claimedAt = (plan: Plan): number => plan.moves.find((move) => move.to === "doing")?.at ?? -1;

/** Each column's tickets from the top: To Do in its own order, the rest with the latest arrival first. */
export function columnsAt(t: number): Record<Status, number[]> {
  const out: Record<Status, number[]> = { todo: [], doing: [], verifying: [], done: [] };
  PLAN.forEach((plan, n) => out[statusAt(plan, t)].push(n));
  for (const status of COLUMNS) if (status !== "todo") out[status].sort((a, b) => movedAt(PLAN[b], t) - movedAt(PLAN[a], t) || a - b);
  return out;
}

/** A place a card is headed for from `at` on, in the column track's own pixels; `hop` when it changes column. */
interface Stop { at: number; x: number; y: number; hop: boolean }
export type Heights = (ticket: number, variant: Variant) => number;

const CARD_GAP = 8;

/** Every card's stops through the film, from the heights the cards measure at. */
export function paths(heights: Heights): Stop[][] {
  const times = [...new Set(PLAN.flatMap((plan) => [...plan.moves.map((move) => move.at), ...(plan.waiting ?? [])]))].sort((a, b) => a - b);
  const out: Stop[][] = PLAN.map(() => []);
  for (const at of [-1, ...times]) {
    const columns = columnsAt(at);
    COLUMNS.forEach((status, c) => {
      let y = 0;
      for (const n of columns[status]) {
        const x = c * (COL_W + COL_GAP);
        const last = out[n][out[n].length - 1];
        if (!last || last.x !== x || last.y !== y) out[n].push({ at, x, y, hop: !!last && last.x !== x });
        y += heights(n, variantAt(PLAN[n], at)) + CARD_GAP;
      }
    });
  }
  return out;
}

/** How long a card takes to cross to another column, by day and in the night's hurry, and to make room in its own. */
const HOP = 0.58;
const HOP_NIGHT = 0.46;
const SHIFT = 0.42;

/** Where a card is at t, and how far off the board it is lifted while it crosses to another column. */
export function place(path: Stop[], t: number): { x: number; y: number; lift: number } {
  let { x, y } = path[0];
  let lift = 0;
  for (let i = 1; i < path.length && path[i].at <= t; i += 1) {
    const stop = path[i];
    const next = path[i + 1];
    const until = next && next.at <= t ? next.at : t;
    const u = clamp((until - stop.at) / (!stop.hop ? SHIFT : stop.at > RUN_FROM ? HOP_NIGHT : HOP));
    const k = ease.inOut(u);
    x = lerp(x, stop.x, k);
    y = lerp(y, stop.y, k);
    lift = until === t && stop.hop ? Math.sin(Math.PI * u) : 0;
  }
  return { x, y, lift };
}
