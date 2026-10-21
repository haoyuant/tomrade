import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Context } from "cordis";
import { BRIDGE_MIN_VERSION, Herdr, HerdrError, compareVersions, openTerminal, parseTerminalLine, terminalCommand, type HerdrConfig, type TerminalFrame } from "@tomradex/herdr";
// Straight from the source: depending on testkit would close a cycle through extensions, which depends on herdr.
import { FakeHerdr } from "../../testkit/src/herdr.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-terminal-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const frame = (seq: number, full: boolean, text: string) => JSON.stringify({ type: "terminal.frame", seq, encoding: "ansi", width: 80, height: 24, full, bytes: Buffer.from(text).toString("base64") });

/**
 * A herdr CLI stand-in for terminal sessions: it notes its arguments, paints a first frame (after
 * `attachAfter` seconds, noting when it started and attached, by its width), and — controlling — notes each stdin
 * line and answers it with a frame until it is released. A pane named `w9:p1` is one it does not
 * have; observing, it paints once and waits to be ended. Its first `--version` takes `slowVersion` seconds.
 */
function terminalCli(version = "0.9.5", attachAfter = 0, slowVersion = 0): { bin: string; dir: string; args: () => string; stdin: () => string[]; log: () => string[] } {
  const dir = fs.mkdtempSync(path.join(root, "cli-"));
  const bin = path.join(dir, "herdr");
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      slowVersion ? `[ "$1" = --version ] && [ ! -e '${dir}/asked' ] && touch '${dir}/asked' && sleep ${slowVersion}` : ":",
      `[ "$1" = --version ] && echo "herdr ${version}" && exit 0`,
      `echo "$@" > '${dir}/args'`,
      `echo "$HERDR_SOCKET_PATH" > '${dir}/socket'`,
      `[ "$4" = "w9:p1" ] && echo "herdr: pane w9:p1 not found" >&2 && exit 1`,
      `echo "start $7" >> '${dir}/log'`,
      attachAfter ? `sleep ${attachAfter}` : ":",
      `echo "attach $7" >> '${dir}/log'`,
      `printf '%s\\n' '${frame(1, true, "hello")}'`,
      "printf 'not json\\n'",
      `[ "$3" = observe ] && exec sleep 60`,
      "while IFS= read -r line; do",
      `  printf '%s\\n' "$line" >> '${dir}/stdin'`,
      `  case "$line" in *terminal.release*) printf '%s\\n' '{"type":"terminal.closed","reason":"released"}'; exit 0;; esac`,
      `  printf '%s\\n' '${frame(2, false, "x")}'`,
      "done",
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return "";
    }
  };
  const lines = (name: string) => read(name).trim().split("\n").filter(Boolean);
  return { bin, dir, args: () => read("args").trim(), stdin: () => lines("stdin"), log: () => lines("log") };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const text = (f: TerminalFrame) => Buffer.from(f.bytes).toString();

