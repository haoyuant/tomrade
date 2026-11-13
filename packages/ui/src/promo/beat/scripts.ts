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

const X = null;

/** "sequencer": the board is a drum machine; a ticket is a pad, and it sounds when the playhead crosses it. */
export const SEQUENCER: Song = {
  style: "band", bpm: 108, beats: 56, marks: { drop: 8, rest: 26, back: 28, out: 48 },
  band: { swing: 0.12, kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: Array(16).fill(0), bass: [0, X, X, X, X, X, 0, X, X, X, 7, X, X, X, X, X], prog: ["Am", "F", "C", "G"], pad: true }
};
export const SEQUENCER_BEAT = beat(SEQUENCER);
export const SEQUENCER_SECONDS = SEQUENCER.beats * SEQUENCER_BEAT + 1.2;
/** The one pad that stops the machine: it asks at `ask`, and the person's tap at `tap` starts the bar again from the top. */
export const PADS = { asks: 5, ask: 26.5, tap: 28, stop: 44 };
/** Each ticket's beats: its pad comes on, its agent claims it, its pull request opens, it is merged; each as the playhead crosses its column. */
export const PAD = Array.from({ length: 8 }, (_, i) => ({
  on: i,
  claim: 8 + Math.floor(i / 2) * 5 + (i % 2) * 0.5,
  pr: i === PADS.asks ? 30.5 : i > PADS.asks ? 28 + i * 0.5 : 16 + Math.floor(i / 2) * 5 + (i % 2) * 0.5,
  merge: i === PADS.asks ? 42.5 : (i < 4 ? 32 : 36) + i * 0.5
}));
export const padRow = (i: number, q: number): number => (q >= PAD[i].merge ? 3 : q >= PAD[i].pr ? 2 : q >= PAD[i].claim ? 1 : 0);
/** Which column the playhead is over at beat q: it holds on the pad that asks, and stops when all is merged. */
export const playhead = (q: number): number => (q >= PADS.stop ? -1 : q >= PADS.tap ? ((q - PADS.tap) * 4) % 16 : q >= PADS.ask ? PADS.asks * 2 : (q * 4) % 16);
export function sequencerCues(): Cue[] {
  const crossings = Array.from({ length: 11 }, (_, bar) => PAD.map((pad, i) => {
    const q = (bar < 7 ? bar * 4 : PADS.tap + (bar - 7) * 4) + i * 0.5;
    return q >= pad.on && (bar < 7 ? q < PADS.ask : q < PADS.stop) ? { q, i } : null;
  })).flat().filter((hit) => hit !== null);
  return [
    ...crossings.map(({ q, i }) => {
      const row = padRow(i, q);
      return { at: q * SEQUENCER_BEAT, kind: row === 0 ? "line" as const : row === 3 ? "tick" as const : "hop" as const, n: row === 0 ? i % 2 : row === 3 ? i : row * 3 + (i % 3) };
    }),
    { at: PADS.ask * SEQUENCER_BEAT, kind: "ask" as const, n: 0 },
    { at: PADS.tap * SEQUENCER_BEAT, kind: "click" as const, n: 1 }
  ].sort((a, b) => a.at - b.at);
}

/** "metro": every agent a line, every ticket a train; one station is the person's. */
export const METRO: Song = {
  style: "band", bpm: 116, beats: 56, marks: { drop: 8, rest: 32, back: 40, out: 48 },
  band: {
    swing: 0, kick: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1],
    bass: [0, X, X, 0, X, X, 7, X, X, X, 0, X, X, 7, X, X], prog: ["C", "Am", "F", "G"], pad: true
  }
};
export const METRO_BEAT = beat(METRO);
export const METRO_SECONDS = METRO.beats * METRO_BEAT + 1.2;
/** The trains: which line each runs on and the beat it leaves To Do; one a beat from station to station. The fifth changes at the person's station. */
export const TRAINS = [[0, 8], [1, 9.5], [2, 11], [0, 13], [1, 15], [0, 21], [2, 31], [1, 33]].map(([line, leaves]) => ({ line, leaves }));
export const CHANGES = { train: 5, asks: 25, answered: 27, night: 32, day: 41.5 };
/**
 * How far along its line a train is at beat q, in stations: 0 is To Do and 6 the terminus. The one that changes
 * waits at the fourth station for its answer; `up` is how far it has gone up the spur to the person's.
 */
