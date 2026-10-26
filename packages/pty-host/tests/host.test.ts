import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "cordis";
import type { TerminalFrame, TerminalPaneEvent, TerminalScrollPosition, TerminalStream } from "@tomradex/contracts";
import { PtyHost } from "@tomradex/pty-host";
import { hostCall, hostStream, openTerminal } from "../src/client.js";
import { Host, serve, type HostOptions } from "../src/host.js";
import type { Pane, Pty } from "../src/pane.js";
import type { ProcessRow } from "../src/agents.js";
import type { PaneInfo } from "../src/protocol.js";

/** A pseudo-terminal the test plays the program of: what it prints, and what it was sent. */
class FakePty implements Pty {
  static last: FakePty | null = null;
  readonly pid = 4242;
  written = "";
  readonly sizes: [number, number][] = [];
  killed = false;
  private readonly datas = new Set<(data: string) => void>();
  private readonly exits = new Set<(exit: { exitCode: number }) => void>();
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }
  ) {
    FakePty.last = this;
  }
  onData(listener: (data: string) => void) {
    this.datas.add(listener);
  }
  onExit(listener: (exit: { exitCode: number }) => void) {
    this.exits.add(listener);
  }
  write(data: string) {
    this.written += data;
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  kill() {
    this.killed = true;
    this.exit();
  }
  print(data: string) {
    for (const listener of this.datas) listener(data);
  }
  exit(exitCode = 0) {
    for (const listener of [...this.exits]) listener({ exitCode });
    this.exits.clear();
  }
}

let n = 0;
const pipeName = () => (process.platform === "win32" ? `\\\\.\\pipe\\tomrade-pty-test-${process.pid}-${++n}` : path.join(os.tmpdir(), `tomrade-pty-test-${process.pid}-${++n}.sock`));

const servers: net.Server[] = [];
const hosts: Host[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const host of hosts.splice(0)) await host.shutdown();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function hostOn(opts: Partial<HostOptions> = {}): Promise<{ host: Host; pipe: string; killed: Pane[] }> {
  const killed: Pane[] = [];
  const host = new Host({
    spawn: (file, args, o) => new FakePty(file, args, o),
    shell: () => ({ file: "shell.exe", args: ["-NoLogo"] }),
    killTree: async (pane) => {
      killed.push(pane);
      pane.pty.kill();
    },
    version: "9.9.9",
    idleMs: 60_000,
    onIdle: () => undefined,
    enterDelayMs: 0,
    ...opts
  });
  hosts.push(host);
  const pipe = pipeName();
  servers.push(await serve(host, pipe));
  return { host, pipe, killed };
}

/** A terminal on the pipe, with the screen its frames paint so far. */
async function attached(pipe: string, paneId: string, mode: "control" | "observe" = "control", cols = 20, rows = 4) {
  const stream = openTerminal(pipe, { paneId, mode, cols, rows });
  const frames: TerminalFrame[] = [];
  let closed: string | null | undefined;
  stream.onFrame((f) => frames.push(f));
  stream.onClose((reason) => (closed = reason));
  closers.push(() => stream.close());
  await stream.attached;
  const text = () => frames.map((f) => Buffer.from(f.bytes).toString("utf8")).join("");
  return { stream, frames, text, closed: () => closed };
}

