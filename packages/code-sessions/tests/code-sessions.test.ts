import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { Service, type Context } from "cordis";
import { EventEmitter } from "node:events";
import CodeSessions, { openSystemTerminal, sessionRows, type Layout, type WindowMessage, type WindowPost, type WindowState } from "@tomradex/code-sessions";
import { Contributions } from "@tomradex/contributions";
import { Settings } from "@tomradex/settings";
import { Herdr } from "@tomradex/herdr";
import { FakeHerdr, fresh, settle } from "@tomradex/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-sessions-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

type Session = { id: string; itemIds: string[]; branch: string; state: string; mode: "headless" | "terminal"; agent: string; herdrPane: string | null; terminal: string | null; device: string; threadId: string | null; worktree: string | null; activity: string | null; summary: string | null; blocked: unknown; startedAt: number; endedAt: number | null; lastEventAt: number | null };

const session = (over: Partial<Session> & { id: string }): Session => ({ itemIds: [], branch: "b", state: "running", mode: "terminal", agent: "claude-code", herdrPane: null, terminal: null, device: "here", threadId: null, worktree: null, activity: null, summary: null, blocked: null, startedAt: 1, endedAt: null, lastEventAt: null, ...over });

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

it("says where a session's terminal is: herdr here, another app here by name, another computer, or Tomrade", () => {
  const sessions = [
    session({ id: "herdr", herdrPane: "w1:p1", startedAt: 6 }),
    session({ id: "iterm", terminal: "iTerm.app", startedAt: 5 }),
    session({ id: "odd", terminal: "SomeTerm", startedAt: 4 }),
    session({ id: "unsaid", startedAt: 3 }),
    session({ id: "away", device: "laptop", terminal: "iTerm.app", startedAt: 2 }),
    session({ id: "run", mode: "headless", threadId: "t", startedAt: 1 })
  ];
  const rows = (platform: NodeJS.Platform) => sessionRows({ sessionsOf: () => sessions as never, links: () => [] }, { get: () => null }, "p", Date.now(), "here", platform);
  expect(rows("darwin").map((r) => [r.id, r.where, r.terminal, r.switchable])).toEqual([
    ["herdr", "herdr", null, false],
    ["iterm", "outside", "iTerm2", true],
    ["odd", "outside", "SomeTerm", false],
    ["unsaid", "outside", null, false],
    ["away", "elsewhere", "iTerm2", false],
    ["run", "tomrade", null, false]
  ]);
  // Only macOS brings an app forward from here.
  expect(rows("linux").find((r) => r.id === "iterm")!.switchable).toBe(false);
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
  expect(win.spec).toMatchObject({ id: `code-sessions.${w.project.id}`, kind: "window", url: "file:///ui/code-sessions.html", minWidth: 640, minHeight: 400, title: `Terminal — ${w.project.name}` });
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

it("shows a terminal as the code session its agent claimed, in place, and as a plain terminal again once the claim goes", async () => {
  const fake = new FakeHerdr();
  const opened: { spec: { onMessage(m: unknown): void; onClose(): void; initialState: unknown }; states: WindowState[] }[] = [];
  const sessions: Session[] = [];
  const patched: [string, unknown][] = [];

  class FakeSurfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
    open(spec: (typeof opened)[number]["spec"]) {
      const entry = { spec, states: [spec.initialState as WindowState] };
      opened.push(entry);
      return { id: "s", capabilities: { programmaticPosition: true, forwardedMouseMoves: false }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, focus() {}, setState: (s: WindowState) => void entry.states.push(s), post() {}, close: () => spec.onClose() };
    }
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => sessions;
    links = () => [];
    repositoriesOf = () => [];
    herdrInstall = async () => ({ command: null, guide: "" });
    store = {
      patchSession: (_projectId: string, id: string, patch: { herdrPane?: string }) => {
        patched.push([id, patch]);
        Object.assign(sessions.find((s) => s.id === id)!, patch);
      }
    };
  }

  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings-f.json") }], Contributions, FakeSurfaces, [Herdr, { socket: fake.socket, bin: path.join(dir, "absent"), reconnectMs: 30 }], FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile: path.join(dir, "fold.json") }]] });
  w.ctx.get("herdr")!.bridge = async () => ({ state: "ready", version: "0.9.5" });
  const ticket = w.ctx.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Claimed here", workType: "coding", status: "doing", by: "human" });
  await settle();
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  const now = async () => {
    win.spec.onMessage({ type: "refresh" });
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    return win.states.at(-1)!.terminals;
  };
  for (const id of ["t1", "t2", "t3"]) {
    win.spec.onMessage({ type: "newTerminal", terminalId: id, cwd: dir });
    await settle();
    await new Promise((r) => setTimeout(r, 50));
  }
  const pane = Object.fromEntries((await now()).map((t) => [t.id, t.pane!]));
  expect((await now()).map((t) => [t.id, t.sessionId, t.note])).toEqual([["t1", null, null], ["t2", null, null], ["t3", null, null]]);

  // Claude Code with the repo's hooks: its session reports the pane; before the claim it holds no ticket and stays plain.
  sessions.push(session({ id: "hooked", herdrPane: pane.t1!, startedAt: 2 }));
  expect((await now()).find((t) => t.id === "t1")!.sessionId).toBeNull();
  sessions[0]!.itemIds = [ticket.id];
  expect((await now()).find((t) => t.id === "t1")!.sessionId).toBe("hooked");
  // The claim let go: a plain terminal again, still there.
  sessions[0]!.itemIds = [];
  expect((await now()).find((t) => t.id === "t1")).toMatchObject({ sessionId: null, pane: pane.t1 });
  sessions[0]!.itemIds = [ticket.id];
  sessions[0]!.state = "ended";
  expect((await now()).find((t) => t.id === "t1")!.sessionId).toBeNull();

  // An agent known only by its MCP connection: two terminals run agents, so neither is guessed — both say why.
  fake.setStatus(pane.t2!, "cursor", "working");
  fake.setStatus(pane.t3!, "cursor", "idle");
  sessions.push(session({ id: "hookless", agent: "mcp", itemIds: [ticket.id], startedAt: 3 }));
  const unsure = await now();
  expect(unsure.filter((t) => t.note).map((t) => t.id)).toEqual(["t2", "t3"]);
  expect(unsure.every((t) => !t.sessionId) && patched.length === 0).toBe(true);
  // One of them ends: the claim is the other's, and the session learns its pane.
  fake.exit(pane.t3!);
  const sure = await now();
  expect(sure.map((t) => [t.id, t.sessionId, t.note])).toEqual([["t1", null, null], ["t2", "hookless", null]]);
  expect(patched).toEqual([["hookless", { herdrPane: pane.t2 }]]);

  // Gemini CLI: herdr does not know it, its command does. Outside the session's worktree it is not taken.
  sessions[1]!.state = "ended";
  fake.panes.get(pane.t2!)!.agent = null;
  fake.panes.get(pane.t1!)!.foreground = { cmdline: "node /opt/homebrew/bin/gemini", cwd: dir };
  sessions.push(session({ id: "gemini", agent: "mcp", itemIds: [ticket.id], startedAt: 4, worktree: "/somewhere/else" }));
  expect((await now()).find((t) => t.id === "t1")).toMatchObject({ sessionId: null, note: expect.any(String) });
  sessions[2]!.worktree = dir;
  expect((await now()).find((t) => t.id === "t1")).toMatchObject({ sessionId: "gemini", note: null });
});

it("keeps named layouts and the auto-place switch for every window, and starts from one cell when the saved state is broken", async () => {
  const opened: { spec: { onMessage(m: unknown): void; onClose(): void; initialState: unknown }; states: WindowState[] }[] = [];
  class FakeSurfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
    open(spec: (typeof opened)[number]["spec"]) {
      const entry = { spec, states: [spec.initialState as WindowState] };
      opened.push(entry);
      return { id: "s", capabilities: { programmaticPosition: true, forwardedMouseMoves: false }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, focus() {}, setState: (s: WindowState) => void entry.states.push(s), post() {}, close: () => spec.onClose() };
    }
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => [];
    links = () => [];
    repositoriesOf = () => [];
    herdrInstall = async () => ({ command: null, guide: "" });
  }
  const stateFile = path.join(dir, "presets.json");
  fs.writeFileSync(stateFile, "{ not json");
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings-p.json") }], Contributions, FakeSurfaces, FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile }]] });
  await settle();

  // Broken: one cell and a warning, and the window opens all the same.
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  expect(win.states[0]).toMatchObject({ layout: { type: "leaf", sessionId: null }, presets: [], defaultPreset: null, autoPlace: true, warning: expect.any(String) });
  const say = async (m: WindowMessage) => {
    win.spec.onMessage(m);
    await settle();
  };

  // Saved under a name with its sessions left out; renamed, made the default, then deleted.
  const grid: Layout = { type: "split", id: "g", direction: "row", ratio: 0.3, a: { type: "leaf", id: "a", sessionId: "s1" }, b: { type: "leaf", id: "b", sessionId: "t1" } };
  await say({ type: "savePreset", name: "  Two  ", layout: grid });
  const saved = win.states.at(-1)!;
  expect(saved.warning).toBeNull();
  expect(saved.presets).toEqual([{ id: expect.any(String), name: "Two", layout: { ...grid, a: { ...grid.a, sessionId: null }, b: { ...grid.b, sessionId: null } } }]);
  const id = saved.presets[0]!.id;
  await say({ type: "renamePreset", id, name: "Side by side" });
  await say({ type: "renamePreset", id, name: "   " });
  await say({ type: "defaultPreset", id });
  await say({ type: "autoPlace", on: false });
  expect(win.states.at(-1)).toMatchObject({ presets: [{ id, name: "Side by side" }], defaultPreset: id, autoPlace: false });

  // Another project, with no layout of its own, opens with the default preset.
  const other = w.ctx.projects.create({ name: "Other", keyPrefix: "OTH" });
  await w.ctx.contributions.run("code-sessions.open", { projectId: other.id });
  expect(opened[1]!.states[0]!.layout).toMatchObject({ type: "split", ratio: 0.3 });
  // A layout that is not one is never kept; deleting the default preset clears it.
  await say({ type: "layout", layout: { type: "split", id: "x" } as unknown as Layout });
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).layouts).toBeUndefined();
  await say({ type: "deletePreset", id });
  expect(win.states.at(-1)).toMatchObject({ presets: [], defaultPreset: null });
});

