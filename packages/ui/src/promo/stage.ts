/** One cut of a film: the same scenes, laid out for a wide frame or a tall one. */
export interface Format {
  id: "wide" | "tall";
  w: number;
  h: number;
  /** The app window's top edge; captions live in the band above it. */
  winTop: number;
  caption: { x: number; y: number; size: number; width: number };
}

export const WIDE: Format = { id: "wide", w: 1920, h: 1080, winTop: 264, caption: { x: 122, y: 92, size: 92, width: 1676 } };
export const TALL: Format = { id: "tall", w: 1080, h: 1920, winTop: 604, caption: { x: 64, y: 196, size: 112, width: 952 } };

/** The app window's own pixels: a folded pane's rail, a board column, the gaps around them. */
export const RAIL = 48;
export const COL_W = 330;
export const COL_GAP = 16;
export const TRACK_PAD = 16;
export const TITLEBAR_H = 42;
export const HEAD_H = 52;
/** Two rails around four columns. */
export const WIN_W = 2 * RAIL + 2 * TRACK_PAD + 4 * COL_W + 3 * COL_GAP;
export const colLeft = (index: number): number => RAIL + TRACK_PAD + index * (COL_W + COL_GAP);
