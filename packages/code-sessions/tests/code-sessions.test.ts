import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { Service, type Context } from "cordis";
import CodeSessions, { sessionRows, type WindowMessage, type WindowPost, type WindowState } from "@tomradex/code-sessions";
import { Contributions } from "@tomradex/contributions";
import { Settings } from "@tomradex/settings";
import { Herdr } from "@tomradex/herdr";
import { FakeHerdr, fresh, settle } from "@tomradex/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-sessions-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

type Session = { id: string; itemIds: string[]; branch: string; state: string; mode: "headless" | "terminal"; agent: string; herdrPane: string | null; threadId: string | null; worktree: string | null; activity: string | null; summary: string | null; blocked: unknown; startedAt: number; endedAt: number | null; lastEventAt: number | null };

const session = (over: Partial<Session> & { id: string }): Session => ({ itemIds: [], branch: "b", state: "running", mode: "terminal", agent: "claude-code", herdrPane: null, threadId: null, worktree: null, activity: null, summary: null, blocked: null, startedAt: 1, endedAt: null, lastEventAt: null, ...over });

it("lists live sessions first, needs-you before the rest, and ended ones only for a day", () => {
  const now = 10 * 24 * 3600_000;
  const sessions = [
    session({ id: "old", state: "ended", endedAt: now - 2 * 24 * 3600_000, startedAt: 1 }),
    session({ id: "done", state: "ended", endedAt: now - 3600_000, startedAt: 2, herdrPane: "w1:p9" }),
    session({ id: "busy", itemIds: ["i1"], startedAt: 5, herdrPane: "w1:p1", branch: "tom-1/x" }),
    session({ id: "asks", state: "waiting", blocked: { kind: "permission" }, startedAt: 3, mode: "headless", threadId: "t1", summary: "May I?" })
  ];
  const rows = sessionRows({ sessionsOf: () => sessions as never, links: () => [{ branch: "tom-1/x", prUrl: "https://example.com/pr/1" }] as never }, { get: (_p, id) => (id === "i1" ? { key: "TOM-1", title: "One" } : null) }, "p", now);
  expect(rows.map((r) => r.id)).toEqual(["asks", "busy", "done"]);
  expect(rows[0]).toMatchObject({ needsYou: true, mode: "run", activity: "May I?", threadId: "t1" });
  expect(rows[1]).toMatchObject({ key: "TOM-1", title: "One", pane: "w1:p1", prUrl: "https://example.com/pr/1", mode: "terminal" });
  // An ended session's pane is no terminal to attach to.
  expect(rows[2]).toMatchObject({ pane: null, state: "ended" });
});

