import type { Pointer } from "../parts";
import { run, type Plan } from "../sim";
import { WIN_W, type Format } from "../stage";
import { ease, span, track } from "../time";
import type { Lang } from "../words";
import { CHAT } from "./words";

/** Where each part of the day starts, in seconds. */
export const D = {
  /** The first sentence is sent, and lands on the board as a ticket. */
  send: 2.5, ticket: 3.9,
  /** "Tidy up", and five tickets where one was. */
  tidy: 6.7, split: 7.9,
  /** The whole run taken back in one click, then redone a write at a time. */
  revert: 10.6, redo: 12.1,
  /** The terminal comes in; one agent asks, and is answered. */
  build: 14.0, ask: 21.2, picked: 23.2, answered: 24.0,
  /** The board gives way to the dependency graph, and the auto run starts. */
  merge: 25.6, run: 28.2,
  dawn: 35.5, morning: 37.6,
  /** The window leaves. */
  out: 41.0
};

/** The night's writes come one after another, this far apart. */
const night = (step: number): number => D.run + 0.7 + step * 0.4;
/** Redo re-applies one write a click: the five tickets come back one by one, and the sixth click takes the idea's ticket away again. */
export const REDO = [0, 1, 2, 3, 4, 5].map((click) => D.redo + click * 0.2);
const split = (n: number): [number, number][] => [[D.split, D.revert], [REDO[n], Infinity]];

/**
 * The day's tickets. One idea becomes a ticket and then five; two agents build two of them by day, and the auto run
 * takes all eight open ones through the night, three at once, never one before what it waits on. The night's steps
 * are numbered in the order they happen.
 */
export const PLAN: Plan[] = [
  { key: "APP-52", agent: "Claude Code", priority: 2, start: "todo", pr: 0, moves: [], written: true, lives: [[D.ticket, D.split], [D.revert, REDO[5]]] },
  { key: "APP-53", agent: "Claude Code", priority: 2, start: "todo", pr: 231, moves: run(15.5, 18.6, night(0)), written: true, lives: split(0) },
  { key: "APP-54", agent: "Claude Code", priority: 2, start: "todo", pr: 234, moves: run(night(1), night(6), night(8)), written: true, lives: split(1) },
  { key: "APP-55", agent: "Codex", priority: 2, start: "todo", pr: 232, moves: run(16.5, night(3), night(4)), written: true, lives: split(2), waiting: [D.ask, D.answered] },
  { key: "APP-56", agent: "Codex", priority: 3, start: "todo", pr: 236, moves: run(night(9), night(14), night(16)), written: true, lives: split(3) },
  { key: "APP-57", agent: "Claude Code", priority: 3, start: "todo", pr: 235, moves: run(night(5), night(12), night(13)), written: true, lives: split(4) },
  { key: "APP-51", agent: "Codex", priority: 3, start: "todo", pr: 233, moves: run(night(2), night(7), night(10)) },
  { key: "APP-46", agent: "Codex", priority: 2, start: "todo", pr: 237, moves: run(night(11), night(15), night(17)) },
  { key: "APP-47", agent: "Claude Code", priority: 4, start: "todo", pr: 238, moves: run(night(18), night(19), night(20)) },
  { key: "APP-49", agent: "Codex", priority: 2, start: "done", pr: 229, moves: [] },
  { key: "APP-48", agent: "Claude Code", priority: 2, start: "done", pr: 227, moves: [] }
];

/** How long before the film each ticket was last touched, in minutes. */
export const AGE = [0, 0, 0, 0, 0, 0, 300, 1500, 2900, 200, 1440];
/** The tickets the auto run takes on, and what each waits on: [blocker, blocked]. */
export const RUN = [1, 2, 3, 4, 5, 6, 7, 8];
export const DEPS: [number, number][] = [[1, 2], [2, 4], [1, 5], [3, 5], [6, 7], [7, 8]];
/** Where each of the run's tickets sits in the graph: its level from the left and its row. */
export const NODE: Record<number, [number, number]> = { 1: [0, 0], 3: [0, 2], 6: [0, 3], 2: [1, 0], 5: [1, 1], 7: [1, 3], 4: [2, 0], 8: [2, 3] };

/** Daylight: 0 is Daybreak, 1 is Sunrise. The story is an evening and its night; morning comes when the auto run is done. */
export const day = (t: number): number => ease.inOut(span(t, D.dawn, D.dawn + 1.9));
export const rise = (t: number): number => track(t, [[D.dawn - 0.3, 0.12], [D.dawn + 2.2, 1]]);
/** Minutes since midnight on the wall clock; the night runs in a few seconds. */
export const clock = (t: number): number => 21 * 60 + 10 + Math.min(t, D.run) * 1.7 + ease.inOut(span(t, D.run + 0.5, D.dawn + 1.6)) * 520;
export const skyTime = (t: number): number => t + 26 * ease.inOut(span(t, D.run + 0.5, D.dawn + 1.6));

/**
 * The app window in each cut: its width in its own pixels and the scale it is seen whole at, the assistant's width (a
 * narrow window keeps it at 352), the graph's scale and how far apart its levels and rows stand, and where the
 * terminal sits on the frame.
 */
