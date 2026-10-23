import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaded: string[] = [];
vi.mock("electron", () => ({
  app: { getLocale: () => "en-US" },
  BrowserWindow: class {
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

const { showSplash } = await import("../src/startup.js");

/** The page the splash was told to show, out of its data: URL. */
const page = (url: string) => decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-startup-"));
  loaded.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("showSplash", () => {
  it("draws the icon from the file's own bytes", () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64"
    );
    const file = path.join(dir, "icon.png");
    fs.writeFileSync(file, png);
    showSplash(file);
    expect(page(loaded[0])).toContain(`src="data:image/png;base64,${png.toString("base64")}"`);
  });

  it("still opens, saying what it is doing, with no icon to read", () => {
    showSplash(path.join(dir, "missing.png"));
    const html = page(loaded[0]);
    expect(html).not.toContain("<img");
    expect(html).toContain("Starting Tomrade");
  });
});
