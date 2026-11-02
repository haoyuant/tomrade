import type { ThemeTokenName } from "@tomradex/domain";

/** A theme drawn from a picture: the picture is the backdrop, its colours tint the panes and pick the accent. */
export type Rgb = readonly [number, number, number];
export interface Swatch { rgb: Rgb; share: number }
export interface ImagePalette { swatches: Swatch[]; lightness: number }
export type ThemeFont = "sans" | "serif" | "mincho" | "mono";
/** What the picture says, from a model or read locally; the tokens are derived from it, never taken as given. */
export interface ThemeSeed { mode: "light" | "dark"; canvas: Rgb; accent: Rgb; tag: Rgb; font?: ThemeFont; name?: string }
export interface DerivedTheme { base: "light" | "dark"; tokens: Record<ThemeTokenName, string>; veil: number }

interface Lch { l: number; c: number; h: number }
const MAX_VEIL = 0.8;

const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const gamma = (c: number) => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

function toLch([r, g, b]: Rgb): Lch {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360 };
}

function linearOf({ l: L, c, h }: Lch): [number, number, number] {
  const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** Out of sRGB, the colour gives up chroma rather than hue. */
function tone(l: number, c: number, h: number): Rgb {
  const L = Math.min(1, Math.max(0, l));
  let C = Math.max(0, c), rgb = linearOf({ l: L, c: C, h });
  while (C > 0.001 && rgb.some(v => v < -1e-4 || v > 1 + 1e-4)) { C *= 0.92; rgb = linearOf({ l: L, c: C, h }); }
  return rgb.map(v => Math.round(Math.min(1, Math.max(0, gamma(Math.max(0, v)))) * 255)) as unknown as Rgb;
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrast(x: Rgb, y: Rgb): number {
  const a = luminance(x), b = luminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
/** The browser blends a translucent pane over the picture channel by channel, in sRGB. */
const over = (top: Rgb, below: Rgb, alpha: number): Rgb => top.map((v, i) => Math.round(v * alpha + below[i]! * (1 - alpha))) as unknown as Rgb;
export const hex = (rgb: Rgb) => `#${rgb.map(v => v.toString(16).padStart(2, "0")).join("")}`;
export function parseHex(value: string): Rgb | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return m ? [0, 2, 4].map(i => parseInt(m[1]!.slice(i, i + 2), 16)) as unknown as Rgb : undefined;
}

/** The picture's main colours, from its pixels (RGBA, as a canvas gives them): k-means in OKLab. */
export function paletteOf(pixels: Uint8ClampedArray, k = 8): ImagePalette {
  const points: [number, number, number][] = [];
  let lightness = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3]! < 128) continue;
    const { l, c, h } = toLch([pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]);
    points.push([l, c * Math.cos(h * Math.PI / 180), c * Math.sin(h * Math.PI / 180)]);
    lightness += l;
  }
  if (!points.length) return { swatches: [{ rgb: [128, 128, 128], share: 1 }], lightness: 0.6 };
  lightness /= points.length;
  const dist = (p: number[], q: number[]) => (p[0]! - q[0]!) ** 2 + (p[1]! - q[1]!) ** 2 + (p[2]! - q[2]!) ** 2;
  // Farthest-point seeding: the same picture always gives the same palette.
  const centres = [points[0]!.slice() as [number, number, number]];
  while (centres.length < Math.min(k, points.length)) {
    let best = points[0]!, far = -1;
    for (const p of points) { const d = Math.min(...centres.map(c => dist(p, c))); if (d > far) { far = d; best = p; } }
    if (far <= 1e-6) break;
    centres.push(best.slice() as [number, number, number]);
  }
  let counts = centres.map(() => 0);
  for (let round = 0; round < 12; round++) {
    const sums = centres.map(() => [0, 0, 0]);
    counts = centres.map(() => 0);
    for (const p of points) {
      let at = 0, near = Infinity;
      centres.forEach((c, i) => { const d = dist(p, c); if (d < near) { near = d; at = i; } });
      counts[at]!++; sums[at]![0]! += p[0]; sums[at]![1]! += p[1]; sums[at]![2]! += p[2];
    }
    centres.forEach((c, i) => { if (counts[i]) for (let j = 0; j < 3; j++) c[j] = sums[i]![j]! / counts[i]!; });
  }
  const swatches = centres.map((c, i) => ({ rgb: tone(c[0], Math.hypot(c[1], c[2]), (Math.atan2(c[2], c[1]) * 180 / Math.PI + 360) % 360), share: counts[i]! / points.length }))
    .filter(s => s.share > 0).sort((a, b) => b.share - a.share);
  return { swatches, lightness };
}

