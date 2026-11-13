import { expect, it } from "vitest";
import { cues } from "../src/promo/babysitter/cues";
import { PLAN, RUN, RUN_FROM, hop } from "../src/promo/babysitter/plan";
import { T } from "../src/promo/babysitter/stage";
import { D, DEPS, NODE, PLAN as DAY, RUN as RUN_DAY } from "../src/promo/day/story";
import { POINTER } from "../src/promo/babysitter/cues";
import { CUTS, cuesOf, pointerOf, spanOf } from "../src/promo/day/cuts";
import { COLUMNS, columnsAt, liveAt, paths, place, statusAt, variantAt } from "../src/promo/sim";
import { BOARD, CHANGES, KEYS, KEYS_SECONDS, LANTERN, LANTERN_SECONDS, METRO, METRO_SECONDS, NUMBERS, NUMBERS_SECONDS, PAD, PADS, PHONE, PHONE_SECONDS, POSTER, POSTER_SECONDS, RIVER, SEQUENCER, SEQUENCER_SECONDS, TRAINS, TTY, TTY_SECONDS, arrived, keysCues, lanternCues, metroCues, numbersCues, padRow, phoneCues, playhead, posterCues, sequencerCues, trainAt, ttyCues } from "../src/promo/beat/scripts";
import { C, CARD_SECONDS, K, PANE_MOVES, TERMINAL_POINTER, TERMINAL_SECONDS, W, WALL_POINTER, WALL_SECONDS, cardCues, terminalCues, wallCues } from "../src/promo/free/scripts";
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

it("keeps every cut's cues in order and inside it, and its pointer's clicks on its route", () => {
  expect(CUTS.map((cut) => cut.id)).toEqual([...new Set(CUTS.map((cut) => cut.id))]);
  for (const cut of CUTS) {
    const { seconds } = spanOf(cut);
    for (const lang of ["en", "zh"] as const) {
      const all = cuesOf(cut, lang);
      expect(all.every((cue, i) => cue.at >= 0 && cue.at < seconds && (i === 0 || cue.at >= all[i - 1].at))).toBe(true);
      expect(all.filter((cue) => cue.kind === "end")).toHaveLength(1);
    }
    expect(cut.poster).toBeGreaterThanOrEqual(cut.from);
    expect(cut.poster).toBeLessThan(cut.to);
  }
  for (const { route, clicks } of [POINTER, ...CUTS.map(pointerOf)]) {
    expect(clicks.every((at) => at >= route[0].at && at <= route[route.length - 1].at)).toBe(true);
    expect(route.every((stop, i) => i === 0 || stop.at > route[i - 1].at)).toBe(true);
  }
});

it("keeps the free films' cues in order and inside them, and their beats in the order they are told", () => {
  for (const [cues, seconds] of [[terminalCues(), TERMINAL_SECONDS], [wallCues(), WALL_SECONDS], [cardCues(), CARD_SECONDS]] as const) {
    expect(cues.every((cue, i) => cue.at >= 0 && cue.at < seconds && (i === 0 || cue.at >= cues[i - 1].at))).toBe(true);
    expect(cues.filter((cue) => cue.kind === "end")).toHaveLength(1);
  }
  for (const beats of [Object.values(K), Object.values(W), [...C.steps, C.own, C.end]]) expect(beats).toEqual([...beats].sort((a, b) => a - b));
  // a pane's ticket is in review before it is done, and only after its ticket has come out beside it
  expect(PANE_MOVES.every(([pr, done]) => pr > K.ticket && (done > pr || done === Infinity))).toBe(true);
  for (const { route, clicks } of [TERMINAL_POINTER, WALL_POINTER]) {
    expect(clicks.every((at) => at >= route[0].at && at <= route[route.length - 1].at)).toBe(true);
    expect(route.every((stop, i) => i === 0 || stop.at > route[i - 1].at)).toBe(true);
  }
});

it("cuts the films with a song to its beats: every part inside the music, every cue inside the film", () => {
  for (const [song, seconds, cues] of [[POSTER, POSTER_SECONDS, posterCues()], [LANTERN, LANTERN_SECONDS, lanternCues()], [TTY, TTY_SECONDS, ttyCues()], [SEQUENCER, SEQUENCER_SECONDS, sequencerCues()], [METRO, METRO_SECONDS, metroCues()], [KEYS, KEYS_SECONDS, keysCues()], [PHONE, PHONE_SECONDS, phoneCues()], [NUMBERS, NUMBERS_SECONDS, numbersCues()]] as const) {
    const beats = Object.values(song.marks);
    expect(beats).toEqual([...beats].sort((a, b) => a - b));
    expect(beats.every((mark) => mark > 0 && mark <= song.beats)).toBe(true);
    expect(seconds).toBeGreaterThan((song.beats * 60) / song.bpm);
    expect(cues.every((cue) => cue.at >= 0 && cue.at < seconds)).toBe(true);
  }
  // the terminal's board: claimed, then a pull request, then merged, and all eight merged before the song's fanfare
  expect(BOARD.every((ticket) => ticket.claim < ticket.pr && ticket.pr < ticket.merge && ticket.merge <= TTY.marks.win)).toBe(true);
  // the river: seven lanterns through the bridge before dawn, the last only once the person has answered
  expect(RIVER.bridge + 6).toBeLessThan(RIVER.dawn);
  expect(RIVER.last).toBeGreaterThan(RIVER.answer);
});

it("moves the sequencer's pads only as the playhead crosses them, and the metro's trains one station at a time", () => {
  for (const [i, pad] of PAD.entries()) {
    expect(pad.on < pad.claim && pad.claim < pad.pr && pad.pr < pad.merge && pad.merge < PADS.stop).toBe(true);
    // each move lands on the pad's own column
    for (const q of [pad.claim, pad.pr, pad.merge]) expect(Math.round(playhead(q))).toBe(i * 2);
    expect([padRow(i, pad.on), padRow(i, pad.claim), padRow(i, pad.pr), padRow(i, pad.merge)]).toEqual([0, 1, 2, 3]);
  }
  expect(playhead((PADS.ask + PADS.tap) / 2)).toBe(PADS.asks * 2);
  for (const [j] of TRAINS.entries()) {
    for (let q = 0; q < METRO.marks.out; q += 0.25) expect(trainAt(j, q + 0.25).at).toBeGreaterThanOrEqual(trainAt(j, q).at);
    expect(trainAt(j, CHANGES.day).at).toBe(6);
  }
  // the one that changes is at the person's station while it is asked, and nowhere else is anyone
  expect(trainAt(CHANGES.train, (CHANGES.asks + CHANGES.answered) / 2).up).toBe(1);
  expect(arrived(METRO.marks.out)).toBe(TRAINS.length);
});
