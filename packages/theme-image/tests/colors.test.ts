import { describe, expect, it } from "vitest";
import { contrast, deriveTheme, paletteOf, parseHex, seedFromPalette, veilOver, type Rgb } from "../src/colors";

/** A picture as a canvas reads it: each colour filling its share of the pixels. */
function picture(parts: [Rgb, number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [rgb, count] of parts) for (let i = 0; i < count; i++) out.push(...rgb, 255);
  return new Uint8ClampedArray(out);
}
const rgb = (value: string) => parseHex(value)!;

describe("paletteOf", () => {
  it("finds the picture's colours by how much of it they cover", () => {
    const palette = paletteOf(picture([[[250, 230, 236], 700], [[220, 60, 120], 200], [[40, 60, 120], 100]]));
    expect(palette.swatches[0]!.share).toBeCloseTo(0.7, 2);
    expect(palette.lightness).toBeGreaterThan(0.6);
  });

  it("ignores transparent pixels", () => {
    const pixels = picture([[[10, 10, 10], 10]]);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 0;
    expect(paletteOf(pixels).swatches).toHaveLength(1);
  });
});

describe("seedFromPalette", () => {
  it("takes a light picture's vivid colour as the accent", () => {
    const seed = seedFromPalette(paletteOf(picture([[[250, 236, 240], 700], [[214, 52, 110], 200], [[60, 140, 200], 100]])));
    expect(seed.mode).toBe("light");
    const [r, , b] = seed.accent;
    expect(r).toBeGreaterThan(b);
  });

  it("reads a dark picture as a dark theme", () => {
    expect(seedFromPalette(paletteOf(picture([[[20, 18, 40], 800], [[90, 220, 255], 200]]))).mode).toBe("dark");
  });
});

describe("deriveTheme", () => {
  const pictures: [string, [Rgb, number][]][] = [
    ["a pale pink portrait", [[[250, 228, 236], 500], [[236, 120, 160], 300], [[60, 40, 70], 200]]],
    ["a night city", [[[16, 14, 36], 600], [[255, 60, 200], 200], [[60, 230, 255], 200]]],
    ["a picture of loud contrasts", [[[255, 255, 255], 500], [[0, 0, 0], 500]]]
  ];
  for (const [label, parts] of pictures) it(`keeps text readable over ${label}`, () => {
    const palette = paletteOf(picture(parts));
    const theme = deriveTheme(seedFromPalette(palette), palette);
    const t = (name: keyof typeof theme.tokens) => rgb(theme.tokens[name]);
    for (const [name, min] of [["fg", 7.5], ["fg-2", 6], ["muted", 5.5], ["meta", 4.5], ["accent", 4.5], ["success", 4.5], ["warn", 4.5], ["danger", 4.5]] as const) {
      expect(contrast(t(name), t("bg")), name).toBeGreaterThanOrEqual(min);
      // through the pane, over each of the picture's main colours
      for (const { rgb: below, share } of palette.swatches) if (share >= 0.03) {
        const seen = t("bg").map((v, i) => Math.round(v * theme.veil + below[i]! * (1 - theme.veil))) as unknown as Rgb;
        expect(contrast(t(name), seen), `${name} over ${below.join(",")}`).toBeGreaterThanOrEqual(min - 0.05);
      }
    }
    expect(contrast(t("accent-on"), t("accent"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t("tag-fg"), t("tag-bg-strong"))).toBeGreaterThanOrEqual(4.5);
    expect(theme.veil).toBeGreaterThanOrEqual(0.5);
    expect(theme.veil).toBeLessThanOrEqual(0.8);
  });

  it("follows the seed's mode", () => {
    const palette = paletteOf(picture([[[128, 128, 128], 10]]));
    const seed = { canvas: [128, 128, 128] as Rgb, accent: [200, 40, 90] as Rgb, tag: [40, 90, 200] as Rgb };
    expect(contrast(rgb(deriveTheme({ ...seed, mode: "dark" }, palette).tokens.bg), [0, 0, 0])).toBeLessThan(3);
    expect(contrast(rgb(deriveTheme({ ...seed, mode: "light" }, palette).tokens.bg), [255, 255, 255])).toBeLessThan(1.2);
  });
});

describe("veilOver", () => {
  it("covers a busier picture more, so the theme's secondary text still reads over it", () => {
    const calm = paletteOf(picture([[[250, 244, 250], 900], [[236, 220, 236], 100]]));
    const theme = deriveTheme(seedFromPalette(calm), calm);
    const busy = paletteOf(picture([[[20, 20, 30], 500], [[250, 250, 250], 500]]));
    const veil = veilOver(theme.tokens, busy);
    expect(veil).toBeGreaterThan(veilOver(theme.tokens, calm));
    expect(veil).toBeLessThanOrEqual(0.8);
  });
});