export interface Lay { w: number; full: number; panel: number; graph: { scale: number; level: number; pitch: number }; terminal: { x: number; y: number; w: number; h: number } }
export const LAY: Record<Format["id"], Lay> = {
  wide: { w: WIN_W, full: 1.2, panel: 440, graph: { scale: 1, level: 340, pitch: 126 }, terminal: { x: 26, y: 722, w: 640, h: 338 } },
  tall: { w: 880, full: 1.2, panel: 352, graph: { scale: 0.9, level: 296, pitch: 230 }, terminal: { x: 36, y: 1404, w: 1008, h: 470 } }
};

/**
 * How the window sits in the frame: its scale, the point of its own that sits under the middle of the caption
 * band's lower edge, and its height, which follows the scale so that its foot stays at the frame's.
 */
export function camera(t: number, f: Format): { s: number; wx: number; wy: number; h: number } {
  const lay = LAY[f.id];
  const tall = f.id === "tall";
  // It opens close on the composer, then pulls back to the whole window.
  const back = [D.send - 0.15, D.send + 1.15] as const;
  const composer = { s: tall ? 2.6 : 3, wx: lay.w - lay.panel / 2, wy: tall ? 802 : 478 };
  // The tall cut's window is narrow: it comes closer for the board's columns and stays a little closer for the graph.
  const near = [D.tidy + 0.8, D.tidy + 1.6, D.merge, D.merge + 0.7] as const;
  const ask = [D.ask - 0.1, D.ask + 0.7, D.answered + 0.5, D.answered + 1.3] as const;
  const s = track(t, tall
    ? [[back[0], composer.s], [back[1], lay.full], [near[0], lay.full], [near[1], 1.5], [near[2], 1.5], [near[3], 1.35]]
    : [[back[0], composer.s], [back[1], lay.full], [ask[0], lay.full], [ask[1], 1.5], [ask[2], 1.5], [ask[3], lay.full]]);
  const wx = track(t, tall
    ? [[back[0], composer.wx], [back[1], lay.w / 2], [near[0], lay.w / 2], [near[1], 408], [near[2], 408], [near[3], lay.w / 2]]
    : [[back[0], composer.wx], [back[1], lay.w / 2], [ask[0], lay.w / 2], [ask[1], 700], [ask[2], 700], [ask[3], lay.w / 2]]);
  return { s, wx, wy: track(t, [[back[0], composer.wy], [back[1], 0]]), h: (f.h - f.winTop - 14) / (t < back[1] ? lay.full : s) };
}

/** How far the board has scrolled sideways: the tall cut's window is narrow, and follows the work to Doing and Verifying. */
export const scrolled = (t: number, f: Format): number => (f.id === "tall" ? 346 * ease.inOut(span(t, D.build + 0.3, D.build + 1.3)) : 0);
/** How far the assistant has folded to its rail. */
export const folded = (t: number): number => ease.inOut(span(t, D.build - 0.5, D.build));

/** The pointer sends the sentence, takes the run back and redoes it, answers the question, opens the graph and starts the auto run. */
export const POINTER: Pointer = {
  route: [
    { at: 1.6, to: [0.62, 1.08] },
    { at: D.send - 0.05, to: "send" },
    { at: D.send + 0.3, to: "send" },
    { at: D.send + 1.3, to: "col-doing" },
    { at: D.revert - 1.4, to: "col-doing" },
    { at: D.revert - 0.08, to: "revert" },
    { at: D.revert + 0.5, to: "revert" },
    { at: D.redo - 0.08, to: "redo" },
    { at: REDO[5] + 0.4, to: "redo" },
    { at: REDO[5] + 1.2, to: [0.5, 1.08] },
    { at: D.ask + 0.9, to: [0.56, 1.06] },
    { at: D.picked - 0.08, to: "chip" },
    { at: D.picked + 0.2, to: "chip" },
    { at: D.answered - 0.06, to: "confirm" },
    { at: D.answered + 0.4, to: "confirm" },
    { at: D.merge + 0.25, to: "graph" },
    { at: D.merge + 0.8, to: "graph" },
    { at: D.run - 0.08, to: "autorun" },
    { at: D.run + 0.45, to: "autorun" },
    { at: D.run + 1.2, to: [1.06, 0.3] }
  ],
  clicks: [D.send, D.revert, ...REDO, D.picked, D.answered, D.merge + 0.35, D.run]
};

/** When the person starts typing each message; a letter takes KEY seconds, and Chinese is typed in fewer, slower strokes. */
export const TYPED = { idea: 0.3, tidy: D.tidy - 0.75 };
export const KEY = 0.07;
export const rate = (lang: Lang): number => (lang === "zh" ? 2.4 : 1);
/** When each letter of the person's messages is typed: what the soundtrack's keys are written from. */
export const keysAt = (lang: Lang): number[] => [...[...CHAT[lang].idea].map((_, i) => TYPED.idea + i * KEY * rate(lang)), ...[...CHAT[lang].tidy].map((_, i) => TYPED.tidy + i * KEY * rate(lang))];

/** When each line of each agent's terminal is written. The lines that reach Tomrade or git are the board's moves. */
export const LINES = {
  claude: [14.9, 15.5, 16.3, 17.4, 18.6, 19.7],
  codex: [15.9, 16.5, 17.7, 19.2, D.ask, D.answered + 0.3]
} as const;
