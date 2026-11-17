import type { Cue } from "../Film";
import type { Pointer } from "../parts";
import { COLUMNS } from "../sim";
import { END_SECONDS, proofAt } from "../time";
import type { Lang } from "../words";
import { D, LINES, PLAN, POINTER, REDO, keysAt } from "./story";
import type { CaptionKey } from "./words";

/** A caption over the day, from one of its seconds to another. */
type Line = [CaptionKey, number, number];
/**
 * A film cut from the day: its seconds from `from` to `to` under the film's own captions, then the facts if it has
 * them, then the end card. `poster` is the day's second its still is taken at.
 */
export interface Cut { id: string; from: number; to: number; poster: number; lines: Line[]; facts?: boolean }

/** How long the facts after the main film stay up. */
const FACTS = 5.2;

export const CUTS: Cut[] = [
  // The main film: one sentence becomes tickets, agents build them in the person's own terminal, and an auto run merges them overnight.
  {
    id: "main", from: 0, to: D.out, poster: 19, facts: true,
    lines: [
      ["open", -0.3, D.send + 0.9], ["talk", D.send + 1, D.tidy - 0.3], ["split", D.tidy - 0.2, D.revert - 1.3], ["back", D.revert - 1.2, D.build - 0.2],
      ["build", D.build - 0.1, 17.2], ["keeps", 17.3, D.ask - 0.1], ["ask", D.ask, D.merge - 0.1],
      ["merge", D.merge, D.run + 0.9], ["graph", D.run + 1, 32.4], ["checks", 32.5, D.dawn + 1.9], ["morning", D.morning, D.out]
    ]
  },
  // Short films, each one stretch of the same day with its own words.
  { id: "idea", from: 0, to: 9.9, poster: 9, lines: [["open", -0.3, D.send + 0.9], ["ideaTicket", D.send + 1, D.tidy - 0.3], ["ideaSplit", D.tidy - 0.2, 9.9]] },
  // The site's four steps each loop one clip: say and split halve "idea" where the second message starts being typed, and split goes on to take the run back.
  { id: "say", from: 0, to: 5.9, poster: 5, lines: [["open", -0.3, D.send + 0.9], ["ideaTicket", D.send + 1, 5.9]] },
  { id: "split", from: 5.9, to: 13.8, poster: 9, lines: [["ideaSplit", 5.6, D.revert - 1.3], ["back", D.revert - 1.2, D.redo - 0.3], ["undoForth", D.redo - 0.2, 13.8]] },
  { id: "undo", from: 6.3, to: 13.8, poster: 9, lines: [["undoRewrote", 6, D.revert - 1.3], ["undoBack", D.revert - 1.2, D.redo - 0.3], ["undoForth", D.redo - 0.2, 13.8]] },
  { id: "handsfree", from: 14.5, to: 21.1, poster: 19, lines: [["boardNobody", 14.1, 16.3], ["boardAgents", 16.4, 18.7], ["keeps", 18.8, 21.1]] },
  { id: "overnight", from: 27, to: 40.9, poster: 34, lines: [["nightBed", 26.7, D.run + 1.1], ["graph", D.run + 1.2, 32.4], ["checks", 32.5, D.dawn + 1.9], ["morning", D.morning, 40.9]] }
];

/** A cut's seconds: how much of the day it shows, when its end card comes up, and how long it is in all. */
export function spanOf(cut: Cut): { shown: number; endAt: number; seconds: number } {
  const shown = cut.to - cut.from;
  const endAt = shown + (cut.facts ? FACTS : 0);
  return { shown, endAt, seconds: endAt + END_SECONDS };
}

/** What is heard through the day, at the day's own seconds. */
function heard(lang: Lang): Cue[] {
  return [
    ...keysAt(lang).map((at, n) => ({ at, kind: "key" as const, n })),
    ...[D.send, D.tidy].map((at, n) => ({ at, kind: "send" as const, n })),
    { at: D.ticket, kind: "card" as const, n: 0 },
    ...[1, 2, 3, 4, 5].map((n) => ({ at: D.split + (n - 1) * 0.07, kind: "card" as const, n })),
    { at: D.revert, kind: "back" as const, n: 0 },
    ...REDO.slice(0, 5).map((at, n) => ({ at, kind: "card" as const, n: n + 1 })),
    ...POINTER.clicks.map((at) => ({ at, kind: "click" as const, n: 0 })),
    ...[D.build, D.merge + 0.35].map((at, n) => ({ at, kind: "swap" as const, n })),
    ...[LINES.claude, LINES.codex].flatMap((lines, pane) => lines.slice(1).map((at) => ({ at, kind: "line" as const, n: pane }))),
    // a card's note says how far along the board it lands
    ...PLAN.flatMap((plan, n) => plan.moves.map((move) => ({ at: move.at, kind: "hop" as const, n: COLUMNS.indexOf(move.to) * 3 + (n % 3) }))),
    { at: D.ask + 0.2, kind: "ask" as const, n: 0 },
    { at: D.run, kind: "run" as const, n: 0 },
    { at: D.dawn, kind: "dawn" as const, n: 0 },
    { at: D.morning, kind: "morning" as const, n: 0 }
  ];
}

/** What is heard in a cut, at the cut's own seconds: the day's sounds inside it, the facts and the end. */
export function cuesOf(cut: Cut, lang: Lang): Cue[] {
  const { shown, endAt } = spanOf(cut);
  return [
    { at: 0, kind: "night" as const, n: 0 },
    ...heard(lang).map((cue) => ({ ...cue, at: cue.at - cut.from })).filter((cue) => cue.at >= 0 && cue.at < shown),
    ...(cut.facts ? proofAt(shown + 0.2, endAt, 3).map((at, n) => ({ at, kind: "fact" as const, n })) : []),
    { at: endAt, kind: "end" as const, n: 0 }
  ].sort((a, b) => a.at - b.at);
}

/** The day's pointer at a cut's own seconds; it is gone when the window leaves. */
export function pointerOf(cut: Cut): Pointer {
  const { shown } = spanOf(cut);
  return {
    route: POINTER.route.map((stop) => ({ ...stop, at: stop.at - cut.from })),
    clicks: POINTER.clicks.map((at) => at - cut.from).filter((at) => at >= 0 && at < shown),
    until: shown
  };
}
