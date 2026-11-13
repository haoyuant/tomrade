import { HOP, run, type Plan } from "../sim";

/** When the person answers the one question. */
export const ANSWERED = 12.75;
/** When the auto run starts. */
export const RUN_FROM = 14.15;

/** The night's writes come one after another, this far apart. */
const night = (step: number): number => RUN_FROM + 0.3 + step * 0.185;

/**
 * The board's story: three tickets by day, the question, then the auto run through the night, three at once. The
 * night's steps are numbered in the order they happen, so no two cards leave at the same moment.
 */
export const PLAN: Plan[] = [
  { key: "APP-41", agent: "Claude Code", priority: 3, start: "todo", pr: 212, moves: run(5.75, 7.7, 9.3) },
  { key: "APP-42", agent: "Codex", priority: 4, start: "todo", pr: 213, moves: run(6.45, 8.7, night(1)) },
  { key: "APP-43", agent: "Codex", priority: 2, start: "todo", pr: 215, moves: run(7.1, night(2), night(6)), waiting: [10.75, ANSWERED] },
  { key: "APP-44", agent: "Claude Code", priority: 3, start: "todo", pr: 216, moves: run(9.7, night(4), night(9)) },
  { key: "APP-45", agent: "Claude Code", priority: 2, start: "todo", pr: 217, moves: run(night(0), night(7), night(12)) },
  { key: "APP-46", agent: "Codex", priority: 2, start: "todo", pr: 218, moves: run(night(3), night(10), night(14)) },
  { key: "APP-47", agent: "Claude Code", priority: 1, start: "todo", pr: 219, moves: run(night(5), night(13), night(16)) },
  { key: "APP-48", agent: "Codex", priority: 2, start: "todo", pr: 220, moves: run(night(8), night(15), night(18)) },
  { key: "APP-49", agent: "Claude Code", priority: 1, start: "todo", pr: 221, moves: run(night(11), night(17), night(19)) },
  { key: "APP-39", agent: "Codex", priority: 2, start: "verifying", pr: 209, moves: [{ at: 8.2, to: "done" }] },
  { key: "APP-38", agent: "Claude Code", priority: 2, start: "done", pr: 207, moves: [] }
];

/** The tickets the auto run takes on. */
export const RUN = [1, 2, 3, 4, 5, 6, 7, 8];

/** A card crosses faster in the night's hurry. */
export const hop = (at: number): number => (at > RUN_FROM ? 0.46 : HOP);