describe("herdr terminal sessions", () => {
  it("reads frames and the end from herdr's lines, and passes over anything else", () => {
    const full = parseTerminalLine(frame(1, true, "hi"));
    expect(full).toMatchObject({ type: "frame", frame: { seq: 1, width: 80, height: 24, full: true } });
    expect(full?.type === "frame" && text(full.frame)).toBe("hi");
    expect(parseTerminalLine(frame(2, false, "x"))).toMatchObject({ type: "frame", frame: { seq: 2, full: false } });
    expect(parseTerminalLine('{"type":"terminal.closed","reason":"server_shutdown"}')).toEqual({ type: "closed", reason: "server_shutdown" });
    expect(parseTerminalLine('{"type":"terminal.closed"}')).toEqual({ type: "closed", reason: null });
    expect(parseTerminalLine("garbage")).toBeNull();
    expect(parseTerminalLine('{"type":"terminal.title","title":"x"}')).toBeNull();
  });

  it("writes herdr's control commands, keeping sizes and lines at least one", () => {
    expect(terminalCommand.input("ls\r")).toEqual({ type: "terminal.input", text: "ls\r" });
    expect(terminalCommand.input(new Uint8Array([27, 91, 65]))).toEqual({ type: "terminal.input", bytes: "G1tB" });
    expect(terminalCommand.resize(120.4, 0)).toEqual({ type: "terminal.resize", cols: 120, rows: 1 });
    expect(terminalCommand.scroll({ direction: "up", lines: 3 })).toEqual({ type: "terminal.scroll", direction: "up", lines: 3, modifiers: 0 });
    expect(terminalCommand.mouse({ action: "down", column: 4, row: 2 })).toEqual({ type: "terminal.mouse", action: "down", button: "left", column: 4, row: 2, modifiers: 0 });
    expect(terminalCommand.release()).toEqual({ type: "terminal.release" });
  });

  it("controls a pane: frames come in, commands go out on stdin, and closing releases it", async () => {
    const cli = terminalCli();
    const stream = openTerminal({ bin: cli.bin, paneId: "w1:p1", mode: "control", cols: 100, rows: 30 });
    const frames: TerminalFrame[] = [];
    stream.onFrame((f) => frames.push(f));
    await until(() => frames.length === 1);
    expect(cli.args()).toBe("terminal session control w1:p1 --takeover --cols 100 --rows 30");
    expect(text(frames[0]!)).toBe("hello");
    stream.input("ls\r");
    stream.resize(120, 40);
    await until(() => frames.length === 3);
    expect(frames.slice(1).map((f) => f.full)).toEqual([false, false]);
    expect(cli.stdin().map((l) => JSON.parse(l))).toEqual([{ type: "terminal.input", text: "ls\r" }, { type: "terminal.resize", cols: 120, rows: 40 }]);
    const reasons: (string | null)[] = [];
    stream.onClose((r) => reasons.push(r));
    stream.close();
    expect(stream.closed).toBe(true);
    expect(reasons).toEqual([null]);
    await until(() => cli.stdin().some((l) => l.includes("terminal.release")));
    // Closed: further calls go nowhere, and a late listener hears the end at once.
    stream.input("more");
    const late: (string | null)[] = [];
    stream.onClose((r) => late.push(r));
    expect(late).toEqual([null]);
  });

  it("observes without taking input, and ends the watcher when closed", async () => {
    const cli = terminalCli();
    const stream = openTerminal({ bin: cli.bin, paneId: "w1:p1", mode: "observe", cols: 80, rows: 24 });
    const frames: TerminalFrame[] = [];
    stream.onFrame((f) => frames.push(f));
    await until(() => frames.length === 1);
    expect(cli.args()).toBe("terminal session observe w1:p1 --cols 80 --rows 24");
    stream.input("ignored");
    stream.close();
    expect(cli.stdin()).toEqual([]);
  });

  it("says why when herdr will not attach, and when herdr itself ends the stream", async () => {
    const cli = terminalCli();
    const missing = openTerminal({ bin: cli.bin, paneId: "w9:p1", mode: "control", cols: 80, rows: 24 });
    const why = await new Promise<string | null>((resolve) => missing.onClose(resolve));
    expect(why).toBe("pane w9:p1 not found");
    const gone = openTerminal({ bin: path.join(root, "absent"), paneId: "w1:p1", mode: "control", cols: 80, rows: 24 });
    expect(await new Promise<string | null>((resolve) => gone.onClose(resolve))).toMatch(/ENOENT/);
    const released = openTerminal({ bin: cli.bin, paneId: "w1:p1", mode: "control", cols: 80, rows: 24 });
    const ended = new Promise<string | null>((resolve) => released.onClose(resolve));
    released.input('{"type":"terminal.release"}');
    // The stand-in reads the text, sees "terminal.release" and says the stream is closed.
    expect(await ended).toBe("released");
  });
});

async function herdrOn(fake: FakeHerdr, config: HerdrConfig = {}): Promise<{ ctx: Context; herdr: Herdr }> {
  const ctx = new Context();
  await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket, bin: path.join(root, "absent"), ...config });
  return { ctx, herdr: ctx.herdr };
}

