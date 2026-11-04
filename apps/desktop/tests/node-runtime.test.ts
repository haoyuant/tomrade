import path from "node:path";
import { describe, expect, it } from "vitest";
import { nodeRuntime } from "../src/node-runtime.js";

describe("the binary that runs Node for child processes", () => {
  it("is the app's Helper on macOS, so a child does not show in the Dock", () => {
    const seen: string[] = [];
    const exists = (file: string) => (seen.push(file), true);
    expect(nodeRuntime("/Applications/Tomrade.app/Contents/MacOS/Tomrade", "darwin", exists)).toBe(path.normalize("/Applications/Tomrade.app/Contents/Frameworks/Tomrade Helper.app/Contents/MacOS/Tomrade Helper"));
    expect(nodeRuntime("/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "darwin", exists)).toBe(path.normalize("/x/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"));
    expect(seen).toHaveLength(2);
  });

  it("stays the running binary when there is no Helper beside it", () => {
    expect(nodeRuntime("/opt/homebrew/bin/node", "darwin", () => false)).toBe("/opt/homebrew/bin/node");
  });

  it("stays the running binary on other platforms", () => {
    const exists = () => { throw new Error("not looked for"); };
    expect(nodeRuntime("C:\\Program Files\\Tomrade\\Tomrade.exe", "win32", exists)).toBe("C:\\Program Files\\Tomrade\\Tomrade.exe");
    expect(nodeRuntime("/opt/Tomrade/tomrade", "linux", exists)).toBe("/opt/Tomrade/tomrade");
  });
});
