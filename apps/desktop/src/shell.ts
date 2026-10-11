import { BrowserWindow, dialog, shell as electronShell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "cordis";
import type {} from "@tomradex/ipc";
import { aboutInfo, checkForUpdate, type AboutInfo, type UpdateCheck } from "./about.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

declare module "@tomradex/ipc" {
  interface Channels {
    /** Native folder picker. Null when the user cancels. */
    "shell.pickDirectory": (title?: string, buttonLabel?: string) => string | null;
    /** Native picker for several files, or for folders. Null when the user cancels. */
    "shell.pickFiles": (title?: string, buttonLabel?: string, kind?: "files" | "folders") => string[] | null;
    /** Reveal a path in Finder/Explorer, so a destination can be inspected. */
    "shell.reveal": (target: string) => void;
    /** Open a link in the real browser — the renderer must never navigate away from the app. */
    "shell.openExternal": (url: string) => void;
    /** Which build this is and what it runs on, for the About pane. */
    "shell.about": () => AboutInfo;
    /** Asks the download host for the latest release. Throws when it cannot be reached. */
    "shell.checkForUpdate": () => UpdateCheck;
  }
}

/**
 * The few things only the shell can do. Kept out of the plugin packages because
 * a native dialog is a desktop concern, not a backlog one.
 */
export const shell = {
  name: "shell",
  inject: ["ipc"],
  apply(ctx: Context) {
    ctx.ipc.handle("shell.pickDirectory", async (title, buttonLabel) => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = {
        title: title ?? "Choose a folder",
        properties: ["openDirectory" as const, "createDirectory" as const],
        buttonLabel: buttonLabel ?? "Choose"
      };
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    ctx.ipc.handle("shell.pickFiles", async (title, buttonLabel, kind = "files") => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      // One kind per dialog: Windows and Linux cannot pick files and folders together.
      const options = {
        title: title ?? (kind === "folders" ? "Choose folders" : "Choose files"),
        properties: kind === "folders" ? ["openDirectory" as const, "multiSelections" as const] : ["openFile" as const, "multiSelections" as const],
        buttonLabel: buttonLabel ?? "Add"
      };
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths;
    });

    ctx.ipc.handle("shell.reveal", (target) => {
      electronShell.showItemInFolder(target);
    });

    ctx.ipc.handle("shell.openExternal", (url) => {
      // Only ever the web: a file:// or custom scheme from a plugin is not ours to run.
      if (/^https?:\/\//i.test(url)) void electronShell.openExternal(url);
    });

    ctx.ipc.handle("shell.about", () => aboutInfo(repoRoot));
    ctx.ipc.handle("shell.checkForUpdate", () => checkForUpdate());
  }
};

export default shell;