describe.skipIf(process.platform === "win32")("herdr service terminals", () => {
  it("compares versions by their numbers", () => {
    expect(compareVersions("0.9.10", "0.9.2")).toBe(1);
    expect(compareVersions("0.9.2", "0.9.2-preview")).toBe(0);
    expect(compareVersions("v0.8.9", BRIDGE_MIN_VERSION)).toBe(-1);
  });

  it("says whether a terminal can be had, and the fix when herdr is missing, old, stopped or out of step with its server", async () => {
    const fake = new FakeHerdr();
    try {
      expect(await (await herdrOn(fake)).herdr.bridge()).toEqual({ state: "notInstalled" });
      const old = await herdrOn(fake, { bin: terminalCli("0.9.1").bin });
      expect(await old.herdr.bridge()).toEqual({ state: "tooOld", version: "0.9.1", need: "0.9.2", fix: "herdr update" });
      const cli = terminalCli("0.9.5");
      const { herdr } = await herdrOn(fake, { bin: cli.bin });
      expect(await herdr.bridge()).toEqual({ state: "ready", version: "0.9.5" });
      fake.version = "0.9.4";
      expect(await herdr.bridge()).toEqual({ state: "stale", version: "0.9.5", server: "0.9.4", fix: "herdr server stop" });
      fake.version = "0.9.5";
      fake.stop();
      expect(await herdr.bridge()).toEqual({ state: "notRunning", version: "0.9.5" });
      await expect(herdr.terminal("w1:p1", { cols: 80, rows: 24 })).rejects.toMatchObject({ code: "notRunning" });
      await expect(herdr.terminal("w1:p1", { cols: 80, rows: 24 })).rejects.toBeInstanceOf(HerdrError);
    } finally {
      fake.close();
    }
  });

  it("streams a pane on Tomrade's socket, and closes its terminals when it goes", async () => {
    const fake = new FakeHerdr();
    try {
      const cli = terminalCli();
      const { ctx, herdr } = await herdrOn(fake, { bin: cli.bin });
      const stream = await herdr.terminal("w1:p1", { cols: 90, rows: 20 });
      const frames: TerminalFrame[] = [];
      stream.onFrame((f) => frames.push(f));
      await until(() => frames.length === 1);
      expect(cli.args()).toBe("terminal session control w1:p1 --takeover --cols 90 --rows 20");
      expect(fs.readFileSync(path.join(cli.dir, "socket"), "utf8").trim()).toBe(fake.socket);
      await ctx.registry.delete(Herdr);
      expect(stream.closed).toBe(true);
      await until(() => cli.stdin().some((l) => l.includes("terminal.release")));
    } finally {
      fake.close();
    }
  });

  it("starts a pane's next control session once the one before has attached, so one let go early never takes the pane from it", async () => {
    const fake = new FakeHerdr();
    try {
      const cli = terminalCli("0.9.5", 0.3);
      const { herdr } = await herdrOn(fake, { bin: cli.bin });
      // A cell attached twice in quick succession: the first is let go before herdr has attached it.
      const first = herdr.terminal("w1:p1", { cols: 80, rows: 24 });
      const second = herdr.terminal("w1:p1", { cols: 81, rows: 24 });
      (await first).close();
      await second;
      await until(() => cli.log().length === 4);
      expect(cli.log()).toEqual(["start 80", "attach 80", "start 81", "attach 81"]);
      (await second).close();
    } finally {
      fake.close();
    }
  });

  it("gives the session before its full settling time from when its herdr starts, however long the checks before that take", async () => {
    const fake = new FakeHerdr();
    try {
      // The first session's checks outlast the settling time, as a loaded machine's can.
      const cli = terminalCli("0.9.5", 0.3, 2.5);
      const { herdr } = await herdrOn(fake, { bin: cli.bin });
      const first = herdr.terminal("w1:p1", { cols: 80, rows: 24 });
      const second = herdr.terminal("w1:p1", { cols: 81, rows: 24 });
      (await first).close();
      await second;
      await until(() => cli.log().length === 4);
      expect(cli.log()).toEqual(["start 80", "attach 80", "start 81", "attach 81"]);
      (await second).close();
    } finally {
      fake.close();
    }
  }, 15_000);
});

