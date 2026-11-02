import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { followEnd, type EndBox } from "../src/lib/followEnd";

// No layout here: a view is its numbers, and the observers are called by hand as the browser would.
let resized: (() => void)[] = [];
let mutated: (() => void)[] = [];
beforeEach(() => {
  resized = [];
  mutated = [];
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { resized.push(cb); } observe() {} disconnect() {} });
  vi.stubGlobal("MutationObserver", class { constructor(cb: () => void) { mutated.push(cb); } observe() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

const view = () => {
  const box = { scrollTop: 0, scrollHeight: 400, clientHeight: 400, children: [] as Element[] };
  // the browser keeps scrollTop inside what can be scrolled
  return new Proxy(box, {
    set(target, key, value) {
      if (key === "scrollTop") target.scrollTop = Math.max(0, Math.min(value as number, target.scrollHeight - target.clientHeight));
      else Reflect.set(target, key, value);
      return true;
    }
  }) as EndBox & { scrollHeight: number; children: Element[] };
};

it("lands at the end when the conversation arrives after it opened, and again as its lines are laid out late", () => {
  const el = view();
  const following = { current: true };
  followEnd(el, following).place();
  expect(el.scrollTop).toBe(0);

  // the record read came in: its lines go in, at a guessed height
  el.children.push({} as Element);
  el.scrollHeight = 2000;
  mutated.forEach((cb) => cb());
  expect(el.scrollTop).toBe(1600);

  // the lines near the end are laid out for real, Markdown and all: the end moved without a scroll
  el.scrollHeight = 5200;
  resized.forEach((cb) => cb());
  expect(el.scrollTop).toBe(4800);
});

it("takes a scroll event that finds the view where it placed itself as its own, even when it grew meanwhile", () => {
  const el = view();
  const following = { current: true };
  const end = followEnd(el, following);
  el.scrollHeight = 2000;
  end.place();
  el.scrollHeight = 3000;
  end.scrolled();
  expect(following.current).toBe(true);
  resized.forEach((cb) => cb());
  expect(el.scrollTop).toBe(2600);
});

it("stays where the person scrolled up to, and follows again once they are back at the end", () => {
  const el = view();
  const following = { current: true };
  const end = followEnd(el, following);
  el.scrollHeight = 3000;
  end.place();

  el.scrollTop = 500;
  end.scrolled();
  expect(following.current).toBe(false);
  el.scrollHeight = 4000;
  resized.forEach((cb) => cb());
  expect(el.scrollTop).toBe(500);

  el.scrollTop = 3580;
  end.scrolled();
  expect(following.current).toBe(true);
  el.scrollHeight = 4500;
  resized.forEach((cb) => cb());
  expect(el.scrollTop).toBe(4100);
});
