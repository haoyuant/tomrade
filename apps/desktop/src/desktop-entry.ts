import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "@tomradex/contracts";
import { quoteExec } from "./login-item.js";

/**
 * The entry a Linux desktop matches the app's windows against: on Wayland the
 * window's app id names it, and its Icon is the only icon the Dock, Alt-Tab and
 * the overview can show. Set with app.setDesktopName before ready.
 */
export const DESKTOP_NAME = "tomrade.desktop";

export function desktopEntry(exec: string, icon: string, scheme: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Tomrade",
    "Comment=Tasks, notes and agents, in one folder you own",
    `Exec=${quoteExec(exec)} %U`,
    `Icon=${icon}`,
    "Terminal=false",
    "Categories=Office;",
    // setAsDefaultProtocolClient points xdg-settings at this entry, so it has to claim the scheme.
    `MimeType=x-scheme-handler/${scheme};`,
    `StartupWMClass=${DESKTOP_NAME.replace(/\.desktop$/, "")}`,
    ""
  ].join("\n");
}

/**
 * Writes the entry under XDG_DATA_HOME, pointed at this copy of the app, with
 * the icon copied beside it: an AppImage runs from a mount that is gone once it
 * quits. Each start brings both in line with the copy that runs.
 */
export function installDesktopEntry(scheme: string, iconSource: string, env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): void {
  const data = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const icon = path.join(data, "tomrade", "icon.png");
  const png = fs.readFileSync(iconSource);
  if (!sameBytes(icon, png)) writeFileAtomic(icon, png);
  const file = path.join(data, "applications", DESKTOP_NAME);
  const text = desktopEntry(env.APPIMAGE ?? execPath, icon, scheme);
  if (!sameBytes(file, Buffer.from(text))) writeFileAtomic(file, text);
}

function sameBytes(file: string, bytes: Buffer): boolean {
  try {
    return fs.readFileSync(file).equals(bytes);
  } catch {
    return false;
  }
}
