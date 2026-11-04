import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dock = vi.hoisted(() => ({ setIcon: vi.fn() }));
vi.mock("electron", () => ({ app: { dock } }));

const { appIcon, appIconPath, currentAppIcon, readAppIcon, wearAppIcon, writeAppIcon } = await import("../src/app-icon.js");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-app-icon-"));
  dock.setIcon.mockClear();
  wearAppIcon("transparent");
  dock.setIcon.mockClear();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the app icon preference", () => {
  it("reads the transparent logo when the file is missing, broken, or names an unknown icon", () => {
    const file = path.join(dir, "app-icon.json");
    expect(readAppIcon(file)).toBe("transparent");
    fs.writeFileSync(file, "{not json");
    expect(readAppIcon(file)).toBe("transparent");
    fs.writeFileSync(file, JSON.stringify({ icon: "moon" }));
    expect(readAppIcon(file)).toBe("transparent");
  });

  it("remembers the dawn sun", () => {
    const file = path.join(dir, "nested", "app-icon.json");
    expect(writeAppIcon(file, "sun")).toBe("sun");
    expect(readAppIcon(file)).toBe("sun");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ icon: "sun" });
  });

  it("draws both choices from assets the app ships", () => {
    expect(appIconPath("transparent")).toMatch(/assets[\\/]icon\.png$/);
    expect(appIconPath("sun")).toMatch(/assets[\\/]icon-mac\.png$/);
    expect(fs.existsSync(appIconPath("transparent"))).toBe(true);
    expect(fs.existsSync(appIconPath("sun"))).toBe(true);
  });
});

describe("the app icon row", () => {
  const handlers = new Map<string, (value?: unknown) => unknown>();
  const sent: { channel: string; value: unknown }[] = [];
  const start = (file: string) => {
    appIcon.apply({
      ipc: {
        handle: (channel: string, handler: (value?: unknown) => unknown) => handlers.set(channel, handler),
        send: (channel: string, value: unknown) => sent.push({ channel, value })
      }
    } as never, { file });
  };

  beforeEach(() => {
    handlers.clear();
    sent.length = 0;
  });

  it("starts on the transparent logo, whatever platform", () => {
    const file = path.join(dir, "app-icon.json");
    start(file);
    expect(currentAppIcon()).toBe("transparent");
    expect(handlers.get("appIcon.status")!()).toEqual({ platform: process.platform, icon: "transparent" });
  });

  it("wears a new choice at once, keeps it, and says so", () => {
    const file = path.join(dir, "app-icon.json");
    start(file);
    const status = handlers.get("appIcon.set")!("sun");
    expect(status).toEqual({ platform: process.platform, icon: "sun" });
    expect(readAppIcon(file)).toBe("sun");
    expect(sent).toEqual([{ channel: "appIcon.changed", value: { platform: process.platform, icon: "sun" } }]);
    if (process.platform === "darwin") expect(dock.setIcon).toHaveBeenLastCalledWith(appIconPath("sun"));
  });
});
