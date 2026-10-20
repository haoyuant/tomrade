import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { droppedPaste, heldForDrop, readableDrops, shellEscape } from "../src/drop.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-drop-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

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

it("knows a screenshot's thumbnail by the temp folder's TemporaryItems, under either spelling of /var", () => {
  const tmp = "/var/folders/9t/xyz/T";
  expect(heldForDrop(`${tmp}/TemporaryItems/NSIRD_screencaptureui_Ab12/Screenshot 2026-10-20 at 16.05.00.png`, tmp)).toBe(true);
  expect(heldForDrop(`/private${tmp}/TemporaryItems/NSIRD_screencaptureui_Ab12/Screenshot.png`, `${tmp}/`)).toBe(true);
  expect(heldForDrop(`${tmp}/TemporaryItems`, tmp)).toBe(false);
  expect(heldForDrop(`${tmp}/other/TemporaryItems/a.png`, tmp)).toBe(false);
  expect(heldForDrop("/Users/me/Desktop/Screenshot.png", tmp)).toBe(false);
});

it("copies what only Tomrade may read where the terminal can, under its own name, and leaves every other path alone", async () => {
  const tmp = path.join(dir, "T");
  const held = path.join(tmp, "TemporaryItems", "NSIRD_screencaptureui_Ab12");
  fs.mkdirSync(path.join(held, "folder"), { recursive: true });
  fs.writeFileSync(path.join(held, "Screenshot 1.png"), "png");
  fs.writeFileSync(path.join(held, "folder", "inner.txt"), "inner");
  const elsewhere = path.join(dir, "mine.png");
  const into = path.join(dir, "drops");

  const [shot, folder, own, none, gone] = await readableDrops([path.join(held, "Screenshot 1.png"), path.join(held, "folder"), elsewhere, "", path.join(held, "gone.png")], into, tmp);
  expect(path.basename(shot!)).toBe("Screenshot 1.png");
  expect(path.dirname(path.dirname(shot!))).toBe(into);
  expect(fs.readFileSync(shot!, "utf8")).toBe("png");
  expect(fs.readFileSync(path.join(folder!, "inner.txt"), "utf8")).toBe("inner");
  expect(path.dirname(shot!)).not.toBe(path.dirname(folder!));
  expect([own, none]).toEqual([elsewhere, ""]);
  // One that cannot be copied is typed as it is.
  expect(gone).toBe(path.join(held, "gone.png"));
});