describe("the host", () => {
  it("answers ping with its version and protocol", async () => {
    const { pipe } = await hostOn();
    expect(await hostCall(pipe, "ping")).toMatchObject({ version: "9.9.9", protocol: 1, pid: process.pid });
  });

  it("starts a pane's shell with the pane's id in its environment, and types a command into it", async () => {
    const { pipe } = await hostOn();
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir(), env: { A: "1" }, command: "echo hi", label: "TOM-1" });
    const pty = FakePty.last!;
    expect(pty.file).toBe("shell.exe");
    expect(pty.opts.env).toEqual({ A: "1", HERDR_PANE_ID: pane_id });
    expect(pty.written).toBe("echo hi\r");
    const { panes } = await hostCall<{ panes: { pane_id: string; label: string; pid: number }[] }>(pipe, "pane.list");
    expect(panes).toEqual([expect.objectContaining({ pane_id, label: "TOM-1", pid: 4242 })]);
  });

  it("runs the program it is given instead of the shell", async () => {
    const { pipe } = await hostOn();
    await hostCall(pipe, "pane.launch", { cwd: os.tmpdir(), file: "bash.exe", args: ["run.command"] });
    expect([FakePty.last!.file, FakePty.last!.args]).toEqual(["bash.exe", ["run.command"]]);
  });

  it("refuses a pane it does not have by name", async () => {
    const { pipe } = await hostOn();
    await expect(hostCall(pipe, "pane.get", { pane_id: "nope" })).rejects.toMatchObject({ code: "pane_not_found" });
    const stream = openTerminal(pipe, { paneId: "nope", mode: "control", cols: 10, rows: 2 });
    await expect(stream.attached).rejects.toMatchObject({ code: "pane_not_found" });
    expect(stream.closed).toBe(true);
  });

  it("answers the program's queries itself, as ConPTY needs before it starts", async () => {
    const { pipe } = await hostOn();
    await hostCall(pipe, "pane.launch", { cwd: os.tmpdir() });
    FakePty.last!.print("\x1b[c");
    await vi.waitFor(() => expect(FakePty.last!.written).toContain("\x1b[?1;2c"));
  });

  it("paints a window the screen whole on attach, then only what changed", async () => {
    const { pipe } = await hostOn();
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir(), cols: 20, rows: 4 });
    const pty = FakePty.last!;
    pty.print("hello");
    const t = await attached(pipe, pane_id);
    await vi.waitFor(() => expect(t.frames.length).toBeGreaterThan(0));
    expect(t.frames[0]).toMatchObject({ full: true, width: 20, height: 4 });
    expect(t.text()).toContain("\x1b[1;1Hhello");
    pty.print("\r\nworld");
    await vi.waitFor(() => expect(t.text()).toContain("\x1b[2;1Hworld"));
    expect(t.frames.at(-1)!.full).toBe(false);
  });

  it("keeps the first frame for a caller that listens only once the attach has resolved", async () => {
    const { pipe } = await hostOn();
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir() });
    FakePty.last!.print("before");
    const stream = openTerminal(pipe, { paneId: pane_id, mode: "control", cols: 20, rows: 4 });
    closers.push(() => stream.close());
    await stream.attached;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const frames: TerminalFrame[] = [];
    stream.onFrame((f) => frames.push(f));
    expect(frames[0]?.full).toBe(true);
    expect(Buffer.from(frames[0]!.bytes).toString()).toContain("before");
  });

  it("takes input and size only from the one in control; a newer controller takes over and the old one is let go", async () => {
    const { pipe } = await hostOn();
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir() });
    const pty = FakePty.last!;
    const first = await attached(pipe, pane_id, "control", 30, 5);
    const watcher = await attached(pipe, pane_id, "observe");
    first.stream.input("a");
    watcher.stream.input("b");
    await vi.waitFor(() => expect(pty.written).toBe("a"));
    expect(pty.sizes).toContainEqual([30, 5]);
    const second = await attached(pipe, pane_id, "control", 40, 6);
    first.stream.input("c");
    second.stream.input("d");
    await vi.waitFor(() => expect(pty.written).toBe("ad"));
    expect(pty.sizes.at(-1)).toEqual([40, 6]);
    await vi.waitFor(() => expect(first.closed()).toBe("taken_over"));
    // An observer goes on watching.
    pty.print("x");
    await vi.waitFor(() => expect(watcher.text()).toContain("x"));
    expect(watcher.closed()).toBeUndefined();
  });

  it("scrolls the scrollback on the wheel, tells where the view is, and comes back down on typing", async () => {
    const { pipe } = await hostOn();
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir(), cols: 20, rows: 4 });
    const pty = FakePty.last!;
    const scrolls: unknown[] = [];
    const sub = hostStream(pipe, [{ type: "pane.scroll_changed", pane_id }], (e) => scrolls.push(e.data.scroll), () => undefined);
    closers.push(() => sub.close());
    pty.print(Array.from({ length: 12 }, (_, i) => `line${i}`).join("\r\n"));
    const t = await attached(pipe, pane_id, "control", 20, 4);
    await vi.waitFor(() => expect(scrolls.at(-1)).toEqual({ offset_from_bottom: 0, max_offset_from_bottom: 8, viewport_rows: 4 }));
    t.stream.scroll({ direction: "up", lines: 3 });
    await vi.waitFor(() => expect(scrolls.at(-1)).toEqual({ offset_from_bottom: 3, max_offset_from_bottom: 8, viewport_rows: 4 }));
    await vi.waitFor(() => expect(t.text()).toContain("\x1b[1;1Hline5"));
    t.stream.input("q");
    await vi.waitFor(() => expect(scrolls.at(-1)).toMatchObject({ offset_from_bottom: 0 }));
    await hostCall(pipe, "pane.scroll", { pane_id, offset_from_bottom: 100 });
    await vi.waitFor(() => expect(scrolls.at(-1)).toMatchObject({ offset_from_bottom: 8 }));
  });

  it("hands the wheel and clicks to a program that reads the mouse, and arrow keys to one on the alternate screen", async () => {
    const { pipe } = await hostOn();
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir() });
    const pty = FakePty.last!;
    const t = await attached(pipe, pane_id);
    pty.print("\x1b[?1000h\x1b[?1006h");
    await vi.waitFor(() => expect(t.frames.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    t.stream.scroll({ direction: "up", lines: 1, column: 4, row: 2 });
    t.stream.mouse({ action: "down", button: "left", column: 1, row: 0 });
    t.stream.mouse({ action: "up", button: "left", column: 1, row: 0 });
    await vi.waitFor(() => expect(pty.written).toBe("\x1b[<64;5;3M\x1b[<0;2;1M\x1b[<0;2;1m"));
    pty.written = "";
    pty.print("\x1b[?1000l\x1b[?1049h");
    await new Promise((resolve) => setTimeout(resolve, 50));
    t.stream.scroll({ direction: "down", lines: 2 });
    t.stream.scroll({ direction: "up", lines: 10, source: "page_key" });
    t.stream.mouse({ action: "down", button: "left", column: 1, row: 0 });
    await vi.waitFor(() => expect(pty.written).toBe("\x1b[B\x1b[B\x1b[5~"));
  });

  it("reads the last lines of a pane, and types a prompt with its Enter after", async () => {
    const { pipe } = await hostOn();
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir() });
    const pty = FakePty.last!;
    pty.print("one\r\ntwo\r\nthree\r\n");
    await vi.waitFor(async () => expect(await hostCall(pipe, "pane.read", { pane_id, lines: 2 })).toEqual({ text: "two\nthree" }));
    await hostCall(pipe, "pane.send_input", { pane_id, text: "go on", enter: true });
    await vi.waitFor(() => expect(pty.written).toBe("go on\r"));
  });

  it("ends a closed pane's process tree, tells its windows and subscribers, and exits once it has no pane", async () => {
    const onIdle = vi.fn();
    const { host, pipe, killed } = await hostOn({ idleMs: 50, onIdle });
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir() });
    const events: unknown[] = [];
    const sub = hostStream(pipe, [{ type: "pane.exited" }], (e) => events.push(e), () => undefined);
    closers.push(() => sub.close());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const t = await attached(pipe, pane_id);
    expect(onIdle).not.toHaveBeenCalled();
    await hostCall(pipe, "pane.close", { pane_id });
    expect(killed.map((p) => p.id)).toEqual([pane_id]);
    expect(host.panes.size).toBe(0);
    await vi.waitFor(() => expect(t.closed()).toBe("exited"));
    await vi.waitFor(() => expect(events).toEqual([{ event: "pane.exited", data: { pane_id } }]));
    await vi.waitFor(() => expect(onIdle).toHaveBeenCalledOnce());
    // Already gone is closed all the same.
    await expect(hostCall(pipe, "pane.close", { pane_id })).resolves.toEqual({});
  });

  it("lets a pane go whose process ends by itself", async () => {
    const { host, pipe } = await hostOn();
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir() });
    const t = await attached(pipe, pane_id);
    FakePty.last!.exit(1);
    await vi.waitFor(() => expect(t.closed()).toBe("exited"));
    expect(host.panes.has(pane_id)).toBe(false);
  });
});

