import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));

const { DESKTOP_NAME, desktopEntry, installDesktopEntry } = await import("../src/desktop-entry.js");

const here = path.dirname(fileURLToPath(import.meta.url));

let dir: string;
let icon: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-desktop-entry-"));
  icon = path.join(dir, "source.png");
  fs.writeFileSync(icon, "png");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the desktop entry", () => {
  it("names the windows' app id and claims the tomrade scheme", () => {
    const text = desktopEntry("/a/Tomrade App.AppImage", "/d/tomrade/icon.png", "tomrade");
    expect(text).toContain('Exec="/a/Tomrade App.AppImage" %U');
    expect(text).toContain("Icon=/d/tomrade/icon.png");
    expect(text).toContain("MimeType=x-scheme-handler/tomrade;");
    expect(text).toContain("StartupWMClass=tomrade");
  });

  it("is the one the packaged app's desktopName points at", () => {
    const builder = fs.readFileSync(path.join(here, "../electron-builder.yml"), "utf8");
    expect(builder.match(/^\s*desktopName:\s*(\S+)\s*$/m)?.[1]).toBe(DESKTOP_NAME);
  });

  it("is written under XDG_DATA_HOME for the AppImage, with the icon copied out of the mount", () => {
    const env = { XDG_DATA_HOME: dir, APPIMAGE: "/a/Tomrade.AppImage" };
    installDesktopEntry("tomrade", icon, env, "/tmp/.mount_x/tomrade");
    const entry = fs.readFileSync(path.join(dir, "applications", DESKTOP_NAME), "utf8");
    expect(entry).toContain('Exec="/a/Tomrade.AppImage" %U');
    expect(entry).toContain(`Icon=${path.join(dir, "tomrade", "icon.png")}`);
    expect(fs.readFileSync(path.join(dir, "tomrade", "icon.png"), "utf8")).toBe("png");
  });

  it("follows a moved AppImage and leaves an entry already in line untouched", () => {
    const env = { XDG_DATA_HOME: dir, APPIMAGE: "/a/Tomrade.AppImage" };
    const file = path.join(dir, "applications", DESKTOP_NAME);
    installDesktopEntry("tomrade", icon, env);
    const past = new Date(2020, 0, 1);
    fs.utimesSync(file, past, past);
    installDesktopEntry("tomrade", icon, env);
    expect(fs.statSync(file).mtime).toEqual(past);
    installDesktopEntry("tomrade", icon, { ...env, APPIMAGE: "/b/Tomrade.AppImage" });
    expect(fs.readFileSync(file, "utf8")).toContain('Exec="/b/Tomrade.AppImage" %U');
  });

  it("points at the executable when the app is not an AppImage", () => {
    installDesktopEntry("tomrade", icon, { XDG_DATA_HOME: dir }, "/opt/Tomrade/tomrade");
    expect(fs.readFileSync(path.join(dir, "applications", DESKTOP_NAME), "utf8")).toContain('Exec="/opt/Tomrade/tomrade" %U');
  });
});
