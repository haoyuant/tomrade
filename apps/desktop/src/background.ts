import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, Menu, nativeImage, Notification, shell as electronShell, Tray } from "electron";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/settings";
import { BACKGROUND_FLAG, loginItem, type LoginItem, type LoginState } from "./login-item.js";
import { hasMainWindow, showMainWindow } from "./main-window.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Beside the machine's app data, not an account's: starting at login belongs to the machine, and to every account on it. */
export const PREFS_FILE = "background.json";

const Prefs = z.object({
  /** Closing the last window leaves the background part running. */
  keepRunning: z.boolean().default(false),
  /** The person asked for the background part at login; the system has the last word (LoginState). */
  startAtLogin: z.boolean().default(false),
  /** The one-time "still running" notification was shown. */
  noticed: z.boolean().default(false)
});
type Prefs = z.infer<typeof Prefs>;

export function readPrefs(file: string): Prefs {
  try {
    return Prefs.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return Prefs.parse({});
  }
}

export function writePrefs(file: string, patch: Partial<Prefs>): Prefs {
  const next = { ...readPrefs(file), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(`${file}.tmp`, file);
  return next;
}

export interface BackgroundStatus {
  platform: NodeJS.Platform;
  keepRunning: boolean;
  startAtLogin: boolean;
  login: LoginState;
  /** The last change the system refused, said once. */
  error?: string;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "background.status": () => BackgroundStatus;
    /** Starting at login needs keepRunning; switching keepRunning off takes it away too. */
    "background.set": (patch: { keepRunning?: boolean; startAtLogin?: boolean }) => BackgroundStatus;
    /** Where this system lets the person approve or switch off what starts at login. */
    "background.openLoginSettings": () => void;
  }
  interface Broadcasts {
    "background.changed": (status: BackgroundStatus) => void;
  }
}

/**
 * How this start should come up: with a window, hidden as the background
 * part, or not at all — a login entry left behind after the person switched
 * background running off.
 */
export function launchMode(argv: string[], file: string, login: Pick<LoginItem, "openedAtLogin">): "window" | "hidden" | "stale" {
  if (!argv.includes(BACKGROUND_FLAG) && !login.openedAtLogin()) return "window";
  return readPrefs(file).keepRunning ? "hidden" : "stale";
}

/** The arguments a restart starts with: hidden only when no window is open to come back to. */
export function relaunchArgs(argv = process.argv.slice(1)): string[] {
  const rest = argv.filter((arg) => arg !== BACKGROUND_FLAG);
  return keepsRunning() && !hasMainWindow() ? [...rest, BACKGROUND_FLAG] : rest;
}

// Shared with main.ts, which imports this module by the same URL the row loads it from.
let current: Prefs | null = null;
let onAway: (() => void) | null = null;

/** Closing the last window leaves the process up. False whenever the row is switched off. */
export const keepsRunning = (): boolean => current?.keepRunning === true;

/** Called by main.ts once the last window has closed and the process stays. */
export function wentAway(): void {
  if (process.platform === "darwin") app.dock?.hide();
  onAway?.();
}

/** Called by main.ts as a window opens: the app is an ordinary one again. */
export function cameBack(): void {
  if (process.platform === "darwin") void app.dock?.show();
}

function trayImage() {
  const assets = path.join(here, "../assets");
  if (process.platform === "darwin") {
    // The @2x beside it is picked up by name; a template follows the menu bar's light or dark.
    const image = nativeImage.createFromPath(path.join(assets, "trayTemplate.png"));
    image.setTemplateImage(true);
    return image;
  }
  return nativeImage.createFromPath(path.join(assets, "tray.png"));
}

const LOGIN_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
  win32: "ms-settings:startupapps"
};

/**
 * The background part: whether closing the last window leaves Tomrade
 * running, whether it starts at login, and the tray icon that shows it is
 * there. Without this row neither happens, whatever the file says.
 */
