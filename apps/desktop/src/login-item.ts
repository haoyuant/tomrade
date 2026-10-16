import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

/** What starts the background part instead of the whole app: no window, no Dock icon. */
export const BACKGROUND_FLAG = "--background";

/** The LaunchAgent the macOS build carries in Contents/Library/LaunchAgents (assets/launch-agent). */
export const MAC_AGENT_PLIST = "com.tomrade.desktop.background.plist";

/**
 * The system's word on starting at login, which outranks ours: the person can
 * switch it off in System Settings, Task Manager or their desktop's startup
 * list. `approval` is macOS waiting for "Allow in the Background"; `disabled`
 * is an entry still there but switched off outside Tomrade.
 */
export type LoginState =
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "approval" }
  | { kind: "disabled" }
  | { kind: "unavailable"; reason: "checkout" | "location" | "unsupported" };

export interface LoginItem {
  state(): LoginState;
  set(on: boolean): void;
  /**
   * Bring an entry made earlier in line with this copy of the app — a moved
   * AppImage, an install in a new place. False when the entry is gone: removed
   * outside Tomrade, which is the person's answer and is not undone here.
   */
  repair(): boolean;
  /** macOS 12 has no agent service; its login item opens the app, which asks here whether that is what happened. */
  openedAtLogin(): boolean;
}

/** Darwin 22 is macOS 13, the first with SMAppService. */
const modernMac = () => Number(os.release().split(".")[0]) >= 22;

function macAgent(): LoginItem {
  const service = { type: "agentService", serviceName: MAC_AGENT_PLIST } as const;
  const item: LoginItem = {
    state() {
      const status = app.getLoginItemSettings(service).status;
      if (status === "enabled") return { kind: "on" };
      if (status === "requires-approval") return { kind: "approval" };
      // The plist is missing from the bundle: a build made without it.
      if (status === "not-found") return { kind: "unavailable", reason: "unsupported" };
      return { kind: "off" };
    },
    set(on) {
      app.setLoginItemSettings({ ...service, openAtLogin: on });
    },
    // Registering is the app's to do and approving the person's, so a lost registration comes back without overriding them.
    repair() {
      if (item.state().kind === "off") item.set(true);
      return true;
    },
    openedAtLogin: () => false
  };
  return item;
}

function macLegacy(): LoginItem {
  return {
    state: () => ({ kind: app.getLoginItemSettings().openAtLogin ? "on" : "off" }),
    set: (on) => app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true }),
    repair: () => app.getLoginItemSettings().openAtLogin,
    openedAtLogin: () => app.getLoginItemSettings().wasOpenedAtLogin === true
  };
}

function windowsRun(): LoginItem {
  const query = { path: process.execPath, args: [BACKGROUND_FLAG] };
  const item: LoginItem = {
    state() {
      const s = app.getLoginItemSettings(query);
      if (!s.openAtLogin) return { kind: "off" };
      // Switched off in Task Manager's Startup apps: the Run entry stays, the approval goes.
      return { kind: s.executableWillLaunchAtLogin ? "on" : "disabled" };
    },
    set(on) {
      app.setLoginItemSettings({ ...query, openAtLogin: on });
    },
    repair() {
      const s = app.getLoginItemSettings(query);
      if (s.openAtLogin) return true;
      const earlier = s.launchItems[0];
      if (!earlier) return false;
      // Pointed at this executable again, keeping whatever Task Manager says about it.
      app.setLoginItemSettings({ ...query, openAtLogin: true, enabled: earlier.enabled });
      return true;
    },
    openedAtLogin: () => false
  };
  return item;
}

/** Quoted for a desktop entry's Exec key, which reserves these four inside quotes. */
const quoteExec = (file: string) => `"${file.replace(/(["`$\\])/g, "\\$1")}"`;

export function autostartEntry(exec: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Tomrade",
    "Comment=Tomrade in the background: the MCP server, routines and sync",
    `Exec=${quoteExec(exec)} ${BACKGROUND_FLAG}`,
    "Terminal=false",
    "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true",
    ""
  ].join("\n");
}

/** The entry pointed at `exec`, every other line — a switch the desktop wrote into it included — kept. */
export function withExec(text: string, exec: string): string {
  const line = `Exec=${quoteExec(exec)} ${BACKGROUND_FLAG}`;
  return /^Exec=.*$/m.test(text) ? text.replace(/^Exec=.*$/m, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
}

export function autostartState(text: string | null): LoginState {
  if (text === null) return { kind: "off" };
  if (/^Hidden\s*=\s*true\s*$/im.test(text) || /^X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(text)) return { kind: "disabled" };
  return { kind: "on" };
}

/** XDG autostart: Electron registers no login items on Linux. */
export function xdgAutostart(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): LoginItem {
  const file = path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart", "tomrade-background.desktop");
  // An AppImage runs from a temporary mount; APPIMAGE is the file the person keeps.
  const exec = env.APPIMAGE ?? execPath;
  const read = () => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  const write = (text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    state: () => autostartState(read()),
    set: (on) => (on ? write(autostartEntry(exec)) : fs.rmSync(file, { force: true })),
    repair() {
      const text = read();
      if (text === null) return false;
      const next = withExec(text, exec);
      if (next !== text) write(next);
      return true;
    },
    openedAtLogin: () => false
  };
}

function unavailable(reason: "checkout" | "location" | "unsupported"): LoginItem {
  return { state: () => ({ kind: "unavailable", reason }), set: () => {}, repair: () => false, openedAtLogin: () => false };
}

/** This machine's way of starting the background part at login. */
export function loginItem(): LoginItem {
  // A checkout runs Electron from node_modules on code that is rebuilt under it.
  if (!app.isPackaged) return unavailable("checkout");
  if (process.platform === "darwin") {
    // A copy run from a download or a mounted image moves, and the entry would point nowhere.
    if (!app.isInApplicationsFolder()) return unavailable("location");
    return modernMac() ? macAgent() : macLegacy();
  }
  if (process.platform === "win32") return windowsRun();
  if (process.platform === "linux") return xdgAutostart();
  return unavailable("unsupported");
}
