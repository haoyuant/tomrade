import { expect, it } from "vitest";
import { cues } from "../src/promo/babysitter/cues";
import { PLAN, RUN, RUN_FROM, hop } from "../src/promo/babysitter/plan";
import { T } from "../src/promo/babysitter/stage";
import { D, DEPS, NODE, PLAN as DAY, RUN as RUN_DAY } from "../src/promo/day/story";
import { FILMS } from "../src/promo/films";
import { COLUMNS, columnsAt, liveAt, paths, place, statusAt, variantAt } from "../src/promo/sim";
import { FPS } from "../src/promo/time";

const HEIGHT = 70;
const FRAMES = Math.round(T.total * FPS);
const at = paths(PLAN, () => HEIGHT);

it("ends the promo's board with every ticket delivered, and never runs more than three at once at night", () => {
  expect(PLAN.every((plan) => statusAt(plan, T.proof) === "done")).toBe(true);
  for (let frame = Math.round(RUN_FROM * FPS); frame < FRAMES; frame += 1) {
    expect(columnsAt(PLAN, frame / FPS).doing.length).toBeLessThanOrEqual(3);
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
    const spots = PLAN.map((_, n) => place(at[n], second, hop));
    for (let a = 0; a < spots.length; a += 1) {
      for (let b = a + 1; b < spots.length; b += 1) {
        if (spots[a].lift || spots[b].lift || spots[a].x !== spots[b].x) continue;
        expect(Math.abs(spots[a].y - spots[b].y)).toBeGreaterThanOrEqual(HEIGHT);
      }
    }
  }
  expect(place(at[3], 15.31, hop)).toEqual(place(at[3], 15.31, hop));
  expect(variantAt(PLAN[2], 11)).toBe("waiting");
});

it("orders the soundtrack's cues and keeps them inside the film", () => {
  const all = cues();
  expect(all.every((cue, i) => cue.at >= 0 && cue.at < T.total && (i === 0 || cue.at >= all[i - 1].at))).toBe(true);
  expect(all.filter((cue) => cue.kind === "hop")).toHaveLength(PLAN.reduce((sum, plan) => sum + plan.moves.length, 0));
});

it("runs the day's auto run down the dependency graph, three at once, and ends with all eight merged", () => {
  expect(DAY.every((plan, n) => !RUN_DAY.includes(n) || statusAt(plan, D.morning) === "done")).toBe(true);
  for (let frame = 0; frame < Math.round(D.out * FPS); frame += 1) {
    const t = frame / FPS;
    expect(columnsAt(DAY, t).doing.length).toBeLessThanOrEqual(3);
    // nothing is started before everything it waits on is merged
    for (const [blocker, blocked] of DEPS) expect(statusAt(DAY[blocked], t) === "todo" || statusAt(DAY[blocker], t) === "done").toBe(true);
  }
  for (const plan of DAY) {
    const steps = [plan.start, ...plan.moves.map((move) => move.to)].map((status) => COLUMNS.indexOf(status));
    expect(steps.slice(1).every((column, i) => column === steps[i] + 1)).toBe(true);
    expect(plan.moves.every((move, i) => i === 0 || move.at > plan.moves[i - 1].at)).toBe(true);
  }
  // every ticket in the graph has a place, and no two share one
  expect(new Set(RUN_DAY.map((n) => NODE[n].join())).size).toBe(RUN_DAY.length);
  // the idea is one ticket, then five, then one again when the run is taken back, then five once it is redone
  const live = (t: number) => DAY.flatMap((plan, n) => (liveAt(plan, t) && n < 6 ? [n] : []));
  expect([live(D.ticket + 1), live(D.split + 1), live(D.revert + 1), live(D.redo + 1.5)]).toEqual([[0], [1, 2, 3, 4, 5], [0], [1, 2, 3, 4, 5]]);
});

it("keeps every film's cues in order and inside it, and its pointer's clicks on its route", () => {
  expect(FILMS.map((film) => film.id)).toEqual([...new Set(FILMS.map((film) => film.id))]);
  for (const film of FILMS) {
    for (const lang of ["en", "zh"] as const) {
      const all = film.cues(lang);
      expect(all.every((cue, i) => cue.at >= 0 && cue.at < film.seconds && (i === 0 || cue.at >= all[i - 1].at))).toBe(true);
      expect(all.filter((cue) => cue.kind === "end")).toHaveLength(1);
    }
    expect(film.poster).toBeGreaterThanOrEqual(0);
    expect(film.poster).toBeLessThan(film.seconds);
    const { route, clicks } = film.pointer;
    expect(clicks.every((at) => at >= route[0].at && at <= route[route.length - 1].at)).toBe(true);
    expect(route.every((stop, i) => i === 0 || stop.at > route[i - 1].at)).toBe(true);
  }
});
