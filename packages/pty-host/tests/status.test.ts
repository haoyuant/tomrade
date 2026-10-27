import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalStatus } from "@tomradex/contracts";
import { Pane, type Pty } from "../src/pane.js";
import { AgentScreens, manifestOf } from "../src/status.js";

const screen = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures/agent-screens", name), "utf8");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A pane as the readings see it: what it shows, and how often it was read. */
class FakePane {
  revision = 0;
  exited = false;
  title: string | null = null;
  reads = 0;
  private shown = { screen: "", oscTitle: "", oscProgress: "" };
  constructor(readonly id = "p1") {}
  show(text: string, oscTitle = this.shown.oscTitle) {
    this.shown = { ...this.shown, screen: text, oscTitle };
    this.revision++;
  }
  detectionInput() {
    this.reads++;
    return this.shown;
  }
  forgetProgress() {
    this.shown = { ...this.shown, oscProgress: "" };
  }
}

function screens(timing = { readMs: 40, idleHoldMs: 60 }) {
  const told: { agent: string | null; status: TerminalStatus }[] = [];
  const s = new AgentScreens({ told: (_pane, agent, status) => told.push({ agent, status }), timing });
  disposers.push(() => s.dispose());
  return { s, told };
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("reading an agent off its pane", () => {
  it("finds herdr's manifest by an agent's id or alias, and none for an agent herdr has none for", () => {
    expect(manifestOf("claude")?.id).toBe("claude");
    expect(manifestOf("claude-code")?.id).toBe("claude");
    expect(manifestOf("copilot")?.id).toBe("copilot");
    expect(manifestOf("codebuddy")).toBeNull();
  });

  it("reads Claude's screen as herdr does, and tells only what changed", () => {
    const { s, told } = screens();
    const pane = new FakePane();
    const as = pane as unknown as Pane;
    pane.show(screen("claude-blocked-bash.txt"));
    expect(s.status(as, "claude")).toBe("blocked");
    pane.show(screen("claude-working.txt"));
    expect(s.status(as, "claude")).toBe("working");
    pane.show(screen("claude-idle.txt"));
    expect(s.status(as, "claude")).toBe("idle");
    // Unchanged: not read again, nothing told.
    const reads = pane.reads;
    expect(s.status(as, "claude")).toBe("idle");
    expect(pane.reads).toBe(reads);
    // Redrawn the same: read, nothing told.
    pane.show(screen("claude-idle.txt"));
    expect(s.status(as, "claude")).toBe("idle");
    expect(told).toEqual([
      { agent: "claude", status: "blocked" },
      { agent: "claude", status: "working" },
      { agent: "claude", status: "idle" }
    ]);
  });

  it("leaves the state as it was on a screen that says nothing of it", () => {
    const { s } = screens();
    const pane = new FakePane();
    pane.show(screen("claude-working.txt"));
    expect(s.status(pane as unknown as Pane, "claude")).toBe("working");
    pane.show(screen("claude-transcript.txt"));
    expect(s.status(pane as unknown as Pane, "claude")).toBe("working");
  });

  it("reads a busy pane at most every readMs, and the last screen it drew", async () => {
    const { s, told } = screens({ readMs: 60, idleHoldMs: 0 });
    const pane = new FakePane();
    const as = pane as unknown as Pane;
    const started = Date.now();
    // 100 redraws over ~300 ms, alternating working and blocked, ending blocked.
    for (let i = 0; i < 100; i++) {
      pane.show(screen(i % 2 ? "claude-blocked-bash.txt" : "claude-working.txt"));
      s.changed(as, "claude");
      await sleep(3);
    }
    await sleep(150);
    const elapsed = Date.now() - started;
    expect(pane.reads).toBeLessThanOrEqual(Math.ceil(elapsed / 60) + 1);
    expect(pane.reads).toBeGreaterThanOrEqual(2);
    expect(told.at(-1)).toEqual({ agent: "claude", status: "blocked" });
  });

  it("does not read a pane with no agent, nor one whose screen did not change", async () => {
    const { s } = screens();
    const pane = new FakePane();
    pane.show("$ ls");
    s.changed(pane as unknown as Pane, null);
    await sleep(80);
    expect(pane.reads).toBe(0);
    s.changed(pane as unknown as Pane, "claude");
    await sleep(80);
    expect(pane.reads).toBe(1);
    s.changed(pane as unknown as Pane, "claude");
    await sleep(80);
    expect(pane.reads).toBe(1);
  });

  it("holds working a moment before an idle the screen does not show outright", async () => {
    const { s, told } = screens({ readMs: 10, idleHoldMs: 80 });
    const pane = new FakePane();
    const as = pane as unknown as Pane;
    pane.show(screen("codex-working.txt"));
    expect(s.status(as, "codex")).toBe("working");
    // Codex's turn ended: its screen has no live timer, nothing says idle outright.
    pane.show(screen("codex-idle-after-turn.txt"));
    s.changed(as, "codex");
    await sleep(30);
    expect(s.status(as, "codex")).toBe("working");
    await vi.waitFor(() => expect(told.at(-1)).toEqual({ agent: "codex", status: "idle" }), { timeout: 1000, interval: 10 });
    // A gap between spinner frames: working again before the hold ran out.
    pane.show(screen("codex-working.txt"));
    expect(s.status(as, "codex")).toBe("working");
    pane.show(screen("codex-idle-after-turn.txt"));
    s.changed(as, "codex");
    await sleep(20);
    pane.show(screen("codex-working.txt"));
    s.changed(as, "codex");
    await sleep(150);
    expect(told.slice(-2)).toEqual([
      { agent: "codex", status: "idle" },
      { agent: "codex", status: "working" }
    ]);
    // Claude's prompt box is idle outright: no hold.
    pane.show(screen("claude-working.txt"));
    expect(s.status(as, "claude")).toBe("working");
    pane.show(screen("claude-idle.txt"));
    expect(s.status(as, "claude")).toBe("idle");
  });

  it("starts afresh when another agent runs in the pane, and goes quiet when none does", () => {
    const { s, told } = screens();
    const pane = new FakePane();
    const as = pane as unknown as Pane;
    pane.show(screen("claude-idle.txt"));
    expect(s.status(as, "claude")).toBe("idle");
    expect(s.status(as, "codex")).toBe("idle");
    expect(s.status(as, null)).toBe("unknown");
    // An agent herdr has no manifest for goes by its title, which says nothing here.
    expect(s.status(as, "codebuddy")).toBe("unknown");
    expect(told).toEqual([
      { agent: "claude", status: "idle" },
      { agent: "codex", status: "idle" },
      { agent: null, status: "unknown" },
      { agent: "codebuddy", status: "unknown" }
    ]);
  });
});

/** A program that only prints. */
class PrintPty implements Pty {
  readonly pid = 1;
  private listener: ((data: string) => void) | null = null;
  onData(listener: (data: string) => void) {
    this.listener = listener;
  }
  onExit() {}
  write() {}
  resize() {}
  kill() {}
  print(data: string) {
    this.listener?.(data);
  }
}

async function paneWith(cols: number, rows: number) {
  const pty = new PrintPty();
  const pane = new Pane("p1", pty, "/", null, cols, rows, { onScroll: () => undefined, onExit: () => undefined });
  disposers.push(() => pane.dispose());
  const print = (data: string) => new Promise<void>((resolve) => {
    pty.print(data);
    pane.term.write("", resolve);
  });
  return { pane, print };
}

describe("the live bottom a pane is read by", () => {
  it("is a screen's height of rows up to the last with something on it, without trailing blanks", async () => {
    const { pane, print } = await paneWith(30, 4);
    await print("one   \r\ntwo\r\n\r\n");
    expect(pane.detectionText()).toBe("one\ntwo\n");
    await print("three\r\nfour\r\nfive");
    // Blank rows within the height stay; only those after the last line with something go.
    expect(pane.detectionText()).toBe("\nthree\nfour\nfive\n");
  });

  it("is the bottom whatever the view is scrolled to", async () => {
    const { pane, print } = await paneWith(30, 4);
    await print(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\r\n"));
    pane.scrollTo(20);
    expect(pane.scroll().offset).toBe(20);
    expect(pane.detectionText()).toBe("line 36\nline 37\nline 38\nline 39\n");
  });

  it("reads wide characters once, and the alternate screen whole", async () => {
    const { pane, print } = await paneWith(30, 3);
    await print("中文 ❯ ok\r\n");
    expect(pane.detectionText()).toBe("中文 ❯ ok\n");
    await print("\x1b[?1049h\x1b[Hfull screen app");
    expect(pane.detectionText()).toBe("full screen app\n");
  });

  it("carries the title and the last OSC 9 progress, without control characters", async () => {
    const { pane, print } = await paneWith(30, 3);
    const before = pane.revision;
    await print("\x1b]0;✳ Claude\x07Code\x07\x1b]9;4;0;\x07");
    expect(pane.detectionInput()).toEqual({ screen: "Code\n", oscTitle: "✳ Claude", oscProgress: "4;0;" });
    expect(pane.revision).toBeGreaterThan(before);
    pane.forgetProgress();
    expect(pane.detectionInput().oscProgress).toBe("");
  });
});
