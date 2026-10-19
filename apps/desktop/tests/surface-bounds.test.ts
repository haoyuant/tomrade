import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SurfaceBoundsStore, placeWindow } from "../src/surface-bounds.js";

const screenArea = { x: 0, y: 25, width: 1440, height: 875 };

it("remembers where each window was left, by its id, and forgets nothing else when one moves", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-surface-bounds-"));
  try {
    const store = new SurfaceBoundsStore(path.join(dir, "nested", "surface-bounds.json"));
    expect(store.get("demo.win")).toBeNull();
    store.set("demo.win", { x: 100, y: 120, width: 900, height: 600 });
    store.set("other.win", { x: 10, y: 30, width: 500, height: 400 });
    store.set("demo.win", { x: 140, y: 160, width: 1000, height: 640 });
    const again = new SurfaceBoundsStore(path.join(dir, "nested", "surface-bounds.json"));
    expect(again.get("demo.win")).toEqual({ x: 140, y: 160, width: 1000, height: 640 });
    expect(again.get("other.win")).toEqual({ x: 10, y: 30, width: 500, height: 400 });
    fs.writeFileSync(path.join(dir, "nested", "surface-bounds.json"), "not json");
    expect(again.get("demo.win")).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("reopens a window where it was, no smaller than allowed, while it is still on a screen; else centred", () => {
  const size = { width: 900, height: 600, minWidth: 480, minHeight: 320 };
  expect(placeWindow({ x: 200, y: 100, width: 1000, height: 700 }, size, [screenArea])).toEqual({ x: 200, y: 100, width: 1000, height: 700 });
  expect(placeWindow({ x: 200, y: 100, width: 300, height: 200 }, size, [screenArea])).toEqual({ x: 200, y: 100, width: 480, height: 320 });
  // Left on a screen that is no longer attached.
  expect(placeWindow({ x: 3000, y: 100, width: 900, height: 600 }, size, [screenArea])).toEqual({ x: 270, y: 163, width: 900, height: 600 });
  // On the second screen, which is still there.
  expect(placeWindow({ x: 1600, y: 100, width: 900, height: 600 }, size, [screenArea, { x: 1440, y: 0, width: 1920, height: 1080 }])).toEqual({ x: 1600, y: 100, width: 900, height: 600 });
  // Never seen: centred, and no bigger than the screen.
  expect(placeWindow(null, size, [screenArea])).toEqual({ x: 270, y: 163, width: 900, height: 600 });
  expect(placeWindow(null, { width: 2000, height: 1200 }, [screenArea])).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
});
