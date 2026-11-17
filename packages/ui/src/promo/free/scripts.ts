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

/**
 * "An agent asked. You didn't see it.": a terminal waits behind other windows while the minutes run; then the same
 * question in Tomrade, where the pane, the session bar and the status bar say so at once, and one click on its card's
 * Allow answers it (`open` and `picked` are where the words change and the pointer arrives).
 */
export const W = { covered: 1.1, turn: 4.3, told: 5.3, open: 6.5, picked: 7.6, answered: 8.3, saved: 10.3, end: 12.5 };
/** How long the agent waits unseen, and with Tomrade, in seconds of its own time. */
export const WAITED = { unseen: 47 * 60 + 12, seen: 3 };
export const WALL_SECONDS = W.end + END_SECONDS;
export function wallCues(): Cue[] {
  return [
    { at: 0, kind: "night" as const, n: 0 },
    { at: 0.1, kind: "pane" as const, n: 2 },
    { at: W.covered, kind: "swap" as const, n: 0 },
    { at: 2.6, kind: "you" as const, n: 0 },
    { at: W.turn, kind: "turn" as const, n: 0 },
    { at: W.told, kind: "ask" as const, n: 0 },
    { at: W.answered, kind: "click" as const, n: 1 },
    ...[0.5, 0.95, 1.4].map((after, n) => ({ at: W.answered + after, kind: "line" as const, n: n % 2 })),
    { at: W.answered + 1.4, kind: "hop" as const, n: 7 },
    { at: W.saved, kind: "fact" as const, n: 2 },
    { at: W.end, kind: "end" as const, n: 0 }
  ].sort((a, b) => a.at - b.at);
}
export const WALL_POINTER: Pointer = { route: [{ at: W.open, to: [0.75, 1.08] }, { at: W.picked + 0.2, to: "allow" }, { at: W.answered + 0.3, to: "allow" }, { at: W.answered + 1.1, to: [1.06, 0.75] }], clicks: [W.answered] };

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
