import type { Cue, Song } from "../Film";

/** A film cut to its music counts in beats: where each part turns, and what one beat lasts. */
const beat = (song: Song): number => 60 / song.bpm;

/** "poster": type that lands on the beat, in ink, paper and one red. */
export const POSTER: Song = { style: "pulse", bpm: 128, beats: 64, marks: { drop: 16, night: 40, build: 48, back: 52, out: 60 } };
export const POSTER_BEAT = beat(POSTER);
export const POSTER_SECONDS = POSTER.beats * POSTER_BEAT + 1.3;
export const posterCues = (): Cue[] => [{ at: 38 * POSTER_BEAT, kind: "click", n: 0 }];

/** "lantern": a night told slowly; each ticket is a lantern on a river. */
export const LANTERN: Song = { style: "nocturne", bpm: 66, beats: 44, marks: { dawn: 30 } };
export const LANTERN_BEAT = beat(LANTERN);
export const LANTERN_SECONDS = LANTERN.beats * LANTERN_BEAT + 3;
/** The beats the story turns on: the lanterns set down, lit by their agents, let through the bridge, and the one that waits. */
export const RIVER = { first: 6, flame: 14, bridge: 19, waits: 7, dawn: 30, answer: 38.5, last: 40, name: 41 };
export const lanternCues = (): Cue[] => [
  ...Array.from({ length: 8 }, (_, i) => ({ at: (RIVER.first + i) * LANTERN_BEAT, kind: "tick" as const, n: i })),
  ...Array.from({ length: 7 }, (_, i) => ({ at: (RIVER.bridge + i) * LANTERN_BEAT, kind: "tick" as const, n: i + 2 })),
  { at: RIVER.last * LANTERN_BEAT, kind: "tick" as const, n: 8 }
];

/** "tty": the whole frame is a terminal, and the story is typed into it. */
export const TTY: Song = { style: "chip", bpm: 140, beats: 72, marks: { flood: 8, drop: 20, win: 52, out: 68 } };
export const TTY_BEAT = beat(TTY);
export const TTY_SECONDS = TTY.beats * TTY_BEAT + 1.2;
/** What is typed, and from which beat; a letter takes an eighth of one. */
export const TYPED = { who: 0, status: 4, run: 18, answer: 42, again: 56 } as const;
export const STROKE = 0.125;
/** The eight tickets of the terminal's board: when each is claimed, gets its pull request and is merged, in beats. One of them asks first. */
export const ASKS = 4;
export const BOARD = Array.from({ length: 8 }, (_, i) => (i === ASKS ? { claim: 36, pr: 45, merge: 49 } : { claim: 28 + i * 2, pr: 33 + i * 2, merge: 37 + i * 2 }));
export const ttyCues = (): Cue[] =>
  ([[TYPED.who, 6], [TYPED.status, 13], [TYPED.run, 7], [TYPED.answer, 1], [TYPED.again, 6]] as const)
    .flatMap(([from, letters]) => Array.from({ length: letters }, (_, k) => ({ at: (from + k * STROKE) * TTY_BEAT, kind: "key" as const, n: k })));
