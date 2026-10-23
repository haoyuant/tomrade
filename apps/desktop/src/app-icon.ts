import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/ipc";
import { writeJsonAtomic } from "@tomradex/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The app icons a person may wear: the transparent logo, and the cat on the dawn sun. */
const APP_ICONS = ["transparent", "sun"] as const;
export type AppIcon = (typeof APP_ICONS)[number];

/** The image each choice draws from; the sun is the icon TOM-512 made for macOS. */
const ICON_FILES: Record<AppIcon, string> = {
  transparent: "icon.png",
  sun: "icon-mac.png"
};

/** Beside background.json in the machine's app data: the icon this machine wears. */
export const APP_ICON_FILE = "app-icon.json";

const Prefs = z.object({ icon: z.enum(APP_ICONS).default("transparent") });

/** A file written before this choice existed, or one edited by hand, reads as the transparent logo. */
export function readAppIcon(file: string): AppIcon {
  try {
    return Prefs.parse(JSON.parse(fs.readFileSync(file, "utf8"))).icon;
  } catch {
    return "transparent";
  }
}

export function writeAppIcon(file: string, icon: AppIcon): AppIcon {
  writeJsonAtomic(file, { icon });
  return icon;
}

export function appIconPath(icon: AppIcon): string {
  return path.join(here, "../assets", ICON_FILES[icon]);
}

// What the app wears now, so whatever draws the Dock outside this plugin — a Dock
// shown again after background running — draws the chosen icon, not a fixed one.
let current: AppIcon = "transparent";

export const currentAppIcon = (): AppIcon => current;

/** The Dock wears this icon; a choice made in Settings shows at once. */
export function wearAppIcon(icon: AppIcon): void {
  current = icon;
  if (process.platform === "darwin") app.dock?.setIcon(appIconPath(icon));
}

export interface AppIconStatus {
  platform: NodeJS.Platform;
  icon: AppIcon;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "appIcon.status": () => AppIconStatus;
    "appIcon.set": (icon: AppIcon) => AppIconStatus;
  }
  interface Broadcasts {
    "appIcon.changed": (status: AppIconStatus) => void;
  }
}

/**
 * The app icon: the transparent logo Tomrade wore before TOM-512, or the cat on
 * the dawn sun. Kept beside the machine's other preferences, and read by main.ts
 * before boot so the Dock wears it from the start.
 */
export const appIcon = {
  name: "appIcon",
  inject: ["ipc"],
  apply(ctx: Context, config: { file: string }) {
    const file = config.file;
    current = readAppIcon(file);
    const status = (): AppIconStatus => ({ platform: process.platform, icon: current });

    ctx.ipc.handle("appIcon.status", () => status());
    ctx.ipc.handle("appIcon.set", (icon) => {
      wearAppIcon(writeAppIcon(file, icon));
      const next = status();
      ctx.ipc.send("appIcon.changed", next);
      return next;
    });
  }
};

