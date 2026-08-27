import { BrowserWindow, dialog, shell as electronShell } from "electron";
import type { Context } from "cordis";
import type {} from "@tomrade/ipc";

declare module "@tomrade/ipc" {
  interface Channels {
    /** Native folder picker. Null when the user cancels. */
    "shell.pickDirectory": (title?: string) => string | null;
    /** Reveal a path in Finder/Explorer, so a destination can be inspected. */
    "shell.reveal": (target: string) => void;
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
    ctx.ipc.handle("shell.pickDirectory", async (title) => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = {
        title: title ?? "Choose a folder",
        properties: ["openDirectory" as const, "createDirectory" as const],
        buttonLabel: "Choose"
      };
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    ctx.ipc.handle("shell.reveal", (target) => {
      electronShell.showItemInFolder(target);
    });
  }
};

export default shell;
