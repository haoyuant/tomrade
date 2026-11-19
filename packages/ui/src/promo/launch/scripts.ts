import type { Band, Cue, Song } from "../Film";

/**
 * Every launch film runs the same bars: a hook, the definition, six features, a recap, and the end card. What
 * differs is how each looks and what its band plays. Each comes in two lengths: the short one gives a feature eight
 * beats, the long one fourteen, with more room at both ends.
 */
export interface Bars { define: number; features: number; each: number; recap: number; end: number; beats: number }
export const SHORT: Bars = { define: 8, features: 16, each: 8, recap: 64, end: 68, beats: 78 };
export const LONG: Bars = { define: 12, features: 24, each: 14, recap: 108, end: 116, beats: 128 };
/** Which feature is on at beat q, and how far it is through the eight beats its scene is written in; or none. */
export const featureAt = (bars: Bars, q: number): { index: number; u: number } | null =>
  q >= bars.features && q < bars.recap ? { index: Math.floor((q - bars.features) / bars.each), u: (((q - bars.features) % bars.each) * 8) / bars.each } : null;

const X = null;
/** A style's band, laid over the bars of one length. */
export const songOf = (style: keyof typeof BANDS, bars: Bars): Song => ({ style: "band", bpm: BANDS[style].bpm, beats: bars.beats, marks: { drop: bars.define, rest: bars.recap, back: bars.end, out: bars.end }, band: BANDS[style].band });
const band = (bpm: number, part: Band): { bpm: number; band: Band } => ({ bpm, band: part });
export const BANDS = {
  /** A clean, driving pulse for the keynote. */
  keynote: band(132, { swing: 0, kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 1], bass: [0, X, X, 0, X, X, 0, X, X, X, 7, X, X, X, 5, X], stab: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], prog: ["Am", "F", "C", "G"], pad: true }),
  /** Faster and busier, for a camera that never stops. */
  flyover: band(138, { swing: 0, kick: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1], hat: [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1], bass: [0, X, 0, X, X, 0, X, X, 0, X, 0, X, X, 7, X, X], prog: ["Dm", "F", "C", "G"], tune: [[4, X, X, 7, X, X, 9, X, 7, X, X, 4, X, X, X, X]], lead: "pluck" }),
  /** A chip's square and triangle, for the manual page. */
  manual: band(140, { swing: 0, kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0], hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], bass: [0, X, 12, X, 0, X, 12, X, 0, X, 12, X, 7, X, 12, X], prog: ["C", "Am", "F", "G"], tune: [[12, X, 16, X, 19, X, 16, X, 21, X, 19, X, 16, X, 12, X], [12, X, 16, X, 21, X, 16, X, 19, X, 16, X, 12, X, 9, X]], lead: "square", low: "triangle" }),
  /** Swung, with a piano, for the magazine. */
  zine: band(118, { swing: 0.34, kick: [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1], bass: [0, X, X, 3, X, X, 5, X, 7, X, X, 5, X, X, 3, X], prog: ["Am", "Dm", "G", "C"], tune: [[X, X, 9, X, 12, X, X, 9, X, X, 7, X, 4, X, X, X], [X, X, 5, X, 9, X, X, 12, X, X, 9, X, 5, X, X, X]], lead: "piano", pad: true }),
  /** Bells over a steady step, for the clock. */
  clock: band(126, { swing: 0.08, kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], bass: [0, X, X, X, X, X, X, X, 7, X, X, X, X, X, X, X], prog: ["C", "G", "Am", "F"], tune: [[0, X, X, X, 7, X, X, X, 12, X, X, X, 7, X, X, X]], lead: "bell", pad: true })
};

/** What is heard besides the band: a thump as each feature comes on. */
export const launchCues = (song: Song, bars: Bars): Cue[] => [0, 1, 2, 3, 4, 5].map((n) => ({ at: ((bars.features + n * bars.each) * 60) / song.bpm, kind: "you" as const, n }));
export const secondsOf = (song: Song): number => (song.beats * 60) / song.bpm + 1.2;