describe("herdr project workspaces", () => {
  it("opens a project's sessions as tabs of one workspace named for the project, each tab named for its ticket", async () => {
    const fake = new FakeHerdr();
    try {
      const { herdr } = await herdrOn(fake);
      const workspace = { key: "p1", label: "Tomrade" };
      const first = await herdr.launch({ cwd: "/w/a", label: "TOM-1", command: "bash a", workspace });
      expect(first).toMatchObject({ paneId: "w1:p1", workspaceId: "w1" });
      expect(fake.of("workspace.create")).toEqual([{ cwd: "/w/a", label: "Tomrade", focus: false }]);
      expect(fake.of("tab.rename")).toEqual([{ tab_id: "w1:t1", label: "TOM-1" }]);
      const second = await herdr.launch({ cwd: "/w/b", label: "TOM-2", command: "bash b", workspace });
      expect(second).toMatchObject({ paneId: "w1:p2", workspaceId: "w1" });
      expect(fake.of("tab.create")).toEqual([{ workspace_id: "w1", cwd: "/w/b", label: "TOM-2", focus: false }]);
      expect(fake.of("pane.send_input").map((p) => p.pane_id)).toEqual(["w1:p1", "w1:p2"]);
      // Another project gets its own.
      expect(await herdr.launch({ cwd: "/w/c", label: "ABC-1", command: "bash c", workspace: { key: "p2", label: "Other" } })).toMatchObject({ paneId: "w2:p1" });
      // Without one, a workspace of its own as before.
      expect(await herdr.launch({ cwd: "/w/d", label: "setup", command: "bash d" })).toMatchObject({ paneId: "w3:p1" });
      expect(fake.of("workspace.create").at(-1)).toEqual({ cwd: "/w/d", label: "setup", focus: false });
    } finally {
      fake.close();
    }
  });

  it("makes the workspace again when herdr no longer has it, or has given its id to another", async () => {
    const fake = new FakeHerdr();
    try {
      const statePath = path.join(fs.mkdtempSync(path.join(root, "state-")), "herdr.json");
      const { herdr } = await herdrOn(fake, { statePath });
      const workspace = { key: "p1", label: "Tomrade" };
      await herdr.launch({ cwd: "/w", label: "TOM-1", command: "x", workspace });
      expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({ workspaces: { p1: "w1" } });
      fake.closeWorkspace("w1");
      expect(await herdr.launch({ cwd: "/w", label: "TOM-2", command: "x", workspace })).toMatchObject({ paneId: "w2:p1" });
      // A later Tomrade reads where the project's workspace is.
      const again = await herdrOn(fake, { statePath });
      expect(await again.herdr.launch({ cwd: "/w", label: "TOM-3", command: "x", workspace })).toMatchObject({ paneId: "w2:p2" });
      // The id now names a workspace of someone else's.
      fake.spaces.get("w2")!.label = "scratch";
      expect(await again.herdr.launch({ cwd: "/w", label: "TOM-4", command: "x", workspace })).toMatchObject({ paneId: "w3:p1" });
      expect(fake.of("workspace.create").map((p) => p.label)).toEqual(["Tomrade", "Tomrade", "Tomrade"]);
    } finally {
      fake.close();
    }
  });

  it("makes one workspace for launches into a project at the same time", async () => {
    const fake = new FakeHerdr();
    try {
      const { herdr } = await herdrOn(fake);
      const workspace = { key: "p1", label: "Tomrade" };
      const panes = await Promise.all(["TOM-1", "TOM-2", "TOM-3"].map((label) => herdr.launch({ cwd: "/w", label, command: "x", workspace })));
      expect(fake.of("workspace.create")).toHaveLength(1);
      expect(panes.map((p) => p?.paneId).sort()).toEqual(["w1:p1", "w1:p2", "w1:p3"]);
    } finally {
      fake.close();
    }
  });
});
