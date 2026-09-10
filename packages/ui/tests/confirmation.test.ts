import { expect, it } from "vitest";
import { confirmationMatches } from "../src/lib/confirmation";

it("accepts the uppercased confirmation shown by the label", () => {
  expect(confirmationMatches("DEFAULT PROJECT", "Default Project")).toBe(true);
});