/**
 * As little veil as lets secondary text read over the picture's darkest (or lightest) part; past
 * MAX_VEIL the picture would be a ghost, so the text colours move further from the panes instead.
 */
function leastVeil(bg: Rgb, text: Rgb, behind: Rgb[]): number {
  let veil = 0.5;
  while (veil < MAX_VEIL && Math.min(...behind.map(rgb => contrast(text, over(bg, rgb, veil)))) < 4.5) veil = Math.round((veil + 0.02) * 100) / 100;
  return veil;
}

/** The veil for another picture behind a theme already made, such as the Terminal window's. */
export function veilOver(tokens: Pick<Record<ThemeTokenName, string>, "bg" | "muted">, palette: ImagePalette): number {
  const bg = parseHex(tokens.bg) ?? [128, 128, 128], muted = parseHex(tokens.muted) ?? [128, 128, 128];
  return leastVeil(bg, muted, palette.swatches.filter(s => s.share >= 0.03).map(s => s.rgb));
}

const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** A seed read from the palette alone, for when no model looks at the picture. */
export function seedFromPalette(palette: ImagePalette): ThemeSeed {
  const vivid = palette.swatches.map(s => ({ s, lch: toLch(s.rgb) })).filter(x => x.lch.c >= 0.045)
    .sort((a, b) => b.lch.c * Math.sqrt(b.s.share) - a.lch.c * Math.sqrt(a.s.share));
  const accent = vivid[0]?.s.rgb ?? [74, 108, 196];
  const accentHue = toLch(accent).h;
  const tag = vivid.find(x => hueGap(x.lch.h, accentHue) >= 30)?.s.rgb ?? accent;
  return { mode: palette.lightness >= 0.6 ? "light" : "dark", canvas: palette.swatches[0]!.rgb, accent, tag };
}

/** Moves a colour's lightness away from what it sits on until it reads against all of it. */
function readable(start: Lch, min: number, grounds: Rgb[], darker: boolean): Rgb {
  let l = start.l, rgb = tone(l, start.c, start.h);
  while (Math.min(...grounds.map(g => contrast(rgb, g))) < min && l > 0 && l < 1) {
    l += darker ? -0.01 : 0.01;
    rgb = tone(l, start.c, start.h);
  }
  return rgb;
}

/**
 * All 21 tokens from a seed. The panes are the tokens laid over the picture at
 * `veil` opacity, so every text colour is checked against the picture's main
 * colours seen through them, not only against the solid token.
 */
