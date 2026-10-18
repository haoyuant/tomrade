import { expect, it } from "vitest";
import { herdrHintGate, plainLaunch } from "../src/lib/herdr";

const plain = { mode: "terminal", launched: true, pane: null };

it("follows only a terminal that opened outside herdr, on a machine without herdr", () => {
  expect(plainLaunch(plain, "notInstalled")).toBe(true);
  expect(plainLaunch({ ...plain, pane: "w1:p1" }, "notInstalled")).toBe(false);
  expect(plainLaunch({ ...plain, launched: false }, "notInstalled")).toBe(false);
  expect(plainLaunch({ ...plain, mode: "run" }, "notInstalled")).toBe(false);
  // herdr is here, only not running: Start already says how to start it.
  expect(plainLaunch(plain, "notRunning")).toBe(false);
  expect(plainLaunch(plain, "running")).toBe(false);
  expect(plainLaunch(plain, undefined)).toBe(false);
});

it("raises the recommendation once, and never once it has been seen", () => {
  const gate = herdrHintGate();
  expect(gate({ ...plain, pane: "w1:p1" }, "notInstalled", false)).toBe(false);
  expect(gate(plain, "notInstalled", false)).toBe(true);
  // a second plain launch before the seen mark is saved
  expect(gate(plain, "notInstalled", false)).toBe(false);
  expect(gate(plain, "notInstalled", true)).toBe(false);
  expect(herdrHintGate()(plain, "notInstalled", true)).toBe(false);
});