export function trainAt(j: number, q: number): { at: number; up: number } {
  const s = q - TRAINS[j].leaves;
  const hop = (beats: number) => Math.floor(beats) + Math.min(1, (beats - Math.floor(beats)) * 1.7);
  if (j !== CHANGES.train || s < 3) return { at: Math.max(0, Math.min(6, hop(s))), up: 0 };
  if (s < 7) return { at: 3, up: s < 4 ? s - 3 : s < 6 ? 1 : 7 - s };
  return { at: Math.min(6, 3 + hop(s - 7)), up: 0 };
}
export const arrived = (q: number): number => TRAINS.filter((_, j) => trainAt(j, q).at >= 6).length;
export function metroCues(): Cue[] {
  return [
    ...TRAINS.flatMap(({ leaves }, j) => [1, 2, 3, 4, 5, 6].map((stop) => ({ at: (leaves + stop + (j === CHANGES.train && stop > 3 ? 4 : 0)) * METRO_BEAT, kind: "hop" as const, n: stop + (j % 3) }))),
    { at: CHANGES.asks * METRO_BEAT, kind: "ask" as const, n: 0 },
    { at: CHANGES.answered * METRO_BEAT, kind: "click" as const, n: 1 }
  ].sort((a, b) => a.at - b.at);
}

/** "keys": a few keys, one to a bar, and what each one does. */
export const KEYS: Song = {
  style: "band", bpm: 124, beats: 56, marks: { drop: 4, rest: 44, back: 52, out: 52 },
  band: { swing: 0, kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1], hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1], bass: [0, X, X, X, X, X, X, 0, X, X, 3, X, X, X, X, X], stab: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], prog: ["Am", "Am", "F", "G"] }
};
export const KEYS_BEAT = beat(KEYS);
export const KEYS_SECONDS = KEYS.beats * KEYS_BEAT + 1.2;
/** The beats a key goes down on. */
export const PRESSES = [4, 8, 12, 14, 20, 22, 28, 30, 36, 38];
export const keysCues = (): Cue[] => [
  ...PRESSES.flatMap((q) => [{ at: q * KEYS_BEAT, kind: "click" as const, n: 0 }, { at: q * KEYS_BEAT, kind: "you" as const, n: 0 }]),
  ...Array.from({ length: 8 }, (_, n) => ({ at: (48 + n * 0.5) * KEYS_BEAT, kind: "tick" as const, n }))
].sort((a, b) => a.at - b.at);

/** "phone": a chat from the person's phone, and their computer at home doing what it says. */
export const PHONE: Song = {
  style: "band", bpm: 112, beats: 52, marks: { drop: 4, out: 44 },
  band: {
    swing: 0.1, kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0],
    bass: [0, X, 0, X, X, X, 7, X, 0, X, 0, X, X, X, 5, X], prog: ["C", "G", "Am", "F"], pad: true
  }
};
export const PHONE_BEAT = beat(PHONE);
export const PHONE_SECONDS = PHONE.beats * PHONE_BEAT + 1.2;
/** When each message of the chat comes in, in beats; the person's own are the odd ones out, by index. */
export const SAID = [4, 6, 9, 13, 15, 18, 20, 24, 29, 33, 36];
export const MINE = [0, 5, 7, 9];
export const phoneCues = (): Cue[] => SAID.map((q, n) => ({ at: q * PHONE_BEAT, kind: MINE.includes(n) ? "send" as const : "card" as const, n: n % 6 }));

/** "numbers": Tomrade by the numbers, one to a bar. */
export const NUMBERS: Song = {
  style: "band", bpm: 132, beats: 60, marks: { drop: 4, out: 50 },
  band: {
    swing: 0, kick: [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], hat: [1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1],
    bass: [0, X, X, X, X, X, X, 0, X, X, 0, X, X, X, X, X], stab: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], prog: ["Am", "F", "Dm", "G"]
  }
};
export const NUMBERS_BEAT = beat(NUMBERS);
export const NUMBERS_SECONDS = NUMBERS.beats * NUMBERS_BEAT + 1.2;
export const numbersCues = (): Cue[] => Array.from({ length: 11 }, (_, n) => ({ at: (4 + n * 4) * NUMBERS_BEAT, kind: "you" as const, n }));
