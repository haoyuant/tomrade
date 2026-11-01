import { Fragment, type CSSProperties } from "react";

const between = (low: number, high: number): number => low + Math.random() * (high - low);
/** Below this a light is too small for its own size change to show: it fades with the rest of its group. */
const DUST_BELOW = 5;
/** Groups of lights that wander together, and whose dust fades together: one layer each, however many lights they hold. */
const GROUPS = 3;

interface Mote { size: number; style: CSSProperties }

/**
 * One light in the air. Most are fine; a few are large and out of focus, and those sit dimmer, as dust does near the
 * eye. `lean` crowds them toward the warm light at the bottom right. `bright` scales how much of its light shows.
 */
function mote(smallest: number, largest: number, lean: number, bright = 1): Mote {
  const near = Math.random() ** 4;
  const size = smallest + near * (largest - smallest);
  const blink = between(5, 14);
  return {
    size,
    style: {
      "--x": `${100 * Math.random() ** lean}vw`,
      "--y": `${100 * Math.random() ** lean}vh`,
      "--size": `${size.toFixed(1)}px`,
      "--peak": ((0.95 - 0.6 * near) * bright).toFixed(2),
      "--blink": `${blink.toFixed(1)}s`,
      "--blink-from": `${(-between(0, 14)).toFixed(1)}s`,
      // Out of step with the blink, so size, brightness and glow never crest together.
      "--glow": `${(blink * between(1.2, 1.7)).toFixed(1)}s`
    } as CSSProperties
  };
}

/**
 * Every animated element is a layer and is restyled on each main frame, and each animation's turn asks for one, so the
 * cost grows with the square of their number: only what shows the difference gets an animation of its own.
 */
function field(count: number, smallest: number, largest: number, lean: number, haloFrom: number, faint = 0) {
  const motes = Array.from({ length: count }, () => mote(smallest, largest, lean));
  // Spread evenly, and static inside the dust's layers, so they cost no animation of their own.
  const specks = Array.from({ length: faint }, () => mote(1, 2.4, 1, 0.5));
  const dust = [...motes.filter((m) => m.size < DUST_BELOW), ...specks];
  const lights = motes.filter((m) => m.size >= DUST_BELOW).map((m) => ({ ...m, halo: m.size >= haloFrom }));
  return Array.from({ length: GROUPS }, (_, g) => ({
    dust: dust.filter((_, i) => i % GROUPS === g),
    lights: lights.filter((_, i) => i % GROUPS === g)
  }));
}

// Picked once a window: the same field across themes and renders, and no two windows alike.
const FIELDS = {
  sunrise: field(48, 2, 10, 0.75, 6, 20),
  daybreak: field(14, 13, 27, 1, 15)
};

export type Sky = keyof typeof FIELDS;

/** The sky a look shows these lights in: Sunrise or Daybreak, itself or under a custom theme, without a picture. */
export const skyOf = (base: string | undefined, picture: boolean): Sky | null =>
  !picture && (base === "sunrise" || base === "daybreak") ? base : null;

/**
 * Sunrise's dust in the light and Daybreak's brightest stars (styles/sunrise.css). Each is a small element of its own, so
 * each keeps its own time on the compositor without a window-sized layer, and none of them repeats the way a tiled
 * background does.
 */
export function Motes({ sky }: { sky: Sky }) {
  return (
    <div className="sun-motes" aria-hidden="true">
      {FIELDS[sky].map(({ dust, lights }, g) => (
        <div key={g} className="sun-drift">
          {dust.length > 0 ? <div className="sun-dust">{dust.map(({ style }, i) => <i key={i} className="sun-mote" style={style} />)}</div> : null}
          {lights.map(({ style, halo }, i) => (
            <Fragment key={i}>
              {halo ? <i className="sun-halo" style={style} /> : null}
              <i className="sun-mote" style={style} />
            </Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}