export function deriveTheme(seed: ThemeSeed, palette: ImagePalette): DerivedTheme {
  const dark = seed.mode === "dark";
  const canvas = toLch(seed.canvas), h = canvas.h, c = Math.min(canvas.c, dark ? 0.035 : 0.025);
  const bg = tone(dark ? 0.2 : 0.972, c, h);
  const surface = tone(dark ? 0.245 : 0.99, c * 0.8, h);
  const behind = palette.swatches.filter(s => s.share >= 0.03).map(s => s.rgb);
  const seen = (alpha: number) => behind.map(rgb => over(bg, rgb, alpha));
  const muted: Lch = { l: dark ? 0.8 : 0.42, c: 0.012, h };
  const veil = leastVeil(bg, tone(muted.l, muted.c, muted.h), behind);
  // Cards sit on the panes a step more opaque; text must read on both.
  const grounds = [bg, surface, ...seen(veil), ...behind.map(rgb => over(surface, rgb, Math.min(1, veil + 0.12)))];
  const text = (l: number, min: number) => readable({ l, c: 0.012, h }, min, grounds, !dark);
  const accentSeed = toLch(seed.accent), accentC = Math.min(Math.max(accentSeed.c, 0.08), 0.19);
  const accent = readable({ l: dark ? Math.max(accentSeed.l, 0.7) : Math.min(accentSeed.l, 0.56), c: accentC, h: accentSeed.h }, 4.5, grounds, !dark);
  const accentLch = toLch(accent);
  const lightOn = tone(0.99, 0.01, accentLch.h), darkOn = tone(0.18, 0.02, accentLch.h);
  const status = (hue: number) => readable({ l: dark ? 0.78 : 0.5, c: 0.13, h: hue }, 4.5, grounds, !dark);
  const tagH = toLch(seed.tag).h;
  const tagBg = (l: number, chroma: number) => tone(l, chroma, tagH);
  const tagStrong = dark ? tagBg(0.37, 0.065) : tagBg(0.86, 0.07);
  const tokens: Record<ThemeTokenName, Rgb> = {
    bg, surface,
    "surface-warm": tone(dark ? 0.29 : 0.945, c, h),
    fg: text(dark ? 0.96 : 0.2, 7.5),
    "fg-2": text(dark ? 0.88 : 0.3, 6),
    muted: text(muted.l, 5.5),
    meta: text(dark ? 0.72 : 0.5, 4.5),
    border: tone(dark ? 0.35 : 0.88, c, h),
    "border-soft": tone(dark ? 0.3 : 0.915, c, h),
    accent,
    "accent-on": contrast(lightOn, accent) >= contrast(darkOn, accent) ? lightOn : darkOn,
    "accent-light": readable({ l: accentLch.l + (dark ? 0.08 : 0.06), c: accentLch.c * 0.9, h: accentLch.h }, 4.5, grounds, !dark),
    "accent-active": tone(accentLch.l + (dark ? 0.05 : -0.07), accentLch.c, accentLch.h),
    success: status(145), warn: status(78), danger: status(27),
    "tag-bg-faint": dark ? tagBg(0.26, 0.03) : tagBg(0.955, 0.025),
    "tag-bg-soft": dark ? tagBg(0.29, 0.04) : tagBg(0.93, 0.04),
    "tag-bg-base": dark ? tagBg(0.33, 0.055) : tagBg(0.895, 0.055),
    "tag-bg-strong": tagStrong,
    "tag-fg": readable({ l: dark ? 0.84 : 0.42, c: dark ? 0.1 : 0.13, h: tagH }, 4.5, [tagStrong], !dark)
  };
  return { base: seed.mode, veil, tokens: Object.fromEntries(Object.entries(tokens).map(([name, rgb]) => [name, hex(rgb)])) as Record<ThemeTokenName, string> };
}

/** The panes' fills over the picture, from the theme's own solid tokens. */
export function backdropFills(tokens: Pick<Record<ThemeTokenName, string>, "bg" | "surface">, veil: number): Record<string, string> {
  const bg = parseHex(tokens.bg) ?? [128, 128, 128], surface = parseHex(tokens.surface) ?? bg;
  const rgba = (rgb: Rgb, alpha: number) => `rgba(${rgb.join(", ")}, ${Math.min(1, Math.max(0, alpha)).toFixed(2)})`;
  return {
    "backdrop-shell": rgba(bg, veil + 0.08),
    "backdrop-pane": rgba(bg, veil),
    "backdrop-tile": rgba(surface, veil + 0.12),
    "backdrop-float": rgba(surface, veil + 0.04)
  };
}

export const FONT_STACKS: Record<ThemeFont, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  serif: 'Charter, Georgia, Palatino, "Songti SC", "Noto Serif CJK SC", "Times New Roman", serif',
  mincho: '"Hiragino Mincho ProN", "Songti SC", "Noto Serif CJK SC", "Yu Mincho", "SimSun", Georgia, serif',
  mono: '"JetBrains Mono", "SF Mono", Menlo, "PingFang SC", "Microsoft YaHei", monospace'
};
