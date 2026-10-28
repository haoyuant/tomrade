import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: {} }));
const { anySeen } = await import("../src/seen.js");

const win = (state: { destroyed?: boolean; visible?: boolean; minimized?: boolean }) => ({
  isDestroyed: () => !!state.destroyed,
  isVisible: () => state.visible ?? true,
  isMinimized: () => !!state.minimized
});

it("counts a window as seen while it is shown and not minimized", () => {
  expect(anySeen([])).toBe(false);
  expect(anySeen([win({})])).toBe(true);
  expect(anySeen([win({ minimized: true }), win({ visible: false }), win({ destroyed: true })])).toBe(false);
  expect(anySeen([win({ minimized: true }), win({})])).toBe(true);
});
