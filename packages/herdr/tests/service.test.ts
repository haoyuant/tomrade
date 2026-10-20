import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Context } from "cordis";
import { Herdr, type HerdrConfig, type HerdrPaneEvent } from "@tomradex/herdr";
// Straight from the source: depending on testkit would close a cycle through extensions, which depends on herdr.
import { FakeHerdr } from "../../testkit/src/herdr.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-service-"));
/** Stand-in servers a test started; detached, so nothing else ends them. */
const spawned: number[] = [];
afterAll(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// No herdr on this machine unless a test brings one: a stopped fake must never start the real one.
async function herdrOn(fake: FakeHerdr, config: HerdrConfig = {}): Promise<{ ctx: Context; herdr: Herdr }> {
  const ctx = new Context();
  await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket, bin: path.join(root, "absent"), ...config });
  return { ctx, herdr: ctx.herdr };
}

/**
 * A herdr CLI stand-in: `--version` answers, and `server` notes the socket it was given and stays
 * running as the server's process — or, `failing`, exits at once. The test's FakeHerdr answers on the socket.
 */
function herdrCli(name: string, failing = false): { bin: string; starts: () => { pid: number; socket: string }[] } {
  const dir = fs.mkdtempSync(path.join(root, `${name}-`));
  const bin = path.join(dir, "herdr");
  const log = path.join(dir, "starts");
  const server = failing ? "exit 1" : `echo "$$ $HERDR_SOCKET_PATH" >> '${log}'; exec sleep 60`;
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  --version) echo "herdr 0.9.5" ;;\n  server) ${server} ;;\nesac\n`, { mode: 0o755 });
  const starts = () => {
    let text = "";
    try {
      text = fs.readFileSync(log, "utf8");
    } catch {
      return [];
    }
    return text.trim().split("\n").map((line) => {
      const [pid, socket] = line.split(" ");
      return { pid: Number(pid), socket: socket! };
    });
  };
  return { bin, starts };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (check: () => boolean, timeout = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("herdr service", () => {
  it("launches a command in a workspace of its own, unfocused, typed with Enter, and reads and prompts the pane", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const launched = await herdr.launch({ cwd: "/work/tom-7", label: "TOM-7", command: "bash '/sessions/s1/run.command'" });
    expect(launched).toEqual({ paneId: "w1:p1", workspaceId: "w1" });
    expect(fake.of("workspace.create")).toEqual([{ cwd: "/work/tom-7", label: "TOM-7", focus: false }]);
    expect(fake.of("pane.send_input")).toEqual([{ pane_id: "w1:p1", text: "bash '/sessions/s1/run.command'", keys: ["enter"] }]);
    expect(await herdr.paneAlive("w1:p1")).toBe(true);
    expect(await herdr.paneAlive("w9:p9")).toBe(false);

    // No agent in the pane yet: nothing to prompt. With one, the text goes in; blocked, it does not.
    expect(await herdr.prompt("w1:p1", "go")).toBe(false);
    fake.panes.get("w1:p1")!.agent = "claude";
    fake.panes.get("w1:p1")!.text = "❯ working on it\nDone: scaffold in place.\n> \n? for shortcuts";
    expect(await herdr.prompt("w1:p1", "go")).toBe(true);
    expect(fake.of("agent.prompt")).toEqual([{ target: "w1:p1", text: "go" }, { target: "w1:p1", text: "go" }]);
    fake.panes.get("w1:p1")!.agent_status = "blocked";
    expect(await herdr.prompt("w1:p1", "go")).toBe(false);
    expect(await herdr.readTail("w1:p1")).toContain("Done: scaffold in place.");
    expect(fake.of("pane.read")[0]).toMatchObject({ pane_id: "w1:p1", source: "recent", lines: 20 });
    expect(await herdr.readTail("w9:p9")).toBeNull();

    fake.stop();
    expect(await herdr.launch({ cwd: "/work", command: "true" })).toBeNull();
    expect(await herdr.paneAlive("w1:p1")).toBeNull();
    expect(await herdr.server()).toBeNull();
  });

  it("opens a plain shell when there is no command, and closes a pane", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const launched = await herdr.launch({ cwd: "/work", label: "work", workspace: { key: "p1", label: "Project" } });
    expect(launched).toEqual({ paneId: "w1:p1", workspaceId: "w1" });
    expect(fake.of("pane.send_input")).toEqual([]);
    expect(await herdr.closePane("w1:p1")).toBe(true);
    expect(fake.of("pane.close")).toEqual([{ pane_id: "w1:p1" }]);
    expect(await herdr.paneAlive("w1:p1")).toBe(false);
    // Already gone counts as closed; herdr not answering does not.
    expect(await herdr.closePane("w1:p1")).toBe(true);
    fake.stop();
    expect(await herdr.closePane("w1:p1")).toBe(false);
  });

  it("follows a pane's status per pane, once per change, hears its end, and lets it go", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const heard: HerdrPaneEvent[] = [];
    herdr.onPane((event) => heard.push(event));
    const pane = fake.createPane("/work");
    // What the pane says when the watch starts is heard first, so a change made before counts.
    pane.agent = "claude";
    pane.agent_status = "working";
    herdr.watch(pane.pane_id);
    await until(() => heard.length === 1);
    expect(heard[0]).toEqual({ kind: "status", paneId: "w1:p1", status: "working", agent: "claude" });
    await until(() => fake.of("events.subscribe").length === 2);
    expect(fake.of("events.subscribe")).toEqual(expect.arrayContaining([{ subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }] }, { subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }] }]));

    fake.setStatus("w1:p1", "claude", "working");
    fake.setStatus("w1:p1", "claude", "blocked");
    await until(() => heard.length === 2);
    expect(heard[1]).toEqual({ kind: "status", paneId: "w1:p1", status: "blocked", agent: "claude" });
    fake.setStatus("w1:p1", "claude", "done");
    await until(() => heard.length === 3);
    expect(heard[2]).toMatchObject({ status: "done" });

    // Another pane, not watched, is nobody's business.
    const other = fake.createPane("/elsewhere");
    fake.setStatus(other.pane_id, "codex", "working");
    fake.exit(other.pane_id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard.length).toBe(3);

    fake.exit("w1:p1");
    await until(() => heard.length === 4);
    expect(heard[3]).toEqual({ kind: "exited", paneId: "w1:p1" });
    expect(herdr.watching()).toEqual([]);
  });

  it("follows a pane while anyone holds it, and reads each pane's status with the list", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const heard: HerdrPaneEvent[] = [];
    herdr.onPane((event) => heard.push(event));
    const pane = fake.createPane("/work");
    const first = herdr.watch(pane.pane_id);
    const second = herdr.watch(pane.pane_id);
    first();
    first();
    expect(herdr.watching()).toEqual([pane.pane_id]);
    fake.setStatus(pane.pane_id, "claude", "blocked");
    await until(() => heard.some((event) => event.kind === "status" && event.status === "blocked"));
    expect((await herdr.panes())!.find((p) => p.paneId === pane.pane_id)).toMatchObject({ agent: "claude", status: "blocked" });
    second();
    expect(herdr.watching()).toEqual([]);
    fake.close();
  });

  it("subscribes again when herdr comes back, and reports a watched pane that went while it was away", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const heard: HerdrPaneEvent[] = [];
    herdr.onPane((event) => heard.push(event));
    const kept = fake.createPane("/kept");
    const lost = fake.createPane("/lost");
    herdr.watch(kept.pane_id);
    herdr.watch(lost.pane_id);
    await until(() => fake.of("events.subscribe").length === 3);

    fake.stop();
    fake.panes.delete(lost.pane_id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(heard).toEqual([]);
    fake.start();
    await until(() => heard.some((event) => event.kind === "exited" && event.paneId === lost.pane_id));
    expect(herdr.watching()).toEqual([kept.pane_id]);
    // …and the kept pane is followed again.
    fake.setStatus(kept.pane_id, "claude", "blocked");
    await until(() => heard.some((event) => event.kind === "status" && event.paneId === kept.pane_id && event.status === "blocked"));
    fake.close();
  });

  it("tells herdr how to resume a pane's agent, what to show on the pane, and what to say to the person", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const pane = fake.createPane("/work");
    expect(await herdr.reportSession(pane.pane_id, "claude", "sess-1", ["bash", "/s/resume.command"])).toBe(true);
    expect(fake.of("pane.report_agent_session")).toEqual([{ pane_id: "w1:p1", source: "tomrade", agent: "claude", agent_session_id: "sess-1", resume_argv: ["bash", "/s/resume.command"] }]);
    expect(await herdr.reportMetadata(pane.pane_id, { ticket: "TOM-7", status: "Doing", session: null })).toBe(true);
    expect(fake.of("pane.report_metadata")).toEqual([{ pane_id: "w1:p1", source: "tomrade", tokens: { ticket: "TOM-7", status: "Doing", session: null } }]);
    expect(await herdr.notify("TOM-7 needs you", "x".repeat(300))).toBe(true);
    expect(fake.of("notification.show")).toEqual([{ title: "TOM-7 needs you", body: "x".repeat(240), sound: "request" }]);
    expect(await herdr.reportSession("w9:p9", "claude", "sess-1", ["bash", "x"])).toBe(false);
    fake.stop();
    expect(await herdr.notify("gone")).toBe(false);
  });

  it("watches a pane herdr no longer has as already over", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const heard: HerdrPaneEvent[] = [];
    herdr.onPane((event) => heard.push(event));
    herdr.watch("w4:p1");
    await until(() => heard.length === 1);
    expect(heard[0]).toEqual({ kind: "exited", paneId: "w4:p1" });
    expect(herdr.watching()).toEqual([]);
    fake.close();
  });

  it.skipIf(process.platform === "win32")("finds an installed herdr when the app was opened from the Dock with launchd's bare PATH", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake, { bin: undefined });
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local/bin/herdr"), "#!/bin/sh\necho herdr 0.9.5\n", { mode: 0o755 });
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = home;
    try {
      // A Homebrew herdr on this machine may answer first; either way it is found, and the server would start from it.
      expect(await herdr.installed()).not.toBeNull();
      expect(herdr.binary()).toMatch(/\/herdr$/);
    } finally {
      process.env.PATH = saved.PATH;
      process.env.HOME = saved.HOME;
      fake.close();
    }
  });

  it("shows a pane, and says when no herdr client is attached to see it", async () => {
    const fake = new FakeHerdr();
    const { herdr } = await herdrOn(fake);
    const pane = fake.createPane("/work");
    expect(await herdr.show(pane.pane_id, "TOM-7 · Work")).toBe("shown");
    expect(fake.of("pane.focus")).toEqual([{ pane_id: pane.pane_id }]);
    expect(fake.of("notification.show")).toEqual([{ title: "TOM-7 · Work", body: "", sound: "none" }]);
    fake.attached = false;
    expect(await herdr.show(pane.pane_id, "TOM-7 · Work")).toBe("noClient");
    expect(await herdr.show("w9:p9", "gone")).toBeNull();
    fake.close();
  });
});

// The stand-in CLI is a shell script.
describe.skipIf(process.platform === "win32")("herdr installed but not running", () => {
  // Spawning, even /bin/sh, can wait on the system's policy check on a busy Mac.
  const slow = { timeout: 90_000 };

  it("starts its server headless on Tomrade's socket, waits for it to answer, launches into it, and never stops it", slow, async () => {
    const fake = new FakeHerdr();
    fake.stop();
    const cli = herdrCli("start");
    const statePath = path.join(root, "state", "herdr.json");
    const { ctx, herdr } = await herdrOn(fake, { bin: cli.bin, statePath, startTimeoutMs: 60_000 });
    const launching = herdr.launch({ cwd: "/work/tom-7", label: "TOM-7", command: "bash run.command" });
    await until(() => cli.starts().length === 1, 60_000);
    const [start] = cli.starts();
    spawned.push(start!.pid);
    expect(start!.socket).toBe(fake.socket);
    // Started but not answering yet: the launch waits rather than going elsewhere.
    await new Promise((resolve) => setTimeout(resolve, 300));
    fake.start();
    expect(await launching).toEqual({ paneId: "w1:p1", workspaceId: "w1", startedServer: "first" });
    expect(fake.calls.map((call) => call.method)).toEqual(["ping", "workspace.create", "pane.send_input"]);
    // Running now: the next launch goes straight in.
    expect(await herdr.launch({ cwd: "/work", command: "true" })).toEqual({ paneId: "w2:p1", workspaceId: "w2" });
    expect(cli.starts().length).toBe(1);

    // Quitting Tomrade leaves it running: herdr's sessions outlive Tomrade.
    await ctx.fiber.dispose();
    expect(alive(start!.pid)).toBe(true);
    expect(fake.of("server.stop")).toEqual([]);

    // Told once on this machine: a later Tomrade starting it again says nothing new.
    fake.stop();
    const later = await herdrOn(fake, { bin: cli.bin, statePath, startTimeoutMs: 60_000 });
    const relaunching = later.herdr.launch({ cwd: "/work", command: "true" });
    await until(() => cli.starts().length === 2, 60_000);
    spawned.push(cli.starts()[1]!.pid);
    fake.start();
    expect(await relaunching).toMatchObject({ startedServer: "again" });
    fake.close();
  });

  it("starts one server for launches at the same time", slow, async () => {
    const fake = new FakeHerdr();
    fake.stop();
    const cli = herdrCli("together");
    const { herdr } = await herdrOn(fake, { bin: cli.bin, startTimeoutMs: 60_000 });
    const both = Promise.all([herdr.launch({ cwd: "/a", command: "a" }), herdr.launch({ cwd: "/b", command: "b" })]);
    await until(() => cli.starts().length === 1, 60_000);
    spawned.push(cli.starts()[0]!.pid);
    fake.start();
    const [a, b] = await both;
    expect(cli.starts().length).toBe(1);
    expect(fake.of("workspace.create").length).toBe(2);
    // …and the person is told once, not once per launch.
    expect([a?.startedServer, b?.startedServer].sort()).toEqual(["again", "first"]);
    fake.close();
  });

  it("starts the server again when it went away, once for callers at the same time, held after its limit unless asked, never stopping it", slow, async () => {
    const fake = new FakeHerdr();
    const cli = herdrCli("revive");
    const { ctx, herdr } = await herdrOn(fake, { bin: cli.bin, startTimeoutMs: 60_000, reviveLimit: 1 });
    expect(await herdr.revive()).toBe("running");
    expect(cli.starts()).toEqual([]);

    fake.stop();
    const both = Promise.all([herdr.revive(), herdr.revive()]);
    await until(() => cli.starts().length === 1, 60_000);
    spawned.push(cli.starts()[0]!.pid);
    expect(cli.starts()[0]!.socket).toBe(fake.socket);
    fake.start();
    expect(await both).toEqual(["started", "started"]);

    // Gone again within the window: held, so a server that keeps dying is not started over and over…
    fake.stop();
    expect(await herdr.revive()).toBe("held");
    expect(cli.starts().length).toBe(1);
    // …unless the person asks.
    const asked = herdr.revive(true);
    await until(() => cli.starts().length === 2, 60_000);
    spawned.push(cli.starts()[1]!.pid);
    fake.start();
    expect(await asked).toBe("started");

    await ctx.fiber.dispose();
    expect(cli.starts().every((start) => alive(start.pid))).toBe(true);
    expect(fake.of("server.stop")).toEqual([]);
    const none = await herdrOn(fake);
    fake.stop();
    expect(await none.herdr.revive()).toBe("notInstalled");
    fake.close();
  });

  it("gives up at once when the server does not start, and starts nothing without herdr", slow, async () => {
    const fake = new FakeHerdr();
    fake.stop();
    const { herdr } = await herdrOn(fake, { bin: herdrCli("failing", true).bin, startTimeoutMs: 60_000 });
    const t0 = Date.now();
    expect(await herdr.launch({ cwd: "/work", command: "true" })).toBeNull();
    // The server's exit is the answer; the timeout is not waited out.
    expect(Date.now() - t0).toBeLessThan(55_000);
    expect(await herdr.installed()).toBe("0.9.5");
    const none = await herdrOn(fake);
    expect(await none.herdr.launch({ cwd: "/work", command: "true" })).toBeNull();
    expect(await none.herdr.installed()).toBeNull();
    fake.close();
  });
});