export const background = {
  name: "background",
  inject: ["ipc"],
  apply(ctx: Context, config: { file: string }) {
    const file = config.file;
    const login = loginItem();
    const log = ctx.logger("background");
    const zh = () => ctx.get("settings")?.locale?.() === "zh";
    let error: string | undefined;

    const save = (patch: Partial<Prefs>) => {
      current = writePrefs(file, patch);
      return current;
    };
    const register = (on: boolean): boolean => {
      try {
        login.set(on);
        return true;
      } catch (e) {
        // A system that refuses is said in the pane, never thrown at the person.
        error = e instanceof Error ? e.message : String(e);
        log.warn(`login item ${on ? "registration" : "removal"} failed: ${error}`);
        return false;
      }
    };

    current = readPrefs(file);
    // Starting at login rests on background running; a file edited into the other state loses it.
    if (current.startAtLogin && !current.keepRunning) {
      register(false);
      save({ startAtLogin: false });
    } else if (current.startAtLogin) {
      try {
        if (!login.repair()) save({ startAtLogin: false });
      } catch (e) {
        log.warn(`login item check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const status = (): BackgroundStatus => {
      const prefs = current ?? readPrefs(file);
      let state: LoginState;
      try {
        state = login.state();
      } catch {
        state = { kind: "unavailable", reason: "unsupported" };
      }
      const said = error;
      error = undefined;
      return { platform: process.platform, keepRunning: prefs.keepRunning, startAtLogin: prefs.startAtLogin, login: state, ...(said ? { error: said } : {}) };
    };

    let tray: Tray | null = null;
    const menu = () => {
      const mcp = ctx.get("mcp")?.url ?? null;
      const runs = ctx.get("agent")?.activeRuns().length ?? 0;
      const cn = zh();
      return Menu.buildFromTemplate([
        { label: cn ? "打开 Tomrade" : "Open Tomrade", click: () => void showMainWindow() },
        { type: "separator" },
        { label: mcp ? `MCP: ${mcp.replace(/^https?:\/\//, "")}` : cn ? "MCP 未运行" : "MCP not running", enabled: false },
        { label: cn ? `运行中的智能体：${runs}` : `${runs} agent run${runs === 1 ? "" : "s"} in progress`, enabled: false },
        { type: "separator" },
        { label: cn ? "退出 Tomrade" : "Quit Tomrade", click: () => app.quit() }
      ]);
    };
    const refreshTray = () => tray?.setContextMenu(menu());
    const syncTray = () => {
      if (keepsRunning() && !tray) {
        tray = new Tray(trayImage());
        tray.setToolTip("Tomrade");
        // macOS and Linux open the menu on a click; Windows keeps it for the right button.
        if (process.platform === "win32") tray.on("click", () => void showMainWindow());
        refreshTray();
      } else if (!keepsRunning() && tray) {
        tray.destroy();
        tray = null;
      }
    };
    syncTray();
    ctx.on("agent/run-ended", refreshTray);
    ctx.on("agent/event", (_threadId, event) => {
      if (event.type === "done") refreshTray();
    });
    // A run that starts has no event of its own here; the count catches up within a few seconds.
    const sweep = setInterval(refreshTray, 5_000);

    onAway = () => {
      if (current?.noticed || !Notification.isSupported()) return;
      save({ noticed: true });
      const cn = zh();
      const where = process.platform === "darwin" ? (cn ? "菜单栏" : "menu bar") : cn ? "系统托盘" : "system tray";
      new Notification({
        title: cn ? "Tomrade 仍在后台运行" : "Tomrade is still running",
        body: cn
          ? `MCP 服务、例行任务和同步会继续工作。可以从${where}图标打开或退出 Tomrade。`
          : `The MCP server, routines and sync keep working. Open or quit Tomrade from its ${where} icon.`
      }).show();
    };

    const changed = () => {
      const next = status();
      ctx.ipc.send("background.changed", next);
      return next;
    };

    ctx.ipc.handle("background.status", () => status());
    ctx.ipc.handle("background.set", (patch) => {
      const prefs = current ?? readPrefs(file);
      if (patch.keepRunning === false) {
        if (prefs.startAtLogin) register(false);
        save({ keepRunning: false, startAtLogin: false });
      } else if (patch.keepRunning === true) {
        save({ keepRunning: true });
      }
      if (patch.startAtLogin !== undefined && patch.keepRunning !== false) {
        const on = patch.startAtLogin && (current?.keepRunning ?? false);
        // Where the system offers no login item the pane already says why; nothing to register.
        if (!(on && login.state().kind === "unavailable") && register(on)) save({ startAtLogin: on });
      }
      syncTray();
      return changed();
    });
    ctx.ipc.handle("background.openLoginSettings", () => {
      const target = LOGIN_SETTINGS[process.platform];
      if (target) void electronShell.openExternal(target);
    });

    ctx.effect(
      () => () => {
        clearInterval(sweep);
        tray?.destroy();
        tray = null;
        current = null;
        onAway = null;
      },
      "background"
    );
  }
};

export default background;
