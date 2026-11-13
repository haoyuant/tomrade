import { expect, it } from "vitest";
import { cues } from "../src/promo/cues";
import { COLUMNS, PLAN, RUN, RUN_FROM, columnsAt, paths, place, statusAt, variantAt } from "../src/promo/sim";
import { FRAMES, FPS, T } from "../src/promo/time";

const HEIGHT = 70;
const at = paths(() => HEIGHT);

it("ends the promo's board with every ticket delivered, and never runs more than three at once at night", () => {
  expect(PLAN.every((plan) => statusAt(plan, T.proof) === "done")).toBe(true);
  for (let frame = Math.round(RUN_FROM * FPS); frame < FRAMES; frame += 1) {
    expect(columnsAt(frame / FPS).doing.length).toBeLessThanOrEqual(3);
  }
  // a ticket only ever moves forward, one column at a time
  for (const plan of PLAN) {
    const steps = [plan.start, ...plan.moves.map((move) => move.to)].map((status) => COLUMNS.indexOf(status));
    expect(steps.slice(1).every((column, i) => column === steps[i] + 1)).toBe(true);
    expect(plan.moves.every((move, i) => i === 0 || move.at > plan.moves[i - 1].at)).toBe(true);
  }
  // the run's tickets are the ones still open when it starts
  expect(RUN).toEqual(PLAN.flatMap((plan, n) => (statusAt(plan, RUN_FROM) === "done" ? [] : [n])));
});

it("lets no two cards rest in the same place, and draws a frame the same way every time", () => {
  for (const second of [T.board + 0.7, T.ask, T.night, T.proof]) {
    // settled: nothing has moved for a second
    const spots = PLAN.map((_, n) => place(at[n], second));
    for (let a = 0; a < spots.length; a += 1) {
      for (let b = a + 1; b < spots.length; b += 1) {
        if (spots[a].lift || spots[b].lift || spots[a].x !== spots[b].x) continue;
        expect(Math.abs(spots[a].y - spots[b].y)).toBeGreaterThanOrEqual(HEIGHT);
      }
    }
  }
  expect(place(at[3], 15.31)).toEqual(place(at[3], 15.31));
  expect(variantAt(PLAN[2], 11)).toBe("waiting");
});

it("orders the soundtrack's cues and keeps them inside the film", () => {
  const all = cues();
  expect(all.every((cue, i) => cue.at >= 0 && cue.at < T.total && (i === 0 || cue.at >= all[i - 1].at))).toBe(true);
  expect(all.filter((cue) => cue.kind === "hop")).toHaveLength(PLAN.reduce((sum, plan) => sum + plan.moves.length, 0));
});
