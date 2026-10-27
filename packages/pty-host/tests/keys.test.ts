import { expect, it } from "vitest";
import { keyBytes } from "../src/keys.js";

it("writes herdr's logical keys as the bytes a program reads, and knows nothing else", () => {
  expect(keyBytes("enter")).toBe("\r");
  expect(keyBytes("Esc")).toBe("\x1b");
  expect(keyBytes("escape")).toBe("\x1b");
  expect(keyBytes("tab")).toBe("\t");
  expect(keyBytes("shift+tab")).toBe("\x1b[Z");
  expect(keyBytes("ctrl+c")).toBe("\x03");
  expect(keyBytes("CTRL+Z")).toBe("\x1a");
  expect(keyBytes("up")).toBe("\x1b[A");
  expect(keyBytes("y")).toBeNull();
  expect(keyBytes("ctrl+1")).toBeNull();
  expect(keyBytes("")).toBeNull();
});
