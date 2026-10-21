import { describe, expect, it } from "vitest";
import { isCancelKey } from "../src/lib/keys";

describe("isCancelKey", () => {
  it("cancels on a plain Escape", () => {
    expect(isCancelKey({ key: "Escape", keyCode: 27, nativeEvent: { isComposing: false } })).toBe(true);
    expect(isCancelKey({ key: "Escape", keyCode: 27, isComposing: false })).toBe(true);
  });

  it("never cancels on the Escape that dismisses an IME candidate list", () => {
    // React's synthetic event carries the flag on nativeEvent; a DOM event (Radix's onEscapeKeyDown) carries it directly
    expect(isCancelKey({ key: "Escape", keyCode: 229, nativeEvent: { isComposing: true } })).toBe(false);
    expect(isCancelKey({ key: "Escape", keyCode: 27, isComposing: true })).toBe(false);
    // the keydown some engines send just as composition ends
    expect(isCancelKey({ key: "Escape", keyCode: 229, nativeEvent: { isComposing: false } })).toBe(false);
  });

  it("ignores other keys", () => {
    expect(isCancelKey({ key: "Enter", keyCode: 13 })).toBe(false);
    expect(isCancelKey({ key: "a", keyCode: 65 })).toBe(false);
  });
});
