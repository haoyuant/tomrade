import { KEYS, PHONE } from "../beat/scripts";
import type { Band, Cue, Song } from "../Film";
import { BANDS } from "../launch/scripts";

/**
 * A feature film shows one thing Tomrade does, start to finish, to someone who has never seen it. Every one runs the
 * same bars: a hook, three steps of eight beats, a line that says why it matters, and the end card.
 */
export const HOOK = 4;
export const EACH = 8;
export const STEPS = 3;
/** Where the steps end and the line that says why begins; where that ends, and the end card comes. */
export const WHY = HOOK + STEPS * EACH;
export const OUT = WHY + 4;
export const BEATS = OUT + 8;

/** Which step is on at beat q, and how many beats into it; none during the hook and after the last step. */
export const stepAt = (q: number): { index: number; u: number } | null => (q >= HOOK && q < WHY ? { index: Math.floor((q - HOOK) / EACH), u: (q - HOOK) % EACH } : null);
/** The beat a step starts on. */
export const step = (index: number): number => HOOK + index * EACH;

/** The drums come in with the first step and stay out under the line that says why; the end card lands on one chord. */
const song = (bpm: number, band: Band): Song => ({ style: "band", bpm, beats: BEATS, marks: { drop: HOOK, rest: WHY, back: OUT, out: OUT }, band });
export const SONGS = {
  plugins: song(124, BANDS.manual.band),
  themes: song(116, BANDS.zine.band),
  inbox: song(120, BANDS.clock.band),
  files: song(112, PHONE.band!),
  routines: song(126, KEYS.band!),
  archify: song(120, BANDS.keynote.band),
  anywhere: song(124, BANDS.flyover.band),
  takeover: song(116, BANDS.manual.band),
  im: song(122, BANDS.zine.band)
};
export type FeatureId = keyof typeof SONGS;
export const beatOf = (id: FeatureId): number => 60 / SONGS[id].bpm;
export const secondsOf = (id: FeatureId): number => BEATS * beatOf(id) + 1.2;

/**
 * The beats things happen on, film by film: what the picture and the soundtrack both read. `clicks` are the person's,
 * `lands` what arrives by itself.
 */
export const MOMENTS: Record<FeatureId, { clicks: number[]; lands: number[] }> = {
  // the cat's plugin off and on again; Start, then Load; the two official plugins in the store
  plugins: { clicks: [step(0) + 3.5, step(0) + 5.5, step(1) + 3.5, step(1) + 6.5], lands: [step(2) + 1, step(2) + 2] },
  // a theme to a beat; the picture, then Create theme; By time, and the hour the theme turns
  themes: { clicks: [5, 6, 7, 8, 9, 10, 11, step(1) + 4, step(2) + 1], lands: [step(1) + 1.5, step(2) + 5] },
  // three pieces of feedback come in, one is opened; the suggestion; Confirm
  inbox: { clicks: [step(0) + 5.5, step(2) + 3], lands: [step(0) + 1, step(0) + 2.2, step(0) + 3.4, step(1) + 1.5] },
  // a note is opened; its link, its backlinks, the ticket it is added to; the question, and the answer out of the note
  files: { clicks: [step(0) + 2, step(2) + 1.5], lands: [step(1) + 2, step(1) + 5, step(2) + 3.5] },
  // the routine switched on; eight o'clock and its three tickets; five on Friday and the assistant's answer
  routines: { clicks: [step(0) + 4], lands: [step(1) + 2, step(1) + 2.8, step(1) + 3.4, step(1) + 4, step(2) + 2, step(2) + 3] },
  // the sentence sent, a node picked to trace its path, the change sent, Save to Files; the diagram, redrawn, and its two files
  archify: { clicks: [step(0) + 2.5, step(1) + 3, step(2) + 2.4, step(2) + 5.6], lands: [step(0) + 4, step(2) + 3.6, step(2) + 6.2] },
  // three places take the ticket up; the board's card says each; the ticket's three sessions, and what it delivered
  anywhere: { clicks: [], lands: [step(0) + 0.8, step(0) + 2.8, step(0) + 4.8, step(1) + 1.5, step(1) + 3.5, step(1) + 5.5, step(2) + 1.2, step(2) + 2.4, step(2) + 3.6, step(2) + 5.2] },
  // Scan a repository, then Scan; three entries ticked; Add to backlog; the draft, and the three tickets
  takeover: { clicks: [step(0) + 2.6, step(0) + 6.4, step(1) + 2.6, step(1) + 3.8, step(1) + 5, step(2) + 1.6], lands: [step(1) + 0.6, step(2) + 2.6, step(2) + 3.2, step(2) + 3.8] },
  // a pairing code made, the pairing confirmed; the code sent and the bot's welcome; a sentence, its ticket, /start and its answer; the ticket's topic and its news
  im: { clicks: [step(0) + 2.5, step(0) + 6], lands: [step(0) + 4.2, step(0) + 6.8, step(1) + 1.2, step(1) + 3, step(1) + 3.6, step(1) + 5.2, step(1) + 6.4, step(2) + 1.2, step(2) + 3, step(2) + 4.8, step(2) + 6.2] }
};

/** What is heard besides the band: a thump as each step comes on, a click for each of the person's, a card for what lands. */
export const cuesOf = (id: FeatureId): Cue[] => {
  const beat = beatOf(id);
  return [
    ...[0, 1, 2].map((n) => ({ at: step(n) * beat, kind: "you" as const, n })),
    ...MOMENTS[id].clicks.map((q, n) => ({ at: q * beat, kind: "click" as const, n: n % 4 })),
    ...MOMENTS[id].lands.map((q, n) => ({ at: q * beat, kind: "card" as const, n: n % 6 }))
  ].sort((a, b) => a.at - b.at);
};
