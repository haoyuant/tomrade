import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalFrame } from "@tomradex/contracts";
import { BUSY_FRAME_MS, BUSY_MS, FRAME_MS, Pane, type Pty } from "../src/pane.js";

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

  it("paints a flood of output less often, and at the full rate again after a quiet frame or a keystroke", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"] });
    const pty = fakePty();
    const pane = new Pane("p", pty, ".", null, 20, 4, hooks);
    panes.push(pane);
    const at: number[] = [];
    pane.attach({ mode: "control", send: () => void at.push(Date.now()), close: () => undefined }, 20, 4);
    await vi.advanceTimersByTimeAsync(FRAME_MS * 4);
    at.length = 0;
    const gaps = () => at.slice(1).map((t, i) => t - at[i]!);
    // Output every 4 ms, a line at a time.
    let n = 0;
    const flood = async (ms: number) => {
      for (let t = 0; t < ms; t += 4) {
        pty.print(`${n++}\r\n`);
        await vi.advanceTimersByTimeAsync(4);
      }
    };

    await flood(BUSY_MS);
    expect(gaps().every((g) => g === FRAME_MS)).toBe(true);
    at.length = 0;
    await flood(400);
    expect(gaps().length).toBeGreaterThan(5);
    expect(gaps().every((g) => g === BUSY_FRAME_MS)).toBe(true);

    // A keystroke in the flood, right after a paint: its echo is painted a frame of the full rate later, not the slower one.
    pty.print(`${n++}\r\n`);
    at.length = 0;
    while (!at.length) await vi.advanceTimersByTimeAsync(1);
    at.length = 0;
    pane.input("k");
    pty.print("k");
    const typed = Date.now();
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    expect(at.length).toBeGreaterThan(0);
    expect(at[0]! - typed).toBeLessThanOrEqual(FRAME_MS);

    // A quiet frame, and the next output is painted at once, the ones after it at the full rate.
    await flood(400);
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * 2);
    at.length = 0;
    pty.print("after\r\n");
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toHaveLength(1);
    await flood(100);
    expect(gaps().every((g) => g <= FRAME_MS)).toBe(true);
  });

  it("parses what the program prints as it comes, not a timer later", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"] });
    const pty = fakePty();
    const pane = new Pane("p", pty, ".", null, 20, 4, hooks);
    panes.push(pane);
    const before = pane.revision;
    pty.print("one");
    pty.print("two");
    expect(pane.revision).toBe(before + 2);
    expect(pane.term.buffer.active.getLine(0)?.translateToString(true)).toBe("onetwo");
    // Nothing of xterm's own goes to the program for it.
    expect(pty.written).toBe("");
  });

  it("paints a frame that is due with the output that comes then, not a late timer's tick after", async () => {
    // Real timeouts, which no test advances: a paint goes only when output comes after it is due.
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate", "Date"] });
    const pty = fakePty();
    const pane = new Pane("p", pty, ".", null, 20, 4, hooks);
    panes.push(pane);
    const frames: TerminalFrame[] = [];
    pane.attach({ mode: "control", send: (f) => frames.push(f), close: () => undefined }, 20, 4);
    await new Promise((resolve) => pane.term.write("", resolve));
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(FRAME_MS * 4);
    frames.length = 0;

    pty.print("a");
    vi.advanceTimersByTime(0);
    expect(frames).toHaveLength(1);
    vi.setSystemTime(Date.now() + 5);
    pty.print("b");
    vi.advanceTimersByTime(0);
    expect(frames).toHaveLength(1);
    vi.setSystemTime(Date.now() + FRAME_MS);
    pty.print("c");
    vi.advanceTimersByTime(0);
    expect(frames).toHaveLength(2);
    expect(text(frames.slice(1))).toContain("abc");
  });
});
