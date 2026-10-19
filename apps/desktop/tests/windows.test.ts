import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: {}, ipcMain: {}, screen: {} }));
import { placeTabWindow } from "../src/windows.js";

const laptop = { x: 0, y: 25, width: 1440, height: 875 };
const monitor = { x: 1440, y: 0, width: 2560, height: 1415 };
const mainWindow = { x: 0, y: 25, width: 1440, height: 875 };

it("drops a dragged-out tab's window under the pointer, at the size last used, kept on that screen", () => {
  const saved = { x: 1600, y: 100, width: 1000, height: 700, maximized: true };
  expect(placeTabWindow({ saved, at: { x: 2000, y: 400 }, from: mainWindow, areas: [laptop, monitor], taken: [] })).toEqual({ x: 1880, y: 384, width: 1000, height: 700 });
  // let go near the right edge: the window stays whole on that screen
  expect(placeTabWindow({ saved: null, at: { x: 1430, y: 880 }, from: mainWindow, areas: [laptop, monitor], taken: [] })).toEqual({ x: 240, y: 80, width: 1200, height: 820 });
});

it("reopens where the last one was left, filled again if it was, while that place is still on a screen", () => {
  const saved = { x: 1700, y: 120, width: 1100, height: 800, maximized: true };
  expect(placeTabWindow({ saved, from: mainWindow, areas: [laptop, monitor], taken: [] })).toEqual(saved);
  // the monitor is gone: the first-time rule decides, and on one screen that is beside the main window
  expect(placeTabWindow({ saved, from: mainWindow, areas: [laptop], taken: [] })).toEqual({ x: 56, y: 53, width: 1100, height: 800 });
});

it("steps a new window down and right off the ones already standing in that place, never filling over them", () => {
  const saved = { x: 1700, y: 120, width: 1100, height: 800, maximized: true };
  const first = { x: 1700, y: 120, width: 1100, height: 800 };
  expect(placeTabWindow({ saved, from: mainWindow, areas: [laptop, monitor], taken: [first] })).toEqual({ x: 1728, y: 148, width: 1100, height: 800 });
  expect(placeTabWindow({ saved, from: mainWindow, areas: [laptop, monitor], taken: [first, { ...first, x: 1728, y: 148 }] })).toEqual({ x: 1756, y: 176, width: 1100, height: 800 });
});

it("the first time, fills another screen than the one the tab came from; with one screen, opens beside its window", () => {
  expect(placeTabWindow({ saved: null, from: mainWindow, areas: [laptop, monitor], taken: [] })).toEqual({ x: 2120, y: 298, width: 1200, height: 820, maximized: true });
  // from a window on the monitor, the laptop is the other screen
  expect(placeTabWindow({ saved: null, from: { x: 1500, y: 40, width: 1600, height: 1000 }, areas: [laptop, monitor], taken: [] })).toEqual({ x: 120, y: 53, width: 1200, height: 820, maximized: true });
  expect(placeTabWindow({ saved: null, from: { x: 100, y: 60, width: 1000, height: 700 }, areas: [laptop], taken: [] })).toEqual({ x: 156, y: 80, width: 1200, height: 820 });
});
