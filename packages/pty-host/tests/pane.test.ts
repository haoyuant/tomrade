import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalFrame } from "@tomradex/contracts";
import { FRAME_MS, Pane, type Pty } from "../src/pane.js";

/** A program that prints what the test says, and keeps what it was sent. */
function fakePty() {
  const datas: ((data: string) => void)[] = [];
  const pty = {
    pid: 1,
    written: "",
    onData: (listener: (data: string) => void) => datas.push(listener),
    onExit: () => undefined,
    write: (data: string) => void (pty.written += data),
    resize: () => undefined,
    kill: () => undefined,
    print: (data: string) => datas.forEach((listener) => listener(data))
  };
  return pty satisfies Pty;
}

const hooks = { onScroll: () => undefined, onExit: () => undefined };
const text = (frames: TerminalFrame[]) => frames.map((f) => Buffer.from(f.bytes).toString("utf8")).join("");

const panes: Pane[] = [];
afterEach(() => {
  for (const pane of panes.splice(0)) pane.dispose();
  vi.useRealTimers();
});

describe("a pane's paints", () => {
  it("takes the echo of what was typed at once, and hands what was typed to the program", () => {
    const pty = fakePty();
    const pane = new Pane("p", pty, ".", null, 20, 4, hooks);
    panes.push(pane);
    pane.input("x");
    expect(pty.written).toBe("x");
    const before = pane.revision;
    pty.print("x");
    expect(pane.revision).toBe(before + 1);
  });

  it("paints the first change after a quiet frame at once, and the changes within a frame as one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"] });
    const pty = fakePty();
    const pane = new Pane("p", pty, ".", null, 20, 4, hooks);
    panes.push(pane);
    const frames: TerminalFrame[] = [];
    pane.attach({ mode: "control", send: (f) => frames.push(f), close: () => undefined }, 20, 4);
    await vi.advanceTimersByTimeAsync(FRAME_MS * 4);
    frames.length = 0;

    pty.print("a");
    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toHaveLength(1);
    expect(text(frames)).toContain("a");

    pty.print("b");
    pty.print("c");
    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    expect(frames).toHaveLength(2);
    expect(Buffer.from(frames[1]!.bytes).toString("utf8")).toContain("abc");
  });
});
