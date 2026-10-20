import { expect, it } from "vitest";
import { keyLabel, windowKey } from "../src/code-sessions/keys";

const press = (key: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}, code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key) => ({
  key,
  code,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift
});

it("reads iTerm2's pane keys and ⌘B on a Mac, and leaves every Ctrl key to the terminal", () => {
  expect(windowKey(press("d", { meta: true }), true)).toBe("splitRight");
  expect(windowKey(press("D", { meta: true, shift: true }), true)).toBe("splitDown");
  expect(windowKey(press("w", { meta: true }), true)).toBe("close");
  expect(windowKey(press("ArrowLeft", { meta: true, alt: true }), true)).toBe("left");
  expect(windowKey(press("ArrowDown", { meta: true, alt: true }), true)).toBe("down");
  expect(windowKey(press("[", { meta: true }, "BracketLeft"), true)).toBe("previous");
  expect(windowKey(press("]", { meta: true }, "BracketRight"), true)).toBe("next");
  // The sidebar folds on ⌘B, as in the app.
  expect(windowKey(press("b", { meta: true }), true)).toBe("fold");
  // The shell's own: Ctrl+D ends input, Ctrl+W deletes a word, Ctrl+B is tmux's, ⌥← moves a word.
  for (const e of [press("d", { ctrl: true }), press("w", { ctrl: true }), press("b", { ctrl: true }), press("ArrowLeft", { alt: true }), press("ArrowLeft", { meta: true }), press("d")]) expect(windowKey(e, true)).toBeNull();
  // An input method composing owns its keys.
  expect(windowKey({ ...press("d", { meta: true }), isComposing: true }, true)).toBeNull();
  // A layout whose D is not a Latin letter still has the key where D is.
  expect(windowKey(press("в", { meta: true }, "KeyD"), true)).toBe("splitRight");
});

it("reads Ctrl+Shift chords and Alt+arrows elsewhere, never a bare Ctrl key", () => {
  expect(windowKey(press("D", { ctrl: true, shift: true }), false)).toBe("splitRight");
  expect(windowKey(press("O", { ctrl: true, shift: true }), false)).toBe("splitDown");
  expect(windowKey(press("W", { ctrl: true, shift: true }), false)).toBe("close");
  expect(windowKey(press("ArrowRight", { alt: true }), false)).toBe("right");
  expect(windowKey(press("Tab", { ctrl: true }), false)).toBe("next");
  expect(windowKey(press("Tab", { ctrl: true, shift: true }), false)).toBe("previous");
  expect(windowKey(press("B", { ctrl: true, shift: true }), false)).toBe("fold");
  for (const e of [press("d", { ctrl: true }), press("w", { ctrl: true }), press("o", { ctrl: true }), press("b", { ctrl: true }), press("Tab"), press("d", { meta: true })]) expect(windowKey(e, false)).toBeNull();
});

it("writes each key the way its platform does", () => {
  expect(keyLabel("splitRight", true)).toBe("⌘D");
  expect(keyLabel("splitDown", true)).toBe("⇧⌘D");
  expect(keyLabel("right", true)).toBe("⌥⌘→");
  expect(keyLabel("splitDown", false)).toBe("Ctrl+Shift+O");
  expect(keyLabel("close", false)).toBe("Ctrl+Shift+W");
  expect(keyLabel("left", false)).toBe("Alt+←");
  expect(keyLabel("fold", true)).toBe("⌘B");
  expect(keyLabel("fold", false)).toBe("Ctrl+Shift+B");
});
