import { describe, expect, it } from "vitest";
import { isCommitKey } from "../src/lib/keys";

describe("isCommitKey", () => {
  it("commits on a plain Enter", () => {
    expect(isCommitKey({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false } })).toBe(true);
    expect(isCommitKey({ key: "Enter", keyCode: 13, isComposing: false })).toBe(true);
  });

  it("never commits the Enter that picks an IME candidate", () => {
    // React's synthetic event carries the flag on nativeEvent; a DOM event carries it directly
    expect(isCommitKey({ key: "Enter", keyCode: 229, nativeEvent: { isComposing: true } })).toBe(false);
    expect(isCommitKey({ key: "Enter", keyCode: 13, isComposing: true })).toBe(false);
    // the keydown some engines send just as composition ends
    expect(isCommitKey({ key: "Enter", keyCode: 229, nativeEvent: { isComposing: false } })).toBe(false);
  });

  it("ignores other keys", () => {
    expect(isCommitKey({ key: "Escape", keyCode: 27 })).toBe(false);
    expect(isCommitKey({ key: "a", keyCode: 65 })).toBe(false);
  });
});
