import { T, ease, span, track } from "./time";

/** One cut of the film: the same scenes, laid out for a wide frame or a tall one. */
export interface Format {
  id: "wide" | "tall";
  w: number;
  h: number;
  /** The app window's top edge; captions live in the band above it. */
  winTop: number;
  caption: { x: number; y: number; size: number; width: number };
  /** The opening's lines, stacked. */
  hook: { x: number; y: number; size: number };
  pane: { w: number; at: [number, number, number][]; count: [number, number] };
}

export const WIDE: Format = {
  id: "wide", w: 1920, h: 1080, winTop: 264,
  caption: { x: 122, y: 92, size: 92, width: 1676 },
  hook: { x: 122, y: 322, size: 116 },
  pane: { w: 600, at: [[1350, 262, -3], [1604, 404, 2], [1300, 532, 1.5], [1610, 664, -2.5], [1340, 806, 3], [1584, 918, -1.5]], count: [1460, 92] }
};

export const TALL: Format = {
  id: "tall", w: 1080, h: 1920, winTop: 604,
  caption: { x: 64, y: 196, size: 112, width: 952 },
  hook: { x: 64, y: 212, size: 126 },
  pane: { w: 700, at: [[404, 938, -3], [672, 1082, 2], [384, 1240, 1.5], [694, 1396, -2.5], [412, 1556, 3], [664, 1712, -1.5]], count: [540, 772] }
};

/** The app window's width in its own pixels: two 48px rails around four 330px columns. */
export const WIN_W = 1496;
const RAIL = 48;
export const COL_W = 330;
export const COL_GAP = 16;
export const TRACK_PAD = 16;
export const TITLEBAR_H = 42;
export const HEAD_H = 52;
export const colLeft = (index: number): number => RAIL + TRACK_PAD + index * (COL_W + COL_GAP);

/** When each of the opening's terminals arrives; the first is there on the first frame, which is what a feed shows before it plays. */
export const PANE_AT = [-0.2, 0.5, 0.9, 1.2, 1.45, 1.65];

export interface Camera { s: number; left: number; top: number; winH: number }

/** How the app window sits in the frame: its scale, and which of its own x sits at the frame's middle. */
export function camera(t: number, f: Format): Camera {
  const wide = f.id === "wide";
  const full = wide ? 1.2 : 1.56;
  const s = track(t, wide
    ? [[5.0, full], [5.7, 1.85], [7.2, 1.85], [8.2, full], [T.ask, full], [T.ask + 0.7, 1.7], [13.0, 1.7], [13.8, full], [T.proof, 1.24]]
    : [[5.0, full], [5.7, 1.6], [7.2, 1.6], [8.2, full], [T.ask, full], [13.0, full], [13.8, 1.3], [T.proof, 1.34]]);
  const fx = track(t, wide
    ? [[5.0, 748], [5.7, 404], [7.2, 404], [8.2, 748], [T.ask, 748], [T.ask + 0.7, 716], [13.0, 716], [13.8, 748]]
    : [[5.0, 404], [5.7, 404], [7.2, 404], [8.2, 748], [T.ask, 748], [13.0, 748], [13.8, 1080]]);
  // The window comes up from below as the terminals fold into it.
  const rise = 1 - ease.outQuint(span(t, T.turn, T.turn + 0.9));
  return { s, left: f.w / 2 - fx * s, top: f.winTop + rise * 90, winH: (f.h - f.winTop - 14) / s };
}

/** How far a terminal has folded into its ticket: 0 a terminal in the pile, 1 a card in To Do. */
export const folded = (index: number, t: number): number => ease.inOut(span(t, T.turn + 0.12 + index * 0.07, T.turn + 1.02 + index * 0.07));

/** Night into day: 0 is Daybreak, 1 is Sunrise. */
export const dawn = (t: number): number => ease.inOut(span(t, T.dawn, T.dawn + 1.9));

/** Minutes since midnight on the wall clock the film shows; the night runs in a few seconds. */
export function clock(t: number): number {
  const evening = 21 * 60 + 40 + span(t, T.board, T.night + 0.7) * 76;
  const night = ease.inOut(span(t, T.night + 0.7, T.dawn + 1.7)) * (8 * 60 + 4);
  return evening + night;
}

/** The sky's own time, in seconds: its lights turn with the film, and many times faster while the night goes by. */
export const skyTime = (t: number): number => t + 26 * ease.inOut(span(t, T.night + 0.7, T.dawn + 1.7));
