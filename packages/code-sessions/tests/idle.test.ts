import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { Service, type Context } from "cordis";
import CodeSessions, { IDLE_SWEEP_MS, IdleTracker } from "@tomradex/code-sessions";
import { Contributions } from "@tomradex/contributions";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-idle-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

const MIN = 60_000;

it("counts a pane idle from when it was first seen, and any change, a running command or a working or waiting agent starts it again", () => {
  const idle = new IdleTracker();
  const look = (pane: string, over: Partial<{ status: "idle" | "working" | "blocked" | "done" | "unknown"; tail: string; busy: boolean }> = {}) => ({ pane, status: over.status ?? "done", tail: over.tail ?? "$", busy: over.busy ?? false });
  expect(idle.look([look("a"), look("b")], 0, 60 * MIN)).toEqual([]);
  expect(idle.look([look("a"), look("b", { tail: "$ ls" })], 30 * MIN, 60 * MIN)).toEqual([]);
  // a: untouched for an hour; b changed at 30 min
  expect(idle.look([look("a"), look("b", { tail: "$ ls" })], 60 * MIN, 60 * MIN)).toEqual(["a"]);
  expect(idle.look([look("a", { status: "working" }), look("b", { tail: "$ ls", busy: true })], 120 * MIN, 60 * MIN)).toEqual([]);
  expect(idle.look([look("a", { status: "blocked" }), look("b", { tail: "$ ls" })], 179 * MIN, 60 * MIN)).toEqual([]);
  expect(idle.look([look("a"), look("b", { tail: "$ ls" })], 180 * MIN, 60 * MIN)).toEqual(["b"]);
  // a pane gone and back counts afresh
  idle.look([look("b", { tail: "$ ls" })], 181 * MIN, 60 * MIN);
  expect(idle.look([look("a"), look("b", { tail: "$ ls" })], 240 * MIN, 60 * MIN)).toEqual(["b"]);
});

it("closes Tomrade's idle panes no cell shows, and never a cell's, a busy one, a working agent or the person's own", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const closed: string[] = [];
  const status: Record<string, "working" | "done" | "unknown"> = { "w1:p4": "done", "w1:p5": "done", "w1:p6": "working" };
  let alive = ["w1:p1", "w1:p2", "w1:p3", "w1:p4", "w1:p5", "w1:p6"];
  class FakeSurfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
  }
  class FakeHerdr extends Service {
    static provide = "terminals";
    readonly kind = "herdr" as const;
    constructor(ctx: Context) {
      super(ctx, "terminals");
    }
    onPane = () => () => {};
    watch = () => () => {};
    watching = (): string[] => [];
    bridge = async () => ({ state: "ready" as const, version: "0.9.5" });
    panes = async () => alive.map((paneId) => ({ paneId, agent: status[paneId] ? "claude" : null, agentSession: null, status: status[paneId] ?? ("unknown" as const), title: null }));
    processes = async (pane: string) => (pane === "w1:p3" ? [{ cmdline: "-zsh" }, { cmdline: "npm run build" }] : [{ cmdline: "-zsh" }]);
    readTail = async () => "$";
    closePane = async (pane: string) => {
      closed.push(pane);
      alive = alive.filter((p) => p !== pane);
      return true;
    };
  }
  const sessions = [
    { id: "s1", herdrPane: "w1:p4", device: "", startedAt: 1, state: "ended" },
    { id: "s2", herdrPane: "w1:p5", device: "", startedAt: 1, state: "ended" },
    { id: "s3", herdrPane: "w1:p6", device: "", startedAt: 1, state: "running" }
  ];
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => sessions;
    // s2 is the person's own claude, reported by its hooks
    launchedHere = (id: string) => id !== "s2";
    links = () => [];
  }
  const stateFile = path.join(dir, "state.json");
  const settingsFile = path.join(dir, "settings.json");
  const w = await fresh({ plugins: [[Settings, { path: settingsFile }], Contributions, FakeSurfaces, FakeHerdr, FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile }]] });
  const terminal = (id: string, pane: string) => ({ id, title: "repo", cwd: dir, pane, startedAt: 1 });
  fs.writeFileSync(stateFile, JSON.stringify({ terminals: { [w.project.id]: [terminal("t1", "w1:p1"), terminal("t2", "w1:p2"), terminal("t3", "w1:p3")] }, layouts: { [w.project.id]: { type: "leaf", id: "c1", sessionId: "t1" } } }));
  w.ctx.settings.set({ ...w.ctx.settings.get(), terminalIdle: { enabled: true, minutes: 5 } });
  await settle();
  const sweep = async () => {
    vi.advanceTimersByTime(IDLE_SWEEP_MS);
    for (let i = 0; i < 5; i++) await settle();
  };
  const saved = () => (JSON.parse(fs.readFileSync(stateFile, "utf8")).terminals[w.project.id] as { id: string }[]).map((t) => t.id);

  // First seen, then idle for one sweep's five minutes.
  await sweep();
  expect(closed).toEqual([]);
  await sweep();
  expect(closed.sort()).toEqual(["w1:p2", "w1:p4"]);
  expect(saved()).toEqual(["t1", "t3"]);

  // Turned off: nothing more goes, however long.
  status["w1:p6"] = "done";
  w.ctx.settings.set({ ...w.ctx.settings.get(), terminalIdle: { enabled: false, minutes: 5 } });
  await sweep();
  await sweep();
  await sweep();
  expect(closed.sort()).toEqual(["w1:p2", "w1:p4"]);
});
