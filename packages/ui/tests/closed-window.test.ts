import { describe, expect, it } from "vitest";
import { DEFAULT_CLOSED_WINDOW, type Item } from "@tomradex/domain";
import { closedWindowOf, hiddenCount, isClosed, mergeById, pageSize, wholeOrNull, withClosedWindow } from "../src/lib/closedWindow";

describe("a project's closed window", () => {
  it("is the default until the project sets one", () => {
    expect(closedWindowOf(undefined, "p1")).toEqual(DEFAULT_CLOSED_WINDOW);
    expect(closedWindowOf({ closedWindow: { p2: { limit: 5, days: null } } }, "p1")).toEqual(DEFAULT_CLOSED_WINDOW);
    expect(closedWindowOf({ closedWindow: { p1: { limit: null, days: 30 } } }, "p1")).toEqual({ limit: null, days: 30 });
  });

  it("is written for its own project only, and the default is stored as nothing", () => {
    const before = { theme: "dark", closedWindow: { p2: { limit: 5, days: null } } };
    const set = withClosedWindow(before, "p1", { limit: 20, days: 7 });
    expect(set).toEqual({ theme: "dark", closedWindow: { p2: { limit: 5, days: null }, p1: { limit: 20, days: 7 } } });
    expect(withClosedWindow(set, "p1", DEFAULT_CLOSED_WINDOW)).toEqual(before);
    expect(before.closedWindow).toEqual({ p2: { limit: 5, days: null } });
  });

  it("pages by its own count, or the default's when it has none", () => {
    expect(pageSize({ limit: 20, days: null })).toBe(20);
    expect(pageSize({ limit: null, days: 30 })).toBe(DEFAULT_CLOSED_WINDOW.limit);
    expect(pageSize(null)).toBe(DEFAULT_CLOSED_WINDOW.limit);
  });

  it("reads a typed bound as a positive whole number or nothing", () => {
    expect(wholeOrNull("40")).toBe(40);
    expect(wholeOrNull("7.9")).toBe(7);
    expect(wholeOrNull("")).toBeNull();
    expect(wholeOrNull("0")).toBeNull();
    expect(wholeOrNull("-3")).toBeNull();
    expect(wholeOrNull("abc")).toBeNull();
  });
});

describe("what a closed column holds", () => {
  const item = (id: string, title = id) => ({ id, title }) as Item;

  it("merges the window, the pages and the search, each item once and the window's copy first", () => {
    const merged = mergeById([[item("a", "fresh"), item("b")], [item("a", "stale"), item("c")], undefined, [item("c"), item("d")]]);
    expect(merged.map((i) => [i.id, i.title])).toEqual([["a", "fresh"], ["b", "b"], ["c", "c"], ["d", "d"]]);
  });

  it("counts what is left out, never below nothing, and nothing until counted", () => {
    expect(hiddenCount(120, 50)).toBe(70);
    expect(hiddenCount(3, 5)).toBe(0);
    expect(hiddenCount(undefined, 5)).toBe(0);
  });

  it("knows the two closed statuses", () => {
    expect(["done", "cancelled", "doing", "verifying"].filter(isClosed)).toEqual(["done", "cancelled"]);
  });
});
