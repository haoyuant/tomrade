/** A film is a function of the frame: nothing in it reads a clock. */
export const FPS = 60;

export const clamp = (x: number, low = 0, high = 1): number => Math.min(high, Math.max(low, x));
export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
/** How far t is from `from` to `to`, held at 0 before and 1 after. */
export const span = (t: number, from: number, to: number): number => clamp((t - from) / (to - from));

export const ease = {
  out: (u: number): number => 1 - (1 - u) ** 3,
  outQuint: (u: number): number => 1 - (1 - u) ** 5,
  in: (u: number): number => u ** 3,
  inOut: (u: number): number => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2),
  /** Past its end and back: something landing. */
  back: (u: number): number => 1 + 2.4 * (u - 1) ** 3 + 1.4 * (u - 1) ** 2
};

/** Steps through keyframes [time, value], easing between neighbours. */
export function track(t: number, keys: [number, number][], curve: (u: number) => number = ease.inOut): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i += 1) {
    if (t <= keys[i][0]) return lerp(keys[i - 1][1], keys[i][1], curve(span(t, keys[i - 1][0], keys[i][0])));
  }
  return keys[keys.length - 1][1];
}

/** A number in [0, 1) that depends only on its seeds. */
export function noise(a: number, b = 0): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