it("opens a window per project, streams a session's pane into a cell, and lets go when the cell or window does", async () => {
  const opened: { spec: Record<string, unknown> & { onMessage(m: unknown): void; onClose(): void }; states: WindowState[]; posts: WindowPost[]; closed: boolean; focused: number }[] = [];
  let failNext = false;
  const streams: { pane: string; size: unknown; sent: unknown[]; closed: boolean; frame(text: string): void }[] = [];
  const events: [string, unknown][] = [];
  const sessions = [session({ id: "s1", itemIds: [], herdrPane: "w1:p1", branch: "tom-1/x", worktree: "/work/tom-1" })];
  const commands: [string, unknown][] = [];

  class FakeSurfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
    open(spec: (typeof opened)[number]["spec"]) {
      if (failNext) {
        failNext = false;
        throw new Error("no window");
      }
      const entry = { spec, states: [spec.initialState as WindowState], posts: [] as WindowPost[], closed: false, focused: 0 };
      opened.push(entry);
      return { id: spec.id, capabilities: { programmaticPosition: true, forwardedMouseMoves: false }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, focus: () => void entry.focused++, setState: (s: WindowState) => void entry.states.push(s), post: (m: WindowPost) => void entry.posts.push(m), close: () => { entry.closed = true; spec.onClose(); } };
    }
  }
  class FakeHerdr extends Service {
    static provide = "herdr";
    constructor(ctx: Context) {
      super(ctx, "herdr");
    }
    bridge = async () => ({ state: "ready" as const, version: "0.9.5" });
    terminal = async (pane: string, size: unknown) => {
      const frames = new Set<(f: unknown) => void>();
      const entry = { pane, size, sent: [] as unknown[], closed: false, frame: (text: string) => frames.forEach((l) => l({ seq: 1, width: 80, height: 24, full: true, bytes: new Uint8Array(Buffer.from(text)) })) };
      streams.push(entry);
      return { paneId: pane, mode: "control", closed: false, onFrame: (l: (f: unknown) => void) => (frames.add(l), () => frames.delete(l)), onClose: () => () => {}, input: (d: unknown) => entry.sent.push(["input", d]), resize: (c: number, r: number) => entry.sent.push(["resize", c, r]), scroll: (s: unknown) => entry.sent.push(["scroll", s]), mouse: (m: unknown) => entry.sent.push(["mouse", m]), close: () => void (entry.closed = true) };
    };
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => sessions;
    links = () => [{ branch: "tom-1/x", prUrl: "https://github.com/o/r/pull/7" }];
    herdrInstall = async () => ({ command: "brew install herdr", guide: "https://herdr.dev/docs/install/" });
    installHerdr = async () => ({ launched: true, command: "brew install herdr" });
    worktreeOf = () => null;
    openPr = async () => ({ url: null, message: "pushed" });
  }

  const stateFile = path.join(dir, "state.json");
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings.json") }], Contributions, FakeSurfaces, FakeHerdr, FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile }]] });
  const ticket = w.ctx.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Window work", workType: "coding", status: "doing", by: "human" });
  sessions[0]!.itemIds = [ticket.id];
  for (const name of ["desktop/open", "desktop/open-external", "desktop/reveal"] as const) w.ctx.on(name, (arg: unknown) => void events.push([name, arg]));
  w.ctx.contributions.command({ id: "code-link.start-terminal", title: "Start", run: (scope) => (commands.push(["start", scope]), { toast: "continuing" }) });
  w.ctx.settings.set({ ...w.ctx.settings.get(), codeLink: { ...(w.ctx.settings.get().codeLink as object), terminal: "iTerm" } });
  await settle();

  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  expect(win.spec).toMatchObject({ id: `code-sessions.${w.project.id}`, kind: "window", url: "file:///ui/code-sessions.html", minWidth: 640, minHeight: 400, title: `Code sessions — ${w.project.name}` });
  const first = win.states[0]!;
  expect(first).toMatchObject({ projectId: w.project.id, bridge: { state: "ready" }, askSwitch: true, terminal: "iTerm", layout: { type: "leaf", sessionId: null } });
  expect(first.sessions).toEqual([expect.objectContaining({ id: "s1", key: ticket.key, title: "Window work", pane: "w1:p1" })]);
  // Opening it again brings the same window forward with fresh state.
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  expect(opened).toHaveLength(1);
  expect(win.focused).toBe(1);

  const say = async (m: WindowMessage) => {
    win.spec.onMessage(m);
    await settle();
  };
  // An attach that a newer one overtakes lets its stream go.
  win.spec.onMessage({ type: "attach", cell: "c1", sessionId: "s1", cols: 100, rows: 30 });
  await say({ type: "attach", cell: "c1", sessionId: "s1", cols: 120, rows: 40 });
  expect(streams.map((s) => [s.size, s.closed])).toEqual([[{ cols: 100, rows: 30 }, true], [{ cols: 120, rows: 40 }, false]]);
  const live = streams[1]!;
  live.frame("hello");
  expect(win.posts.at(-1)).toMatchObject({ type: "frame", cell: "c1", full: true });
  await say({ type: "input", cell: "c1", data: "ls\r" });
  await say({ type: "resize", cell: "c1", cols: 90, rows: 20 });
  await say({ type: "scroll", cell: "c1", direction: "up", lines: 3 });
  expect(live.sent).toEqual([["input", "ls\r"], ["resize", 90, 20], ["scroll", { type: "scroll", cell: "c1", direction: "up", lines: 3 }]]);

  // The toolbar: continue through code link, the PR in the browser, the worktree in Finder.
  await say({ type: "continue", sessionId: "s1" });
  expect(commands).toEqual([["start", { projectId: w.project.id, itemId: ticket.id }]]);
  expect(win.posts.at(-1)).toEqual({ type: "toast", text: "continuing" });
  await say({ type: "openPr", sessionId: "s1" });
  await say({ type: "openWorktree", sessionId: "s1" });
  expect(events).toEqual([["desktop/open-external", "https://github.com/o/r/pull/7"], ["desktop/reveal", "/work/tom-1"]]);

  // The layout is remembered for the project; asked once about herdr, the answer sticks.
  const layout = { type: "split" as const, id: "x", direction: "row" as const, ratio: 0.4, a: { type: "leaf" as const, id: "c1", sessionId: "s1" }, b: { type: "leaf" as const, id: "c2", sessionId: null } };
  await say({ type: "layout", layout });
  await say({ type: "switchTerminal", switch: true });
  expect((w.ctx.settings.get().codeLink as { terminal: string }).terminal).toBe("herdr");
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toEqual({ layouts: { [w.project.id]: layout }, asked: true });
  expect(win.states.at(-1)).toMatchObject({ askSwitch: false, terminal: "herdr" });

  await say({ type: "detach", cell: "c1" });
  expect(live.closed).toBe(true);
  await say({ type: "attach", cell: "c2", sessionId: "s1", cols: 80, rows: 24 });
  win.spec.onClose();
  expect(streams.at(-1)!.closed).toBe(true);
  // Closed: the next open is a new window, with the remembered layout.
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  expect(opened).toHaveLength(2);
  expect(opened[1]!.states[0]!.layout).toEqual(layout);
  // Closed and opened again, as often as the person likes; each time it comes forward.
  for (let i = 0; i < 3; i++) {
    opened.at(-1)!.spec.onClose();
    await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
    await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
    expect(opened.at(-1)!.focused).toBe(1);
  }
  expect(opened).toHaveLength(5);
  // An open that fails leaves nothing behind: the next one opens a window.
  opened.at(-1)!.spec.onClose();
  failNext = true;
  await expect(w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id })).rejects.toThrow("no window");
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  expect(opened).toHaveLength(6);
});