describe("what runs in the host's panes", () => {
  const table = (...extra: ProcessRow[]): ProcessRow[] => [
    { pid: 4242, ppid: 1, created: 100, name: "pwsh.exe", cmdline: "pwsh -NoLogo" },
    { pid: 5000, ppid: 4242, created: 200, name: "claude.exe", cmdline: '"C:\\Users\\me\\.local\\bin\\claude.exe" --continue' },
    ...extra
  ];
  const timing = { minMs: 0, staleMs: 60_000, soonMs: 0 };

  it("names the agent under a pane, reads Claude's spinner as working, and lists what runs there", async () => {
    const scan = vi.fn(async () => table({ pid: 5001, ppid: 5000, created: 300, name: "git.exe", cmdline: "git status" }));
    const { host, pipe } = await hostOn({ scan, scanTiming: timing });
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir() });
    await host.settled();
    FakePty.last!.print("\x1b]0;⠂ Fixing the parser\x07");
    await vi.waitFor(async () => expect((await hostCall<{ pane: PaneInfo }>(pipe, "pane.get", { pane_id })).pane).toMatchObject({ agent: "claude", agent_status: "working", title: "⠂ Fixing the parser" }));
    expect(await hostCall(pipe, "pane.process_info", { pane_id })).toEqual({
      process_info: { foreground_processes: [{ pid: 5000, name: "claude.exe", cmdline: "claude --continue" }, { pid: 5001, name: "git.exe", cmdline: "git status" }] }
    });
  });

  it("reads nothing while no pane is open, and a pane opening or retitling has the table read again soon", async () => {
    const scan = vi.fn(async () => table());
    const { host, pipe } = await hostOn({ scan, scanTiming: timing });
    await hostCall(pipe, "pane.list");
    await host.settled();
    expect(scan).not.toHaveBeenCalled();
    await hostCall(pipe, "pane.launch", { cwd: os.tmpdir() });
    await host.settled();
    expect(scan).toHaveBeenCalledTimes(1);
    FakePty.last!.print("\x1b]0;a title\x07");
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
  });

  it("answers from the table it has while a slow scan runs, runs one scan at a time, and keeps the table when one fails", async () => {
    let release: (rows: ProcessRow[]) => void = () => undefined;
    let fail: (err: Error) => void = () => undefined;
    const scan = vi.fn(() => new Promise<ProcessRow[]>((resolve, reject) => ((release = resolve), (fail = reject))));
    const { host, pipe } = await hostOn({ scan, scanTiming: { minMs: 0, staleMs: 0, soonMs: 0 } });
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir() });
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    // The scan has not answered: the reply comes at once, with no agent yet, and starts no second scan.
    expect((await hostCall<{ panes: PaneInfo[] }>(pipe, "pane.list")).panes[0]).toMatchObject({ pane_id, agent: null, agent_status: "unknown" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scan).toHaveBeenCalledTimes(1);
    release(table());
    await host.settled();
    // A table read this very millisecond is not yet older than "at once".
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await hostCall<{ panes: PaneInfo[] }>(pipe, "pane.list")).panes[0]!.agent).toBe("claude");
    // Stale at once: that read asked for another scan, which fails and leaves the table as it was.
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    fail(new Error("powershell went away"));
    await host.settled();
    expect((await hostCall<{ pane: PaneInfo }>(pipe, "pane.get", { pane_id })).pane.agent).toBe("claude");
  });

  it("keeps scans apart by the minimum interval", async () => {
    const scan = vi.fn(async () => table());
    const { host, pipe } = await hostOn({ scan, scanTiming: { minMs: 60_000, staleMs: 0, soonMs: 0 } });
    await hostCall(pipe, "pane.launch", { cwd: os.tmpdir() });
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    await hostCall(pipe, "pane.list");
    await hostCall(pipe, "pane.list");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(scan).toHaveBeenCalledTimes(1);
    await host.shutdown();
  });
});

