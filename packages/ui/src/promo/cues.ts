import { CLICKS } from "./parts";
import { COLUMNS, PLAN, RUN_FROM } from "./sim";
import { PANE_AT } from "./stage";
import { T } from "./time";

/** A moment in the film something is heard at: what the renderer's soundtrack is written from. */
export interface Cue { at: number; kind: "pane" | "you" | "turn" | "hop" | "ask" | "click" | "run" | "dawn" | "fact" | "end"; n: number }

/** Every such moment, in order, read from the same times the picture is drawn from. */
export function cues(): Cue[] {
  const each = (T.end - T.proof - 0.3) / 3;
  return [
    ...PANE_AT.map((at, n) => ({ at: Math.max(0, at), kind: "pane" as const, n })),
    { at: 2.5, kind: "you" as const, n: 0 },
    { at: T.turn, kind: "turn" as const, n: 0 },
    // a card's note says how far along the board it lands
    ...PLAN.flatMap((plan, n) => plan.moves.map((move) => ({ at: move.at, kind: "hop" as const, n: COLUMNS.indexOf(move.to) * 3 + (n % 3) }))),
    { at: 10.95, kind: "ask" as const, n: 0 },
    ...CLICKS.map((at, n) => ({ at, kind: "click" as const, n })),
    { at: RUN_FROM, kind: "run" as const, n: 0 },
    { at: T.dawn, kind: "dawn" as const, n: 0 },
    ...[0, 1, 2].map((n) => ({ at: T.proof + 0.3 + n * each, kind: "fact" as const, n })),
    { at: T.end, kind: "end" as const, n: 0 }
  ].sort((a, b) => a.at - b.at);
}
