import { expect, it, vi } from "vitest";

const fakeWindow = () => {
  const win = { visible: false, minimized: false, calls: [] as string[] };
  return Object.assign(win, {
    isMinimized: () => win.minimized,
    restore: () => void ((win.minimized = false), win.calls.push("restore")),
    show: () => void ((win.visible = true), win.calls.push("show")),
    moveTop: () => void win.calls.push("moveTop"),
    focus: () => void win.calls.push("focus")
  });
};
type Fake = ReturnType<typeof fakeWindow>;

async function load() {
  vi.resetModules();
  return import("../src/main-window.js");
}

const provider = (lead: Fake | undefined) => {
  const opened: Fake[] = [];
  return {
    opened,
    open: () => {
      const win = fakeWindow();
      opened.push(win);
      lead = win;
      return win as never;
    },
    current: () => lead as never
  };
};

it("answers a launch that came while Tomrade booted once the window is provided, instead of dropping it", async () => {
  const mw = await load();
  mw.askForMainWindow();
  const p = provider(undefined);
  mw.provideMainWindow(p);
  // Started hidden: no window yet, so one opens and comes forward.
  expect(p.opened).toHaveLength(1);
  expect(p.opened[0]!.visible).toBe(true);
  expect(p.opened[0]!.calls).toEqual(["show", "moveTop", "focus"]);
});

it("brings the start's own window forward rather than opening a second", async () => {
  const mw = await load();
  mw.askForMainWindow();
  const own = fakeWindow();
  const p = provider(own);
  mw.provideMainWindow(p);
  expect(p.opened).toHaveLength(0);
  expect(own.calls).toEqual(["show", "moveTop", "focus"]);
});

it("opens a window again after the last one closed, with the app running in the background", async () => {
  const mw = await load();
  const p = provider(undefined);
  mw.provideMainWindow(p);
  expect(p.opened).toHaveLength(0);
  mw.askForMainWindow();
  expect(p.opened).toHaveLength(1);
  expect(p.opened[0]!.visible).toBe(true);
});

it("restores a minimized window before bringing it forward", async () => {
  const mw = await load();
  const win = fakeWindow();
  win.minimized = true;
  mw.provideMainWindow(provider(win));
  mw.askForMainWindow();
  expect(win.calls).toEqual(["restore", "show", "moveTop", "focus"]);
});