describe("ctx.terminals over the host", () => {
  async function service(pipe: string): Promise<PtyHost> {
    const ctx = new Context();
    await ctx.plugin(PtyHost, { pipe, reconnectMs: 30 });
    closers.push(() => void ctx.registry.delete(PtyHost));
    return ctx.get("terminals") as PtyHost;
  }

  it("opens a pane on the host that answers, and reads it back", async () => {
    const { pipe } = await hostOn();
    const terminals = await service(pipe);
    expect(terminals.kind).toBe("builtin");
    const launched = await terminals.launch({ cwd: os.tmpdir(), label: "TOM-7", command: "bash 'run.command'", program: { file: "bash.exe", args: ["run.command"] } });
    expect(launched?.paneId).toMatch(/^p[0-9a-z]+-\d+$/);
    expect([FakePty.last!.file, FakePty.last!.args]).toEqual(["bash.exe", ["run.command"]]);
    // The program runs the script; nothing is typed into it a second time.
    expect(FakePty.last!.written).toBe("");
    // The pane gets Tomrade's environment without Electron's switches.
    expect(Object.keys(FakePty.last!.opts.env).some((k) => k.startsWith("ELECTRON_"))).toBe(false);
    expect(await terminals.panes()).toEqual([{ paneId: launched!.paneId, agent: null, agentSession: null, status: "unknown", title: null }]);
    expect(await terminals.paneAlive(launched!.paneId)).toBe(true);
    expect(await terminals.paneAlive("p0-9")).toBe(false);
    expect(await terminals.serverGone()).toBe(false);
  });

  it("streams a terminal, scroll positions and a prompt, and hears a watched pane end", async () => {
    const { pipe } = await hostOn();
    const terminals = await service(pipe);
    const { paneId } = (await terminals.launch({ cwd: os.tmpdir() }))!;
    const pty = FakePty.last!;
    const events: TerminalPaneEvent[] = [];
    closers.push(terminals.onPane((e) => events.push(e)));
    const release = terminals.watch(paneId);
    expect(terminals.watching()).toEqual([paneId]);
    const stream: TerminalStream = await terminals.terminal(paneId, { cols: 20, rows: 4 });
    const frames: TerminalFrame[] = [];
    stream.onFrame((f) => frames.push(f));
    const scrolls: TerminalScrollPosition[] = [];
    closers.push(terminals.onScroll(paneId, (s) => scrolls.push(s)));
    pty.print("ready");
    await vi.waitFor(() => expect(frames.map((f) => Buffer.from(f.bytes).toString()).join("")).toContain("ready"));
    await vi.waitFor(() => expect(scrolls.at(-1)).toEqual({ offset: 0, max: 0, rows: 4 }));
    expect(await terminals.prompt(paneId, "continue")).toBe(true);
    await vi.waitFor(() => expect(pty.written).toContain("continue\r"));
    expect(await terminals.readTail(paneId)).toBe("ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await terminals.closePane(paneId)).toBe(true);
    await vi.waitFor(() => expect(events).toEqual([{ kind: "exited", paneId }]));
    expect(terminals.watching()).toEqual([]);
    release();
  });

  it("says the host is not running when nothing answers, and keeps quiet about panes it cannot see", async () => {
    const terminals = await service(pipeName());
    await expect(terminals.terminal("p1-1", { cols: 10, rows: 2 })).rejects.toMatchObject({ code: "notRunning" });
    await expect(terminals.terminal("p1-1", { cols: 10, rows: 2 })).rejects.toThrow(/not running/);
    expect(await terminals.panes()).toBeNull();
    expect(await terminals.paneAlive("p1-1")).toBeNull();
    expect(await terminals.serverGone()).toBe(true);
    // No host, no terminals: a close has nothing left to end.
    expect(await terminals.closePane("p1-1")).toBe(true);
  });

  it("gives the agent the host sees, with its working state and its title without the spinner, and what runs in the pane", async () => {
    const scan = async (): Promise<ProcessRow[]> => [
      { pid: 4242, ppid: 1, created: 1, name: "pwsh.exe", cmdline: "pwsh" },
      { pid: 4300, ppid: 4242, created: 2, name: "node.exe", cmdline: "node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" }
    ];
    const { host, pipe } = await hostOn({ scan, scanTiming: { minMs: 0, staleMs: 60_000, soonMs: 0 } });
    const terminals = await service(pipe);
    const { paneId } = (await terminals.launch({ cwd: os.tmpdir() }))!;
    await host.settled();
    FakePty.last!.print("\x1b]0;⠂ Fixing the parser\x07");
    await vi.waitFor(async () => expect(await terminals.panes()).toEqual([{ paneId, agent: "claude", agentSession: null, status: "working", title: "Fixing the parser" }]));
    expect(await terminals.processes(paneId)).toEqual([{ cmdline: "node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" }]);
    expect(await terminals.processes("p0-9")).toEqual([]);
  });

  it("reads a host that names no agents, as an older one, as before", async () => {
    const { pipe } = await hostOn();
    const terminals = await service(pipe);
    const { paneId } = (await terminals.launch({ cwd: os.tmpdir() }))!;
    FakePty.last!.print("\x1b]0;⠂ my title\x07");
    await vi.waitFor(async () => expect(await terminals.panes()).toEqual([{ paneId, agent: null, agentSession: null, status: "unknown", title: "⠂ my title" }]));
    expect(await terminals.processes(paneId)).toEqual([]);
  });

  it("is ready only where the ConPTY runtime is", async () => {
    const terminals = await service(pipeName());
    const bridge = await terminals.bridge();
    if (process.platform === "win32") expect(bridge.state).toBe("ready");
    else expect(bridge).toEqual({ state: "unsupported" });
  });
});
