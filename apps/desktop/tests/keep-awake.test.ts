import { expect, it, vi } from "vitest";
import { holdAwake } from "../src/keep-awake.js";

vi.mock("electron", () => ({ powerSaveBlocker: {} }));

it("holds the blocker only while it is wanted, and only once", () => {
  let wanted = false;
  const blocker = { start: vi.fn(() => 7), stop: vi.fn() };
  const hold = holdAwake(() => wanted, blocker);
  hold.sync();
  expect(blocker.start).not.toHaveBeenCalled();
  wanted = true;
  hold.sync();
  hold.sync();
  expect(blocker.start).toHaveBeenCalledTimes(1);
  wanted = false;
  hold.sync();
  expect(blocker.stop).toHaveBeenCalledTimes(1);
  expect(blocker.stop).toHaveBeenCalledWith(7);
  hold.sync();
  expect(blocker.stop).toHaveBeenCalledTimes(1);
});

it("lets go on the way out", () => {
  const blocker = { start: () => 1, stop: vi.fn() };
  const hold = holdAwake(() => true, blocker);
  hold.sync();
  hold.release();
  expect(blocker.stop).toHaveBeenCalledWith(1);
  hold.release();
  expect(blocker.stop).toHaveBeenCalledTimes(1);
});
