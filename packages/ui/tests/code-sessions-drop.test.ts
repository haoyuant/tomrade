import { expect, it } from "vitest";
import { droppedPaste, shellEscape } from "../src/code-sessions/drop";

it("escapes a dropped path the way Terminal.app types it, leaving other scripts alone", () => {
  expect(shellEscape("/Users/me/My Shots/a (1).png")).toBe("/Users/me/My\\ Shots/a\\ \\(1\\).png");
  expect(shellEscape("/tmp/it's $HOME & [x]{y}*?!;|<>`\"#~=%^\\")).toBe("/tmp/it\\'s\\ \\$HOME\\ \\&\\ \\[x\\]\\{y\\}\\*\\?\\!\\;\\|\\<\\>\\`\\\"\\#\\~\\=\\%\\^\\\\");
  expect(shellEscape("/Users/me/截图 1.png")).toBe("/Users/me/截图\\ 1.png");
});

it("types the dropped files as one bracketed paste, a space apart and one after, skipping files without a path", () => {
  expect(droppedPaste(["/tmp/a b.png", "", "/tmp/c"])).toBe("\x1b[200~/tmp/a\\ b.png /tmp/c \x1b[201~");
  expect(droppedPaste(["", ""])).toBeNull();
  expect(droppedPaste([])).toBeNull();
});
