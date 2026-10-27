import { app, BrowserWindow, globalShortcut, type MenuItemConstructorOptions } from "electron";
import type { Context } from "cordis";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/settings";
import { errorMessage } from "@tomradex/contracts";

/** The Terminal window's own command: it opens the project's window, or brings it forward when it is open. */
export const TERMINAL_COMMAND = "code-sessions.open";
const MAX_PROJECTS = 6;

/** Whether this app has a Terminal window at all: the plugin that draws it registered its command. */
export function hasTerminalWindow(ctx: Context): boolean {
  return !!ctx.get("contributions")?.commands().some((c) => c.id === TERMINAL_COMMAND);
}

/** The projects a menu offers a Terminal window for: those on this machine, most recently changed first. */
export function terminalProjects(ctx: Context): { id: string; name: string }[] {
  const projects = ctx.get("projects")?.list() ?? [];
  return projects
    .filter((p) => !p.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_PROJECTS)
    .map((p) => ({ id: p.id, name: p.name }));
}

/** null asks for the project the window showed last. False when no window opened: the command failed or had nothing to open. */
export async function openTerminal(ctx: Context, projectId: string | null): Promise<boolean> {
  const contributions = ctx.get("contributions");
  if (!contributions) return false;
  try {
    const result = await contributions.run(TERMINAL_COMMAND, projectId ? { projectId } : {});
    return !result.toast;
  } catch (e) {
    ctx.logger("terminal-entries").warn(`terminal window did not open: ${errorMessage(e)}`);
    return false;
  }
}

/** One "Terminal window · Project" row per project; none where there is no Terminal window. */
export function terminalMenuItems(ctx: Context, label: (name: string) => string): MenuItemConstructorOptions[] {
  if (!hasTerminalWindow(ctx)) return [];
  return terminalProjects(ctx).map((p) => ({ label: label(p.name), click: () => void openTerminal(ctx, p.id) }));
}

const GLOBAL_COMMAND = "terminalWindowGlobal";
const KEY_NAMES: Record<string, string> = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Esc", Enter: "Return" };

/** A chord as the renderer writes it ("Mod+Alt+Space"), as Electron's accelerators do ("CommandOrControl+Alt+Space"). */
export function accelerator(chord: string): string {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((m) => (m === "Mod" ? "CommandOrControl" : m === "Ctrl" ? "Control" : m));
  return [...mods, KEY_NAMES[key] ?? key].join("+");
}

interface GlobalKeyStatus {
  command: string;
  chord: string;
  registered: boolean;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "keybindings.globalStatus": () => GlobalKeyStatus[];
  }
  interface Broadcasts {
    "keybindings.globalStatusChanged": (status: GlobalKeyStatus[]) => void;
  }
}

/**
 * The key the person gave the whole computer (Settings › Keyboard shortcuts, "From any app"; none by default):
 * pressed anywhere it brings the Terminal window up, pressed in it it puts Tomrade away. Registered only while
 * one is set, and released when it changes and when Tomrade quits.
 */
export function installGlobalHotkey(ctx: Context): void {
  let held: { chord: string; accelerator: string; registered: boolean } | null = null;
  const chosen = (): string | null => {
    const overrides = (ctx.get("settings")?.get().keybindings as { overrides?: Record<string, string[]> } | undefined)?.overrides;
    return overrides?.[GLOBAL_COMMAND]?.[0] ?? null;
  };
  const fire = () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed() && focused.webContents.getURL().includes("code-sessions")) {
      if (process.platform === "darwin") app.hide();
      else focused.minimize();
      return;
    }
    // from another app, the window alone can come up behind it
    if (process.platform === "darwin") app.focus({ steal: true });
    void openTerminal(ctx, null);
  };
  const status = (): GlobalKeyStatus[] => (held ? [{ command: GLOBAL_COMMAND, chord: held.chord, registered: held.registered }] : []);
  const release = () => {
    if (held?.registered) globalShortcut.unregister(held.accelerator);
    held = null;
  };
  const sync = () => {
    const chord = chosen();
    if (chord === (held?.chord ?? null)) return;
    release();
    if (chord) {
      const acc = accelerator(chord);
      let registered = false;
      try {
        registered = globalShortcut.register(acc, fire);
      } catch (e) {
        ctx.logger("terminal-entries").warn(`global key ${acc} not taken: ${errorMessage(e)}`);
      }
      held = { chord, accelerator: acc, registered };
    }
    ctx.get("ipc")?.send("keybindings.globalStatusChanged", status());
  };
  ctx.get("ipc")?.handle("keybindings.globalStatus", () => status());
  sync();
  ctx.on("settings/changed", sync);
  app.on("will-quit", release);
}
