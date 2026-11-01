import type { CSSProperties } from "react";

const between = (low: number, high: number): number => low + Math.random() * (high - low);

/**
 * One light in the air, as its CSS variables. Most are fine; a few are large and out of focus, and those sit dimmer,
 * as dust does near the eye. `lean` crowds them toward the warm light at the bottom right.
 */
function mote(smallest: number, largest: number, lean: number): CSSProperties {
  const near = Math.random() ** 4;
  const size = smallest + near * (largest - smallest);
  return {
    "--x": `${100 * Math.random() ** lean}vw`,
    "--y": `${100 * Math.random() ** lean}vh`,
    "--size": `${size.toFixed(1)}px`,
    "--peak": (0.95 - 0.6 * near).toFixed(2),
    "--blink": `${between(5, 14).toFixed(1)}s`,
    "--blink-from": `${(-between(0, 14)).toFixed(1)}s`
  } as CSSProperties;
}

// Picked once a window: the same field across themes and renders, and no two windows alike.
const FIELDS = {
  sunrise: Array.from({ length: 48 }, () => mote(2, 18, 0.75)),
  daybreak: Array.from({ length: 14 }, () => mote(13, 27, 1))
};

/**
 * Sunrise's dust in the light and Daybreak's brightest stars. Each is a small element of its own, so each keeps its own
 * time on the compositor without a window-sized layer, and none of them repeats the way a tiled background does.
 */
export function Motes({ sky }: { sky: keyof typeof FIELDS }) {
  return (
    <div className="cs-motes" aria-hidden="true">
      {FIELDS[sky].map((style, i) => <i key={i} className="cs-mote" style={style} />)}
    </div>
  );
}
