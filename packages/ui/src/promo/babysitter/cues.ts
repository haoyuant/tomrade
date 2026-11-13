import type { Cue } from "../Film";
import type { Pointer } from "../parts";
import { COLUMNS } from "../sim";
import { ANSWERED, PLAN, RUN_FROM } from "./plan";
import { PANE_AT, T } from "./stage";

/** The pointer answers the question, then starts the auto run. */
export const POINTER: Pointer = {
  route: [
    { at: 11.3, to: [0.9, 1.06] },
    { at: 12.05, to: "chip" },
    { at: 12.3, to: "chip" },
    { at: ANSWERED - 0.06, to: "confirm" },
    { at: 13.1, to: "confirm" },
    { at: RUN_FROM - 0.1, to: "autorun" },
    { at: RUN_FROM + 0.45, to: "autorun" },
    { at: RUN_FROM + 1.1, to: [1.06, 0.32] }
  ],
  clicks: [12.14, ANSWERED, RUN_FROM]
};

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
    ...POINTER.clicks.map((at, n) => ({ at, kind: "click" as const, n })),
    { at: RUN_FROM, kind: "run" as const, n: 0 },
    { at: T.dawn, kind: "dawn" as const, n: 0 },
    ...[0, 1, 2].map((n) => ({ at: T.proof + 0.3 + n * each, kind: "fact" as const, n })),
    { at: T.end, kind: "end" as const, n: 0 }
  ].sort((a, b) => a.at - b.at);
}
