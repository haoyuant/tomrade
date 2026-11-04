import { expect, it } from "vitest";
import { Context, Service } from "cordis";

/**
 * cordis hands a service's method a `this` wrapped for its caller (patches/cordis@4.0.0-rc.8.patch). Unpatched, a
 * method that calls itself again through `this` — a timer loop such as herdr's screen reading — wrapped it once more
 * each time: after a few hours every property read walked thousands of proxies, and then the stack ran out.
 */
class Loop extends Service {
  static provide = "loop";
  readonly seen = new Map<string, number>();
  readonly times: number[] = [];

  constructor(ctx: Context) {
    super(ctx, "loop");
  }

  round(left: number, done: () => void): void {
    const start = performance.now();
    for (let i = 0; i < 200; i++) this.seen.get("a");
    this.times.push(performance.now() - start);
    if (!left) return done();
    setImmediate(() => this.round(left - 1, done));
  }
}

it("reads a service's fields through `this` as quickly after many rounds of a loop that calls itself again through it", async () => {
  const ctx = new Context();
  await ctx.plugin(Loop);
  const loop = (ctx as unknown as { loop: Loop }).loop;
  await new Promise<void>((resolve) => loop.round(400, resolve));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const first = median(loop.times.slice(1, 51));
  const last = median(loop.times.slice(-50));
  // Unpatched, the last rounds were well over a hundred times slower than the first.
  expect(last).toBeLessThan(Math.max(first * 10, 1));
});
