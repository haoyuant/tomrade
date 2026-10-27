import { app, BrowserWindow, globalShortcut, type JumpListCategory, type JumpListItem } from "electron";
import type { Context } from "cordis";
import type {} from "@tomradex/code-link";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/settings";
import { errorMessage } from "@tomradex/contracts";
import { DEFAULT_KEYS } from "@tomradex/keybindings/chord";
import { keepInFront } from "./main-window.js";
import type { DesktopWords } from "./words.js";

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

/** A project whose Terminal window was used, and how many cells that window has. */
export interface RecentTerminalWindow {
  projectId: string;
  name: string;
  cells: number;
}

/** The Terminal windows used last, most recent first; none where there is no Terminal window. */
export function recentTerminalWindows(ctx: Context): RecentTerminalWindow[] {
  if (!hasTerminalWindow(ctx)) return [];
  const names = new Map((ctx.get("projects")?.list() ?? []).filter((p) => !p.archived).map((p) => [p.id, p.name]));
  return (ctx.bail("codeLink/terminal-windows") ?? [])
    .flatMap((w) => {
      const name = names.get(w.projectId);
      return name ? [{ projectId: w.projectId, name, cells: w.cells }] : [];
    })
    .slice(0, MAX_PROJECTS);
}

/** "Project · 3 cells", as the Dock and the jump list name a recent Terminal window. */
export const recentLabel = (w: DesktopWords, r: RecentTerminalWindow): string => w(r.cells === 1 ? "terminalWindowCellsOne" : "terminalWindowCellsMany", { name: r.name, n: r.cells });

/** A launch from a jump list task: a project's Terminal window, or the main window. */
export const TERMINAL_FLAG = "--terminal-window";
export const MAIN_FLAG = "--main-window";

/** What a launch's arguments ask for: a Terminal window (`projectId` null for the last one), the main window, or nothing of the kind. */
export function launchAsk(args: string[]): { window: "terminal"; projectId: string | null } | { window: "main" } | null {
  for (const arg of args) {
    if (arg === MAIN_FLAG) return { window: "main" };
    if (arg === TERMINAL_FLAG) return { window: "terminal", projectId: null };
    if (arg.startsWith(`${TERMINAL_FLAG}=`)) return { window: "terminal", projectId: arg.slice(TERMINAL_FLAG.length + 1) || null };
  }
  return null;
}

/**
 * Windows' taskbar jump list, the Dock menu's rows: the recent Terminal windows, then a new Terminal window and a new
 * main window. Each launches the app with a flag the running one hears as a second instance. A row the person removed
 * stays out: Windows drops the whole group otherwise.
 */
export function jumpList(recent: RecentTerminalWindow[], w: DesktopWords, launch: { program: string; args: string[] }, removed: string[]): JumpListCategory[] {
  const task = (title: string, flag: string): JumpListItem => ({ type: "task", title, program: launch.program, args: [...launch.args, flag].join(" "), iconPath: launch.program, iconIndex: 0 });
  const rows = recent.map((r) => task(recentLabel(w, r), `${TERMINAL_FLAG}=${r.projectId}`)).filter((item) => !removed.includes(item.args!));
  return [
    ...(rows.length ? [{ type: "custom" as const, name: w("recentTerminalWindows"), items: rows }] : []),
    { type: "tasks", items: [task(w("newTerminalWindow"), TERMINAL_FLAG), task(w("newMainWindow"), MAIN_FLAG)] }
  ];
}

/**
 * A start's windows, as Settings › Sessions says. With both, the main window leads and the Terminal window comes up
 * behind it; a start whose Terminal window does not open falls back to the main window.
 */
export async function openStartWindows(ctx: Context, opens: { main: boolean; terminal: boolean; projectId?: string | null }, openMain: () => BrowserWindow): Promise<BrowserWindow | null> {
  const main = opens.main ? openMain() : null;
  if (!opens.terminal) return main;
  const release = main ? keepInFront(main) : null;
  const opened = await openTerminal(ctx, opens.projectId ?? null);
  release?.();
  if (!opened && !main) return openMain();
  return main;
}

/** The key that opens the Terminal window inside Tomrade, as the person bound it; null once they took it away. */
export function terminalChord(ctx: Context): string | null {
  const overrides = (ctx.get("settings")?.get().keybindings as { overrides?: Record<string, string[]> } | undefined)?.overrides;
  return (overrides?.terminalWindow ?? DEFAULT_KEYS.terminalWindow)[0] ?? null;
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
