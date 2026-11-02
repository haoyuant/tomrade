import { Fragment, useEffect, useRef, type CSSProperties } from "react";

const between = (low: number, high: number): number => low + Math.random() * (high - low);
/** Below this a light is too small for its own size change to show: it fades with the rest of its group. */
const DUST_BELOW = 5;
/** Groups of lights that wander together, and whose dust fades together: one layer each, however many lights they hold. */
const GROUPS = 3;

/** How far a dust canvas reaches past the window, in CSS pixels: as in styles/sunrise.css. */
const DUST_REACH = 130;
/** Canvas pixels per CSS pixel. Each canvas covers the window, so memory goes with the square of this; dust is soft enough for it. */
const DUST_SCALE = 0.6;

/** The finest dust by group, [x, y, radius, alpha] in a tile, so a larger window holds more of it instead of showing it thinner. */
const SPECKS: { width: number; height: number; dots: [number, number, number, number][] }[] = [
  { width: 463, height: 421, dots: [[41, 67, 1.6, 0.75], [318, 34, 1.4, 0.5], [196, 152, 2, 0.75], [427, 233, 1.4, 0.5], [92, 318, 1.6, 0.5], [283, 389, 1.4, 0.75]] },
  { width: 397, height: 487, dots: [[128, 22, 1.4, 0.5], [351, 118, 1.6, 0.75], [57, 171, 1.4, 0.75], [239, 264, 2, 0.5], [372, 351, 1.4, 0.5], [146, 448, 1.6, 0.75]] },
  { width: 521, height: 373, dots: [[233, 49, 1.4, 0.75], [482, 96, 1.6, 0.5], [73, 133, 1.4, 0.5], [301, 207, 1.6, 0.75], [418, 288, 2, 0.75], [164, 341, 1.4, 0.5]] }
];

interface Mote { size: number; x: number; y: number; peak: number; style: CSSProperties }

/**
 * One light in the air. Most are fine; a few are large and out of focus, and those sit dimmer, as dust does near the
 * eye. `lean` crowds them toward the warm light at the bottom right.
 */
function mote(smallest: number, largest: number, lean: number): Mote {
  const near = Math.random() ** 4;
  const size = smallest + near * (largest - smallest);
  const blink = between(5, 14);
  const x = Math.random() ** lean;
  const y = Math.random() ** lean;
  const peak = 0.95 - 0.6 * near;
  return {
    size,
    x,
    y,
    peak,
    style: {
      "--x": `${100 * x}vw`,
      "--y": `${100 * y}vh`,
      "--size": `${size.toFixed(1)}px`,
      "--peak": peak.toFixed(2),
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
function field(count: number, smallest: number, largest: number, lean: number, haloFrom: number) {
  const motes = Array.from({ length: count }, () => mote(smallest, largest, lean));
  const dust = motes.filter((m) => m.size < DUST_BELOW);
  const lights = motes.filter((m) => m.size >= DUST_BELOW).map((m) => ({ ...m, halo: m.size >= haloFrom }));
  return Array.from({ length: GROUPS }, (_, g) => ({
    dust: dust.filter((_, i) => i % GROUPS === g),
    lights: lights.filter((_, i) => i % GROUPS === g)
  }));
}

// Picked once a window: the same field across themes and renders, and no two windows alike.
const FIELDS = {
  sunrise: field(48, 2, 10, 0.75, 6),
  daybreak: field(14, 13, 27, 1, 15)
};

export type Sky = keyof typeof FIELDS;

/** The sky a look shows these lights in: Sunrise or Daybreak, itself or under a custom theme, without a picture. */
export const skyOf = (base: string | undefined, picture: boolean): Sky | null =>
  !picture && (base === "sunrise" || base === "daybreak") ? base : null;

function drawDust(canvas: HTMLCanvasElement, motes: Mote[], tile: (typeof SPECKS)[number]) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.ceil(width * DUST_SCALE);
  canvas.height = Math.ceil(height * DUST_SCALE);
  const draw = canvas.getContext("2d");
  if (!draw) return;
  const light = draw.createRadialGradient(0, 0, 0, 0, 0, 1);
  light.addColorStop(0.3, "rgba(226, 136, 28, 0.95)");
  light.addColorStop(0.63, "rgba(242, 164, 58, 0.5)");
  light.addColorStop(1, "rgba(242, 164, 58, 0)");
  draw.fillStyle = light;
  const speck = (x: number, y: number, radius: number, alpha: number) => {
    // On a pixel's centre: off it, a dot this small smears across two pixels and scales up as a dash.
    draw.setTransform(radius * DUST_SCALE, 0, 0, radius * DUST_SCALE, Math.round(x * DUST_SCALE) + 0.5, Math.round(y * DUST_SCALE) + 0.5);
    draw.globalAlpha = alpha;
    draw.fillRect(-1, -1, 2, 2);
  };
  for (let top = 0; top < height; top += tile.height) {
    for (let left = 0; left < width; left += tile.width) {
      for (const [x, y, radius, alpha] of tile.dots) speck(left + x, top + y, radius, alpha);
    }
  }
  for (const m of motes) speck(DUST_REACH + m.x * (width - 2 * DUST_REACH), DUST_REACH + m.y * (height - 2 * DUST_REACH), m.size / 2, m.peak);
}

/** One group's dust, drawn once: from then on the compositor only moves and fades the canvas. */
function Dust({ motes, tile }: { motes: Mote[]; tile: (typeof SPECKS)[number] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    drawDust(el, motes, tile);
    // A stretched canvas does not show for the moment a resize lasts, and redrawing allocates a whole new one.
    let settling: ReturnType<typeof setTimeout> | undefined;
    const resized = new ResizeObserver(() => {
      if (Math.ceil(el.clientWidth * DUST_SCALE) === el.width && Math.ceil(el.clientHeight * DUST_SCALE) === el.height) return;
      clearTimeout(settling);
      settling = setTimeout(() => drawDust(el, motes, tile), 150);
    });
    resized.observe(el);
    return () => {
      clearTimeout(settling);
      resized.disconnect();
    };
  }, [motes, tile]);
  return <canvas ref={canvas} className="sun-dust" />;
}

/**
 * Sunrise's dust in the light and Daybreak's brightest stars (styles/sunrise.css). A larger light is a small element of its
 * own, so it keeps its own time on the compositor without a window-sized layer; the dust is a canvas per group.
 */
export function Motes({ sky }: { sky: Sky }) {
  return (
    <div className="sun-motes" aria-hidden="true">
      {FIELDS[sky].map(({ dust, lights }, g) => (
        <div key={g} className="sun-drift">
          {dust.length > 0 ? <Dust motes={dust} tile={SPECKS[g]} /> : null}
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