it("opens the system terminal where herdr cannot show one: Windows Terminal in the folder, else PowerShell, nothing elsewhere", async () => {
  const calls: [string, string[], { cwd?: string }][] = [];
  const launcher = (missing: string[]) =>
    ((command: string, args: string[], options: { cwd?: string }) => {
      calls.push([command, args, options]);
      const child = Object.assign(new EventEmitter(), { unref() {} });
      setImmediate(() => (missing.includes(command) ? child.emit("error", Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" })) : child.emit("spawn")));
      return child;
    }) as never;
  expect(await openSystemTerminal("C:\\work", "win32", launcher([]))).toBe("Windows Terminal");
  expect(calls).toEqual([["wt.exe", ["-d", "C:\\work"], expect.objectContaining({ cwd: "C:\\work", detached: true })]]);
  calls.length = 0;
  expect(await openSystemTerminal("C:\\work", "win32", launcher(["wt.exe"]))).toBe("PowerShell");
  expect(calls.map((c) => [c[0], c[2].cwd])).toEqual([["wt.exe", "C:\\work"], ["powershell.exe", "C:\\work"]]);
  calls.length = 0;
  await expect(openSystemTerminal("/work", "darwin", launcher([]))).rejects.toThrow("no system terminal fallback");
  expect(calls).toEqual([]);
});

it("names Windows Terminal and Git Bash, and offers no switching to them", () => {
  const sessions = [session({ id: "wt", terminal: "WindowsTerminal", startedAt: 2 }), session({ id: "bash", terminal: "mintty", startedAt: 1 })];
  const rows = sessionRows({ sessionsOf: () => sessions as never, links: () => [] }, { get: () => null }, "p", Date.now(), "here", "darwin");
  expect(rows.map((r) => [r.id, r.where, r.terminal, r.switchable])).toEqual([
    ["wt", "outside", "Windows Terminal", false],
    ["bash", "outside", "Git Bash", false]
  ]);
});
