import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaded: string[] = [];
vi.mock("electron", () => ({
  app: { getLocale: () => "en-US" },
  BrowserWindow: class {
    destroyed = false;
    isDestroyed() {
      return this.destroyed;
    }
    loadURL(url: string) {
      loaded.push(url);
      return Promise.resolve();
    }
  },
  nativeTheme: { shouldUseDarkColors: false },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  Notification: class {
    static isSupported = () => true;
    show() {}
  }
}));

const { showSplash, splashWaitsForKeyring } = await import("../src/startup.js");

/** The page the splash was told to show, out of its data: URL. */
const page = (url: string) => decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-startup-"));
  loaded.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("showSplash", () => {
  it("draws the icon from the file's own bytes", async () => {
    const png = PNG_1PX;
    const file = path.join(dir, "icon.png");
    fs.writeFileSync(file, png);
    await showSplash({ file, plate: true });
    expect(page(loaded[0])).toContain(`src="data:image/png;base64,${png.toString("base64")}"`);
    expect(page(loaded[0])).toContain("background:#fff");
  });

  it("sets an icon with its own background on no white plate", async () => {
    const file = path.join(dir, "icon.png");
    fs.writeFileSync(file, PNG_1PX);
    await showSplash({ file, plate: false });
    expect(page(loaded[0])).toContain("<img");
    expect(page(loaded[0])).not.toContain("background:#fff");
  });

  it("still opens, saying what it is doing, with no icon to read", async () => {
    await showSplash({ file: path.join(dir, "missing.png"), plate: true });
    const html = page(loaded[0]);
    expect(html).not.toContain("<img");
    expect(html).toContain("Starting Tomrade");
  });

  it("draws no image, and so no plate, when the icon's bytes are not a picture", async () => {
    const file = path.join(dir, "icon.png");
    fs.writeFileSync(file, "");
    await showSplash({ file, plate: true });
    const html = page(loaded[0]);
    expect(html).not.toContain("<img");
    expect(html).toContain("Starting Tomrade");
  });
});

describe("splashWaitsForKeyring", () => {
  it("tells the person to answer the keyring dialog, under the same icon", async () => {
    const file = path.join(dir, "icon.png");
    fs.writeFileSync(file, "");
    const win = await showSplash({ file, plate: true });
    splashWaitsForKeyring(win, { file, plate: true });
    expect(loaded).toHaveLength(2);
    expect(page(loaded[1])).toContain("Answer the system's keyring dialog");
    expect(page(loaded[1])).not.toContain("Starting Tomrade");
  });

  it("leaves a splash that is already gone alone", async () => {
    const win = await showSplash({ file: path.join(dir, "missing.png"), plate: true });
    Object.assign(win, { destroyed: true });
    splashWaitsForKeyring(win, { file: path.join(dir, "missing.png"), plate: true });
    expect(loaded).toHaveLength(1);
  });
});
