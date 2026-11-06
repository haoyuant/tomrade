import { useEffect, useRef } from "react";
import type { Sky } from "./Motes";

/**
 * Canvas pixels per CSS pixel. A composited element is rastered whole at the screen's resolution, so the two moving
 * lights as painted layers took about 220 MB of GPU memory on a large window; a canvas keeps its own resolution and
 * the compositor scales it. The glows are soft enough for a quarter; Daybreak's stars, drifting with the sky on a canvas of
 * their own, need each pixel.
 */
const SCALE: Record<Part, number> = { sky: 0.25, stars: 1, sun: 0.25 };

/** How each light falls off along its radius: an eased curve, so the wide glows stay smooth to their edge. */
const FALLOFF: [number, number][] = [[0, 1], [0.2, 0.74], [0.42, 0.46], [0.64, 0.22], [0.84, 0.07], [1, 0]];

/** Daybreak's last stars, [x, y, core, edge] in a tile of [width] × 760 repeated across: as they were in styles/sunrise.css. */
const STARS: { width: number; dots: [number, number, number, number][] }[] = [
  { width: 263, dots: [[212, 24, 0.4, 1.5], [37, 252, 0.4, 1.5], [150, 470, 0.4, 1.5]] },
  { width: 331, dots: [[128, 58, 0.8, 2.2], [271, 318, 0.4, 1.5], [40, 520, 0.4, 1.5], [230, 700, 0.4, 1.5]] },
  { width: 419, dots: [[90, 640, 0.8, 2.2], [84, 16, 0.4, 1.5], [340, 214, 0.4, 1.5], [190, 396, 0.8, 2.2], [370, 590, 0.4, 1.5], [120, 730, 0.4, 1.5]] }
];

type Rgba = [number, number, number, number];
type Part = "sky" | "stars" | "sun";

function rgbaOf(value: string): Rgba | null {
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const draw = probe.getContext("2d", { willReadFrequently: true });
  if (!draw || !value) return null;
  draw.fillStyle = value;
  draw.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = draw.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

const css = ([r, g, b, a]: Rgba, k: number) => `rgba(${r}, ${g}, ${b}, ${(a * k).toFixed(4)})`;

/** One elliptical light centred at (x, y) with radii (rx, ry), in the canvas's CSS pixels. */
function glow(draw: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: Rgba) {
  const light = draw.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [at, k] of FALLOFF) light.addColorStop(at, css(color, k));
  draw.save();
  draw.translate(x, y);
  draw.scale(rx, ry);
  draw.fillStyle = light;
  draw.fillRect(-1, -1, 2, 2);
  draw.restore();
}

function drawStars(draw: CanvasRenderingContext2D, width: number, top: number, color: Rgba) {
  const base = draw.getTransform();
  for (const { width: tile, dots } of STARS) {
    for (const [x, y, core, edge] of dots) {
      const star = draw.createRadialGradient(0, 0, 0, 0, 0, edge);
      star.addColorStop(0, css(color, 1));
      star.addColorStop(core / edge, css(color, 1));
      star.addColorStop(1, css(color, 0));
      draw.fillStyle = star;
      for (let left = 0; left < width; left += tile) {
        draw.setTransform(base);
        draw.translate(left + x, top + y);
        draw.fillRect(-edge, -edge, 2 * edge, 2 * edge);
      }
    }
  }
  draw.setTransform(base);
}

/**
 * Faint wide glows step from one 8-bit level to the next in visible bands, which a scaled-up canvas turns into blotches
 * on a dark theme; CSS gradients are dithered, so these are too: a level up or down at random breaks every edge.
 */
function dither(draw: CanvasRenderingContext2D, width: number, height: number) {
  const image = draw.getImageData(0, 0, width, height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const n = Math.random() - Math.random();
    px[i] += n;
    px[i + 1] += n;
    px[i + 2] += n;
    px[i + 3] += n;
  }
  draw.putImageData(image, 0, 0);
}

/** The tokens a light is drawn from, as the root has them now. */
const TOKENS = ["sun-sky-haze", "sun-star", "sun-glow", "sun-haze", "titlebar-h"];
const tokensNow = () => {
  const styles = getComputedStyle(document.documentElement);
  return TOKENS.map((name) => styles.getPropertyValue(`--${name}`)).join("|");
};

