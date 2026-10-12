import { app, BrowserWindow, dialog, shell as electronShell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "cordis";
import type {} from "@tomradex/ipc";
import { aboutInfo, type AboutInfo } from "./about.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

declare module "@tomradex/ipc" {
  interface Channels {
    /** Native folder picker. Null when the user cancels. */
    "shell.pickDirectory": (title?: string, buttonLabel?: string) => string | null;
    /** Native picker for several files, or for folders. Null when the user cancels. */
    "shell.pickFiles": (title?: string, buttonLabel?: string, kind?: "files" | "folders") => string[] | null;
    /** Native picker for one program — a CLI the app should run. Null when the user cancels. */
    "shell.pickProgram": (title?: string, buttonLabel?: string) => string | null;
    /** Reveal a path in Finder/Explorer, so a destination can be inspected. */
    "shell.reveal": (target: string) => void;
    /** Open a link in the real browser — the renderer must never navigate away from the app. */
    "shell.openExternal": (url: string) => void;
    /** Which build this is and what it runs on, for the About pane. */
    "shell.about": () => AboutInfo;
    /** Native save dialog, then the text written there — an exported settings file. The chosen path, or null when cancelled. */
    "shell.saveTextFile": (opts: { title?: string; defaultName: string; text: string }) => string | null;
    /** Native open dialog for one text file, read back — a settings file to import. Null when cancelled. */
    "shell.openTextFile": (opts: { title?: string; extensions?: string[] }) => { path: string; text: string } | null;
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

    ctx.ipc.handle("shell.pickProgram", async (title, buttonLabel) => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      // CLIs live in dot-folders (~/.local/bin) that the dialog hides by default.
      const options = {
        title: title ?? "Choose a program",
        properties: ["openFile" as const, "showHiddenFiles" as const],
        buttonLabel: buttonLabel ?? "Choose",
        ...(process.platform === "win32" ? { filters: [{ name: "Programs", extensions: ["exe", "cmd", "bat"] }, { name: "All files", extensions: ["*"] }] } : {})
      };
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    ctx.ipc.handle("shell.reveal", (target) => {
      electronShell.showItemInFolder(target);
    });

    ctx.ipc.handle("shell.openExternal", (url) => {
      // Only ever the web: a file:// or custom scheme from a plugin is not ours to run.
      if (/^https?:\/\//i.test(url)) void electronShell.openExternal(url);
    });

    ctx.ipc.handle("shell.about", () => aboutInfo(repoRoot));

    ctx.ipc.handle("shell.saveTextFile", async ({ title, defaultName, text }) => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const ext = path.extname(defaultName).slice(1);
      const options = {
        title: title ?? "Save",
        defaultPath: path.join(app.getPath("documents"), path.basename(defaultName)),
        ...(ext ? { filters: [{ name: ext.toUpperCase(), extensions: [ext] }] } : {})
      };
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      await fs.writeFile(result.filePath, text, "utf8");
      return result.filePath;
    });

    ctx.ipc.handle("shell.openTextFile", async ({ title, extensions }) => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = {
        title: title ?? "Open",
        properties: ["openFile" as const],
        ...(extensions?.length ? { filters: [{ name: extensions.map((e) => e.toUpperCase()).join(", "), extensions }, { name: "All files", extensions: ["*"] }] } : {})
      };
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const file = result.canceled ? undefined : result.filePaths[0];
      if (!file) return null;
      // A settings file is small; anything big enough to stall the window is not one.
      const stat = await fs.stat(file);
      if (stat.size > 1024 * 1024) throw new Error("That file is too large to be a settings file.");
      return { path: file, text: await fs.readFile(file, "utf8") };
    });
  }
};

export default shell;