it("opens plain terminals in herdr without code link, keeps them, closes them, and still opens when sessions cannot be read", async () => {
  const fake = new FakeHerdr();
  const opened: { spec: { onMessage(m: unknown): void; onClose(): void; initialState: unknown }; states: WindowState[]; posts: WindowPost[] }[] = [];
  const attached: string[] = [];
  let sessionsBroken = false;
  const repo = fs.mkdtempSync(path.join(dir, "repo-"));

  class FakeSurfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
    open(spec: (typeof opened)[number]["spec"]) {
      const entry = { spec, states: [spec.initialState as WindowState], posts: [] as WindowPost[] };
      opened.push(entry);
      return { id: "s", capabilities: { programmaticPosition: true, forwardedMouseMoves: false }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, focus() {}, setState: (s: WindowState) => void entry.states.push(s), post: (m: WindowPost) => void entry.posts.push(m), close: () => spec.onClose() };
    }
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => {
      if (sessionsBroken) throw new Error("bad session row");
      return [];
    };
    links = () => [];
    repositoriesOf = () => [{ workstream: "Main", name: "tomrade", path: repo, defaultBranch: "main" }];
    herdrInstall = async () => ({ command: null, guide: "" });
  }

  const stateFile = path.join(dir, "terminals.json");
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings-t.json") }], Contributions, FakeSurfaces, [Herdr, { socket: fake.socket, bin: path.join(dir, "absent"), reconnectMs: 30 }], FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile }]] });
  const herdr = w.ctx.get("herdr")!;
  herdr.bridge = async () => ({ state: "ready", version: "0.9.5" });
  herdr.terminal = async (pane: string) => {
    attached.push(pane);
    return { paneId: pane, mode: "control", closed: false, onFrame: () => () => {}, onClose: () => () => {}, input() {}, resize() {}, scroll() {}, mouse() {}, close() {} } as never;
  };
  await settle();

  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  expect(win.states[0]!).toMatchObject({ terminals: [], places: [{ label: "tomrade", cwd: repo }], warning: null });
  const say = async (m: WindowMessage) => {
    win.spec.onMessage(m);
    await settle();
    await new Promise((r) => setTimeout(r, 50));
  };

  // A new terminal: a plain shell in a tab of the project's workspace, nothing typed into it.
  await say({ type: "newTerminal", terminalId: "t1", cwd: repo });
  expect(fake.of("workspace.create")).toEqual([{ cwd: repo, label: w.project.name, focus: false }]);
  expect(fake.of("pane.send_input")).toEqual([]);
  expect(win.states.some((s) => s.terminals.some((t) => t.id === "t1" && t.pane === null))).toBe(true);
  expect(win.states.at(-1)!.terminals).toEqual([expect.objectContaining({ id: "t1", title: path.basename(repo), cwd: repo, pane: "w1:p1" })]);
  await say({ type: "attach", cell: "c1", sessionId: "t1", cols: 80, rows: 24 });
  expect(attached).toEqual(["w1:p1"]);

  // Kept: a window opened later lists it again.
  win.spec.onClose();
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  expect(opened[1]!.states[0]!.terminals).toEqual([expect.objectContaining({ id: "t1", pane: "w1:p1" })]);

  // Sessions that cannot be read are a warning; a terminal still opens.
  sessionsBroken = true;
  const next = opened[1]!;
  next.spec.onMessage({ type: "newTerminal", terminalId: "t2", cwd: null });
  await settle();
  await new Promise((r) => setTimeout(r, 50));
  expect(next.states.at(-1)).toMatchObject({ sessions: [], warning: expect.any(String) });
  expect(next.states.at(-1)!.terminals.map((t) => t.id)).toEqual(["t1", "t2"]);
  sessionsBroken = false;

  // Closed by the person: the pane ends and the terminal is forgotten. One whose pane went is forgotten too.
  next.spec.onMessage({ type: "closeTerminal", terminalId: "t1" });
  await settle();
  await new Promise((r) => setTimeout(r, 50));
  expect(fake.of("pane.close")).toEqual([{ pane_id: "w1:p1" }]);
  fake.exit(next.states.at(-1)!.terminals[0]!.pane!);
  next.spec.onMessage({ type: "refresh" });
  await settle();
  await new Promise((r) => setTimeout(r, 50));
  expect(next.states.at(-1)!.terminals).toEqual([]);

  // herdr gone: the window says so, nothing is kept.
  fake.stop();
  next.spec.onMessage({ type: "newTerminal", terminalId: "t3", cwd: repo });
  await settle();
  await new Promise((r) => setTimeout(r, 200));
  expect(next.posts.at(-1)).toMatchObject({ type: "toast" });
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).terminals[w.project.id]).toEqual([]);
});