/** Draws one light's canvas for the window as it is now; the compositor only moves and fades it from then on. */
function paint(canvas: HTMLCanvasElement, part: Part) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scale = SCALE[part];
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const draw = canvas.getContext("2d");
  if (!draw) return;
  draw.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => rgbaOf(styles.getPropertyValue(`--${name}`).trim());
  const vw = window.innerWidth / 100;
  const vh = window.innerHeight / 100;
  // Positions are in each canvas's own box, which reaches past the window: see .sun-sky and .sun-sun.
  if (part === "sky") {
    const haze = token("sun-sky-haze");
    if (haze) glow(draw, 16 * vw, 0, 72 * vw, 56 * vh, haze);
  } else if (part === "stars") {
    // Points, not glows: nothing here bands.
    const star = token("sun-star");
    if (star) drawStars(draw, width, 8 * vh + (parseFloat(styles.getPropertyValue("--titlebar-h")) || 0), star);
    return;
  } else {
    // The haze lies over the glow.
    const sunGlow = token("sun-glow");
    const haze = token("sun-haze");
    if (sunGlow) glow(draw, 98 * vw, 120 * vh, 56 * vw, 44 * vh, sunGlow);
    if (haze) glow(draw, 104 * vw, 128 * vh, 104 * vw, 82 * vh, haze);
  }
  dither(draw, canvas.width, canvas.height);
}

/**
 * Sunrise's and Daybreak's sky (behind everything, with Daybreak's stars) or sun (over the assistant's floor and the
 * dust), as canvases (styles/sunrise.css). Redrawn when the window settles at a new size or the theme's colours change.
 */
export function SkyLight({ sky, part }: { sky: Sky; part: Exclude<Part, "stars"> }) {
  return (
    <>
      <Light part={part} />
      {sky === "daybreak" && part === "sky" ? <Light part="stars" /> : null}
      {part === "sky" ? <RestAway /> : null}
    </>
  );
}

/** How long a window stays out of focus before its lights hold still: a glance at another app does not count. */
const REST_AFTER_MS = 30_000;

/**
 * The lights cost about 7% of a core per window while they move (TOM-1016), and over a long run the person is mostly in
 * other apps: a window out of focus a while holds them where they are (styles/sunrise.css), and focus resumes them.
 */
function RestAway() {
  useEffect(() => {
    const root = document.documentElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const away = () => {
      clearTimeout(timer);
      // Focus inside one of the page's own frames still counts as here.
      timer = setTimeout(() => root.toggleAttribute("data-resting", !document.hasFocus()), REST_AFTER_MS);
    };
    const back = () => {
      clearTimeout(timer);
      root.removeAttribute("data-resting");
    };
    if (!document.hasFocus()) away();
    window.addEventListener("blur", away);
    window.addEventListener("focus", back);
    return () => {
      back();
      window.removeEventListener("blur", away);
      window.removeEventListener("focus", back);
    };
  }, []);
  return null;
}

function Light({ part }: { part: Part }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    paint(el, part);
    let drawnWith = tokensNow();
    let settling: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      clearTimeout(settling);
      // A stretched canvas does not show for the moment a resize lasts, and redrawing allocates a whole new one.
      settling = setTimeout(() => {
        drawnWith = tokensNow();
        paint(el, part);
      }, 150);
    };
    const scale = SCALE[part];
    const resized = new ResizeObserver(() => {
      if (Math.ceil(el.clientWidth * scale) !== el.width || Math.ceil(el.clientHeight * scale) !== el.height) again();
    });
    resized.observe(el);
    // A theme's colours arrive as classes and inline tokens on the root, which also change for much else (a menu opening).
    const recoloured = new MutationObserver(() => {
      if (tokensNow() !== drawnWith) again();
    });
    recoloured.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      clearTimeout(settling);
      resized.disconnect();
      recoloured.disconnect();
    };
  }, [part]);
  // The stars drift with the sky: the same box and the same animation.
  return <canvas ref={canvas} className={part === "sun" ? "sun-sun" : "sun-sky"} aria-hidden="true" />;
}
