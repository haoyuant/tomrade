import { expect, it } from 'vitest';
import { Timer } from '../src/timer.js';

const rules = { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4, autoStart: false };

it('keeps paused time, counts rounds, settles one phase after sleep and resets', () => {
  const timer = new Timer(rules);
  timer.start(0); timer.pause(60_000);
  expect(timer.remaining).toBe(24 * 60_000);
  expect(timer.deadline).toBeNull();
  timer.configure({ ...rules });
  expect(timer.remaining).toBe(24 * 60_000);
  timer.start(100_000); timer.tick(100_000 + 24 * 60_000);
  // A focus ends at a short break, paused by default, and is counted as one that ran out.
  expect(timer).toMatchObject({ phase: 'shortBreak', completed: 1, deadline: null, ended: 1, lastEnded: 'focus' });
  for (let n = 1; n < 4; n++) { timer.skip(0); timer.start(0); timer.tick(25 * 60_000); }
  expect(timer).toMatchObject({ phase: 'longBreak', completed: 4, remaining: 15 * 60_000 });
  timer.reset(); timer.configure({ ...rules, autoStart: true }); timer.start(0); timer.tick(100 * 60_000);
  // After sleep, one real session is counted and a fresh break starts.
  expect(timer).toMatchObject({ completed: 1, phase: 'shortBreak', deadline: 105 * 60_000 });
  timer.pause(101 * 60_000); timer.reset();
  expect(timer).toMatchObject({ phase: 'focus', completed: 0, remaining: 25 * 60_000, deadline: null });
  timer.configure({ ...rules, focusMinutes: 30 });
  expect(timer.remaining).toBe(30 * 60_000);
  // Skipping is not running out: no count, nothing to announce.
  const ended = timer.ended;
  timer.reset(); timer.skip(0);
  expect(timer.completed).toBe(0);
  expect(timer.ended).toBe(ended);
});

it('moves through the rounds whether phases are skipped or run out, then starts over', () => {
  const timer = new Timer(rules);
  const seen: string[] = [];
  for (let n = 0; n < 9; n++) { seen.push(`${timer.phase}:${timer.snapshot(0).round}`); timer.skip(0); }
  expect(seen).toEqual(['focus:1', 'shortBreak:1', 'focus:2', 'shortBreak:2', 'focus:3', 'shortBreak:3', 'focus:4', 'longBreak:4', 'focus:1']);
  expect(timer.completed).toBe(0);
  timer.reset(); timer.start(0); timer.tick(25 * 60_000); timer.start(25 * 60_000); timer.tick(30 * 60_000);
  expect(timer.snapshot(30 * 60_000)).toMatchObject({ phase: 'focus', round: 2, completed: 1 });
});
