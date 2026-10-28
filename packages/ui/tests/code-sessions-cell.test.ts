import { describe, expect, it } from "vitest";
import { frameBatch } from "../src/code-sessions/frames";
import { sameCellProps } from "../src/code-sessions/sameProps";

describe("a cell redraws only on what it shows", () => {
  const onFocus = () => undefined;
  const base = { number: 1, session: { id: "s", state: "running", title: "A" }, places: [{ cwd: "/a" }], look: { theme: "", dark: false, tokens: {}, locale: "en" }, onFocus, menu: null };

  it("takes rows made afresh with the same content as the same, and anything else that differs as a change", () => {
    expect(sameCellProps(base, { ...base, session: { ...base.session }, places: [{ cwd: "/a" }], look: { ...base.look } })).toBe(true);
    expect(sameCellProps(base, { ...base, session: { ...base.session, state: "waiting" } })).toBe(false);
    expect(sameCellProps(base, { ...base, number: 2 })).toBe(false);
    // A handler is compared as itself: the window hands each cell the same ones.
    expect(sameCellProps(base, { ...base, onFocus: () => undefined })).toBe(false);
  });
});

describe("fitting once a frame", () => {
  it("runs each job once in the next frame however often it was asked, and none that was cancelled", () => {
    const frames: (() => void)[] = [];
    const batch = frameBatch((run) => frames.push(run));
    const ran: string[] = [];
    const a = () => ran.push("a");
    const b = () => ran.push("b");
    for (let i = 0; i < 5; i++) batch.soon(a);
    batch.soon(b);
    batch.cancel(b);
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(ran).toEqual(["a"]);
    batch.soon(b);
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(ran).toEqual(["a", "b"]);
  });
});
