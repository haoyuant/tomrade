import type { Cue } from "../Film";
import type { Pointer } from "../parts";
import { END_SECONDS } from "../time";

/** "Terminals pile up": where each part of the terminal's film starts, in seconds. */
export const K = {
  /** The pile's terminals snap into one window's panes. */
  snap: 3.3,
  /** One pane needs the person: it comes forward, gets its answer and goes back. */
  need: 6.2, zoom: 6.7, typed: 8.2, back: 8.8,
  /** Each pane's ticket comes out beside it. */
  ticket: 9.7,
  /** The app is quit, the panes work on, and the window comes back. */
  quit: 12.7, reopen: 15.1,
  end: 16.9
};
/** When each of the pile's terminals arrives; the first ones are there on the first frame. */
export const PILE_AT = [-0.4, -0.2, 0.3, 0.6, 0.85, 1.05, 1.25, 1.4, 1.55];
/** When each pane's ticket moves on, by pane: to Verifying, then to Done. A pane that never gets there has none. */
export const PANE_MOVES: [number, number][] = [[10.4, 11.3], [10.9, 13.6], [11.6, 14.2], [13.2, 14.7], [14.0, Infinity], [Infinity, Infinity]];
export const TERMINAL_SECONDS = K.end + END_SECONDS;

export function terminalCues(): Cue[] {
  return [
    { at: 0, kind: "night" as const, n: 0 },
    ...PILE_AT.map((at, n) => ({ at: Math.max(0, at), kind: "pane" as const, n: n % 6 })),
    { at: 2.5, kind: "you" as const, n: 0 },
    { at: K.snap, kind: "swap" as const, n: 0 },
    { at: K.snap + 0.75, kind: "you" as const, n: 0 },
    { at: K.need, kind: "ask" as const, n: 0 },
    { at: K.typed, kind: "key" as const, n: 3 },
    { at: K.typed + 0.25, kind: "send" as const, n: 0 },
    ...[0, 1, 2, 3, 4].map((n) => ({ at: K.ticket + n * 0.09, kind: "card" as const, n })),
    ...PANE_MOVES.flatMap(([pr, done], n) => [{ at: pr, kind: "hop" as const, n: 6 + (n % 3) }, { at: done, kind: "hop" as const, n: 9 + (n % 3) }]).filter((cue) => Number.isFinite(cue.at)),
    { at: K.quit, kind: "click" as const, n: 0 },
    { at: K.quit + 0.05, kind: "swap" as const, n: 0 },
    { at: K.reopen, kind: "swap" as const, n: 0 },
    { at: K.end, kind: "end" as const, n: 0 }
  ].sort((a, b) => a.at - b.at);
}
export const TERMINAL_POINTER: Pointer = { route: [{ at: K.quit - 0.9, to: [0.3, 1.08] }, { at: K.quit - 0.05, to: "close" }, { at: K.quit + 0.3, to: "close" }, { at: K.quit + 1, to: [-0.06, 0.4] }], clicks: [K.quit] };

/** "All of them running": the wall, the one pane that needs the person, the answer. */
export const W = { need: 2.5, zoom: 3.5, ask: 4.5, picked: 6.0, answered: 6.8, back: 7.2, end: 9.6 };
export const WALL_SECONDS = W.end + END_SECONDS;
export function wallCues(): Cue[] {
  return [
    { at: 0, kind: "night" as const, n: 0 },
    ...[0.2, 0.55, 0.9, 1.3, 1.65, 2.0].map((at, n) => ({ at, kind: "line" as const, n: n % 2 })),
    { at: W.need, kind: "you" as const, n: 0 },
    { at: W.need + 0.05, kind: "pane" as const, n: 4 },
    { at: W.zoom, kind: "swap" as const, n: 0 },
    { at: W.ask, kind: "ask" as const, n: 0 },
    { at: W.picked, kind: "click" as const, n: 0 },
    { at: W.answered, kind: "click" as const, n: 1 },
    { at: W.back, kind: "swap" as const, n: 0 },
    ...[7.9, 8.2, 8.5, 8.8, 9.1].map((at, n) => ({ at, kind: "hop" as const, n: 6 + n })),
    { at: W.end, kind: "end" as const, n: 0 }
  ].sort((a, b) => a.at - b.at);
}
export const WALL_POINTER: Pointer = { route: [{ at: W.ask + 0.5, to: [0.7, 1.08] }, { at: W.picked - 0.08, to: "chip" }, { at: W.picked + 0.2, to: "chip" }, { at: W.answered - 0.06, to: "confirm" }, { at: W.answered + 0.3, to: "confirm" }, { at: W.answered + 1, to: [1.06, 0.7] }], clicks: [W.picked, W.answered] };

/** "Nobody touched this card": when each of its agent's lines is written, and when the last words come. */
export const C = { steps: [2.3, 3.5, 4.7, 5.9, 7.2], own: 8.6, end: 10.4 };
export const CARD_SECONDS = C.end + END_SECONDS;
export function cardCues(): Cue[] {
  return [
    { at: 0, kind: "night" as const, n: 0 },
    { at: 0.9, kind: "you" as const, n: 0 },
    ...C.steps.flatMap((at, n) => [{ at, kind: "line" as const, n: n % 2 }, { at, kind: "fact" as const, n: [0, 1, 0, 1, 2][n] }]),
    ...[C.steps[0], C.steps[3], C.steps[4]].map((at, n) => ({ at: at + 0.02, kind: "hop" as const, n: 3 + n * 3 })),
    { at: C.steps[4] + 0.1, kind: "morning" as const, n: 0 },
    { at: C.own, kind: "you" as const, n: 0 },
    { at: C.end, kind: "end" as const, n: 0 }
  ].sort((a, b) => a.at - b.at);
}
