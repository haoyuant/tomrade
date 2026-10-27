import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
import { Service, type Context } from "cordis";
import { EventEmitter } from "node:events";
import type { ReviewRow } from "@tomradex/code-link";
import CodeSessions, { continuedIn, needingYou, openSystemTerminal, sessionRows, type Layout, type WindowMessage, type WindowPost, type WindowState } from "@tomradex/code-sessions";
import { Contributions } from "@tomradex/contributions";
import { Settings } from "@tomradex/settings";
import { Herdr, HerdrError } from "@tomradex/herdr";
import { FakeHerdr, fresh, settle } from "@tomradex/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-sessions-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

type Session = { title?: string | null; prompted?: boolean; externalId?: string | null; cwd?: string | null; id: string; itemIds: string[]; branch: string; state: string; mode: "headless" | "terminal"; agent: string; herdrPane: string | null; terminal: string | null; device: string; threadId: string | null; worktree: string | null; activity: string | null; summary: string | null; blocked: unknown; startedAt: number; endedAt: number | null; lastEventAt: number | null };

const session = (over: Partial<Session> & { id: string }): Session => ({ itemIds: [], branch: "b", state: "running", mode: "terminal", agent: "claude-code", herdrPane: null, terminal: null, device: "here", threadId: null, worktree: null, activity: null, summary: null, blocked: null, startedAt: 1, endedAt: null, lastEventAt: null, ...over });

/** A row of code link's look back, as its list answers: History's pages come from there. */
const reviewRow = (id: string, endedAt: number, over: Partial<ReviewRow> = {}): ReviewRow => ({ id, kind: "session", agent: "claude-code", title: "", tickets: [], asked: null, commits: 0, pr: null, said: null, where: "pane", threadId: null, resumable: false, startedAt: 1, endedAt, ...over });

it("lists live sessions first, needs-you before the rest, then every ended one with when it ended", () => {
  const now = 10 * 24 * 3600_000;
  const sessions = [
    session({ id: "old", state: "ended", endedAt: now - 2 * 24 * 3600_000, startedAt: 1 }),
    session({ id: "done", state: "ended", endedAt: now - 3600_000, startedAt: 2, herdrPane: "w1:p9" }),
    session({ id: "busy", itemIds: ["i1"], startedAt: 5, herdrPane: "w1:p1", branch: "tom-1/x" }),
    session({ id: "asks", state: "waiting", blocked: { kind: "permission" }, startedAt: 3, mode: "headless", threadId: "t1", summary: "May I?" })
  ];
  const rows = sessionRows({ sessionsOf: () => sessions as never, links: () => [{ branch: "tom-1/x", prUrl: "https://example.com/pr/1" }] as never }, { get: (_p, id) => (id === "i1" ? { key: "TOM-1", title: "One" } : null) }, "p", now);
  expect(rows.map((r) => r.id)).toEqual(["asks", "busy", "done", "old"]);
  expect(rows.map((r) => r.endedAt)).toEqual([null, null, now - 3600_000, now - 2 * 24 * 3600_000]);
  expect(rows[0]).toMatchObject({ needsYou: true, mode: "run", activity: "May I?", threadId: "t1" });
  expect(rows[1]).toMatchObject({ key: "TOM-1", title: "One", pane: "w1:p1", prUrl: "https://example.com/pr/1", mode: "terminal" });
  // An ended session's pane is no terminal to attach to.
  expect(rows[2]).toMatchObject({ pane: null, state: "ended" });
});

it("reads a session blocked on its merge as needing the person, and one that errored as stopped", () => {
  const rows = sessionRows({ sessionsOf: () => [session({ id: "merge", state: "error", blocked: "merge", summary: "merge blocked: CI", startedAt: 2 }), session({ id: "crash", state: "error", startedAt: 3 })] as never, links: () => [] }, { get: () => null }, "p", Date.now());
  expect(rows.map((r) => [r.id, r.needsYou, r.state])).toEqual([["merge", true, "error"], ["crash", false, "error"]]);
});

it("counts the sessions that need the person as their rows do, and reads each ticket once however many sessions name it", () => {
  const sessions = [
    session({ id: "asks", itemIds: ["i1"], state: "waiting", blocked: { kind: "permission" }, startedAt: 4 }),
    session({ id: "merge", itemIds: ["i1"], state: "error", blocked: "merge", startedAt: 3 }),
    session({ id: "gone", itemIds: ["i1"], state: "ended", blocked: "merge", startedAt: 2 }),
    session({ id: "busy", itemIds: ["i2"], startedAt: 1 })
  ];
  const codeLink = { sessionsOf: () => sessions as never, links: () => [] };
  const asked: string[] = [];
  const rows = sessionRows(codeLink, { get: (_p, id) => (asked.push(id), { key: id, title: id }) }, "p");
  expect(needingYou(codeLink, "p")).toBe(rows.filter((r) => r.needsYou).length);
  expect(needingYou(codeLink, "p")).toBe(2);
  expect(asked).toEqual(["i1", "i2"]);
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
  const scrolls = new Map<string, (s: { offset: number; max: number; rows: number }) => void>();
  const scrolledTo: [string, number][] = [];
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
    static provide = "terminals";
    readonly kind = "herdr" as const;
    constructor(ctx: Context) {
      super(ctx, "terminals");
    }
    onPane = () => () => {};
    watch = () => () => {};
    watching = (): string[] => [];
    bridge = async () => ({ state: "ready" as const, version: "0.9.5" });
    clientAttached = async () => false;
    terminal = async (pane: string, size: unknown) => {
      const frames = new Set<(f: unknown) => void>();
      const entry = { pane, size, sent: [] as unknown[], closed: false, frame: (text: string, at: { width?: number; height?: number; full?: boolean } = {}) => frames.forEach((l) => l({ seq: 1, width: at.width ?? 80, height: at.height ?? 24, full: at.full ?? true, bytes: new Uint8Array(Buffer.from(text)) })) };
      streams.push(entry);
      return { paneId: pane, mode: "control", closed: false, onFrame: (l: (f: unknown) => void) => (frames.add(l), () => frames.delete(l)), onClose: () => () => {}, input: (d: unknown) => entry.sent.push(["input", d]), key: (k: unknown) => entry.sent.push(["key", k]), resize: (c: number, r: number) => entry.sent.push(["resize", c, r]), scroll: (s: unknown) => entry.sent.push(["scroll", s]), mouse: (m: unknown) => entry.sent.push(["mouse", m]), close: () => void (entry.closed = true) };
    };
    onScroll = (pane: string, listener: (s: { offset: number; max: number; rows: number }) => void) => (scrolls.set(pane, listener), () => scrolls.delete(pane));
    scrollTo = async (pane: string, offset: number) => (scrolledTo.push([pane, offset]), true);
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
    conversation = (_projectId: string, id: string, before?: number) =>
      id !== "s1" ? null : before === undefined ? { lines: [{ who: "person" as const, text: "侧栏怎么分组？" }], cut: true, start: 900 } : { lines: [{ who: "person" as const, text: "最早的一句" }], cut: false, start: 0 };
  }

  const stateFile = path.join(dir, "state.json");
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings.json") }], Contributions, FakeSurfaces, FakeHerdr, FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile }]] });
  const ticket = w.ctx.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Window work", workType: "coding", status: "doing", by: "human" });
  sessions[0]!.itemIds = [ticket.id];
  for (const name of ["desktop/open", "desktop/open-external", "desktop/reveal", "desktop/open-path"] as const) w.ctx.on(name, (arg: unknown) => void events.push([name, arg]));
  w.ctx.contributions.command({ id: "code-link.start-terminal", title: "Start", run: (scope) => (commands.push(["start", scope]), { toast: "continuing" }) });
  w.ctx.settings.set({ ...w.ctx.settings.get(), codeLink: { ...(w.ctx.settings.get().codeLink as object), terminal: "iTerm" } });
  await settle();

  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  expect(win.spec).toMatchObject({ id: `code-sessions.${w.project.id}`, kind: "window", url: "file:///ui/code-sessions.html", minWidth: 640, minHeight: 400, title: `${w.project.name} — Terminal` });
  const first = win.states[0]!;
  expect(first).toMatchObject({ projectId: w.project.id, bridge: { state: "ready" }, askSwitch: true, terminal: "iTerm", layout: { type: "leaf", sessionId: null } });
  expect(first.sessions).toEqual([expect.objectContaining({ id: "s1", key: ticket.key, title: "Window work", pane: "w1:p1" })]);
  // Opening it again brings the same window forward with fresh state.
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  expect(opened).toHaveLength(1);
  expect(win.focused).toBe(1);
  // A start that names no project (Tomrade opening on the Terminal window) goes to the one it showed last.
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).lastProject).toBe(w.project.id);
  await w.ctx.contributions.run("code-sessions.open", {});
  expect(opened).toHaveLength(1);
  expect(win.focused).toBe(2);

  const say = async (m: WindowMessage) => {
    win.spec.onMessage(m);
    await settle();
  };
  // A batch goes 16ms after its first frame, and this waits past it.
  const batched = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
  // An attach that a newer one overtakes lets its stream go; what was typed meanwhile reaches the one that stays.
  win.spec.onMessage({ type: "attach", cell: "c1", sessionId: "s1", cols: 100, rows: 30 });
  win.spec.onMessage({ type: "attach", cell: "c1", sessionId: "s1", cols: 120, rows: 40 });
  win.spec.onMessage({ type: "input", cell: "c1", data: "输入法" });
  // A key that has no stream to go to yet is typed as the Enter it reads as.
  await say({ type: "key", cell: "c1", key: "shift+enter" });
  expect(streams.map((s) => [s.size, s.closed])).toEqual([[{ cols: 100, rows: 30 }, true], [{ cols: 120, rows: 40 }, false]]);
  expect(streams[0]!.sent).toEqual([]);
  expect(streams[1]!.sent).toEqual([["input", "输入法\r"]]);
  streams[1]!.sent.length = 0;
  const live = streams[1]!;
  // A burst reaches the window as one message: the bytes joined in order, nothing dropped.
  live.frame("hel");
  live.frame("lo");
  await batched();
  const drawn = win.posts.filter((p) => p.type === "frame");
  expect(drawn).toHaveLength(1);
  expect(drawn[0]).toMatchObject({ type: "frame", cell: "c1", seq: 1, width: 80, height: 24, full: true });
  expect(Buffer.from(drawn[0]!.bytes).toString()).toBe("hello");
  // Another size paints another screen: what waited goes first, under the paint it started with.
  live.frame("x", { width: 100, full: false });
  live.frame("y", { width: 100, full: false });
  await batched();
  expect(win.posts.filter((p) => p.type === "frame").map((p) => [p.width, p.full, Buffer.from(p.bytes).toString()])).toEqual([
    [80, true, "hello"],
    [100, false, "xy"]
  ]);
  await say({ type: "input", cell: "c1", data: "ls\r" });
  await say({ type: "key", cell: "c1", key: "ctrl+enter" });
  await say({ type: "resize", cell: "c1", cols: 90, rows: 20 });
  await say({ type: "scroll", cell: "c1", direction: "up", lines: 3 });
  expect(live.sent).toEqual([["input", "ls\r"], ["key", "ctrl+enter"], ["resize", 90, 20], ["scroll", { type: "scroll", cell: "c1", direction: "up", lines: 3 }]]);
  // The pane's place in its scrollback reaches the cell's scrollbar; dragging it moves the pane.
  // A frame still waiting goes before it: the window draws what was painted before what is said about it.
  live.frame("tail", { full: false });
  scrolls.get("w1:p1")!({ offset: 3, max: 278, rows: 20 });
  expect(win.posts.at(-2)).toMatchObject({ type: "frame", cell: "c1", full: false });
  expect(Buffer.from((win.posts.at(-2) as { bytes: Uint8Array }).bytes).toString()).toBe("tail");
  expect(win.posts.at(-1)).toEqual({ type: "scrolled", cell: "c1", offset: 3, max: 278, rows: 20 });
  await say({ type: "scrollTo", cell: "c1", offset: 120 });
  await say({ type: "scrollTo", cell: "nowhere", offset: 1 });
  expect(scrolledTo).toEqual([["w1:p1", 120]]);
  // Dropped files are typed as one paste of their paths.
  await say({ type: "drop", cell: "c1", paths: ["/work/a b.png", "/work/c"] });
  expect(live.sent.at(-1)).toEqual(["input", "\x1b[200~/work/a\\ b.png /work/c \x1b[201~"]);

  // An ended session's cell asks for its conversation, read from its agent's own record.
  await say({ type: "conversation", cell: "c2", sessionId: "s1" });
  expect(win.posts.at(-1)).toEqual({ type: "conversation", cell: "c2", sessionId: "s1", lines: [{ who: "person", text: "侧栏怎么分组？" }], cut: true, start: 900, before: null });
  // Scrolled to its top: what came before, which reaches the start.
  await say({ type: "conversation", cell: "c2", sessionId: "s1", before: 900 });
  expect(win.posts.at(-1)).toEqual({ type: "conversation", cell: "c2", sessionId: "s1", lines: [{ who: "person", text: "最早的一句" }], cut: false, start: null, before: 900 });
  await say({ type: "conversation", cell: "c2", sessionId: "nobody" });
  expect(win.posts.at(-1)).toEqual({ type: "conversation", cell: "c2", sessionId: "nobody", lines: null, cut: false, start: null, before: null });

  // The toolbar: continue through code link, the PR in the browser, the worktree in Finder.
  await say({ type: "continue", sessionId: "s1" });
  expect(commands).toEqual([["start", { projectId: w.project.id, itemId: ticket.id }]]);
  expect(win.posts.at(-1)).toEqual({ type: "toast", text: "continuing" });
  await say({ type: "openPr", sessionId: "s1" });
  await say({ type: "openWorktree", sessionId: "s1" });
  // A link clicked in a terminal goes to the system browser too.
  await say({ type: "openLink", url: "https://example.com/docs" });
  expect(events).toEqual([["desktop/open-external", "https://github.com/o/r/pull/7"], ["desktop/reveal", "/work/tom-1"], ["desktop/open-external", "https://example.com/docs"]]);

  events.length = 0;
  const report = path.join(os.tmpdir(), "report draft.pdf");
  const source = path.join(os.tmpdir(), "source.ts");
  await say({ type: "openLink", url: pathToFileURL(report).href });
  await say({ type: "openLink", url: `${source}:12:3` });
  await say({ type: "openLink", url: "~/report.pdf" });
  await say({ type: "openLink", url: "file://[invalid/report.pdf" });
  await say({ type: "openLink", url: "file:///tmp/bad%ZZ" });
  await say({ type: "openLink", url: "javascript:alert(1)" });
  await say({ type: "openLink", url: "relative/path.pdf" });
  expect(events).toEqual([
    ["desktop/open-path", report],
    ["desktop/open-path", source],
    ["desktop/open-path", path.join(os.homedir(), "report.pdf")]
  ]);

  // The layout is remembered for the project; asked once about herdr, the answer sticks.
  const layout = { type: "split" as const, id: "x", direction: "row" as const, ratio: 0.4, a: { type: "leaf" as const, id: "c1", sessionId: "s1" }, b: { type: "leaf" as const, id: "c2", sessionId: null } };
  await say({ type: "layout", layout });
  await say({ type: "switchTerminal", switch: true });
  expect((w.ctx.settings.get().codeLink as { terminal: string }).terminal).toBe("herdr");
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toEqual({ layouts: { [w.project.id]: layout }, asked: true, lastProject: w.project.id });
  expect(win.states.at(-1)).toMatchObject({ askSwitch: false, terminal: "herdr" });

  // One pane, one cell: another cell asking for the pane c1 streams is told where it is, and c1 keeps it.
  await say({ type: "attach", cell: "c2", sessionId: "s1", cols: 80, rows: 24 });
  expect(win.posts.at(-1)).toEqual({ type: "shownIn", cell: "c2", other: "c1" });
  expect(streams).toHaveLength(2);
  expect(live.closed).toBe(false);
  // Moved there on purpose (the saved layout shows it in c2 now): c1 lets it go and c2 streams it.
  const moved = { ...layout, a: { ...layout.a, sessionId: null }, b: { ...layout.b, sessionId: "s1" } };
  await say({ type: "layout", layout: moved });
  await say({ type: "attach", cell: "c2", sessionId: "s1", cols: 80, rows: 24 });
  expect(streams.map((x) => x.closed)).toEqual([true, true, false]);
  await say({ type: "layout", layout });
  await say({ type: "detach", cell: "c2" });
  await say({ type: "detach", cell: "c1" });
  expect(live.closed).toBe(true);
  // Typed while attaching, then the cell goes: the window says it was not sent.
  win.spec.onMessage({ type: "attach", cell: "c2", sessionId: "s1", cols: 80, rows: 24 });
  win.spec.onMessage({ type: "input", cell: "c2", data: "lost" });
  await say({ type: "detach", cell: "c2" });
  expect(win.posts.at(-1)).toEqual({ type: "toast", text: "What you typed while the terminal was connecting was not sent" });
  await say({ type: "attach", cell: "c2", sessionId: "s1", cols: 80, rows: 24 });
  expect(streams.at(-1)!.sent).toEqual([]);
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

it("keeps an ended session a cell shows, answers History a page at a time with the rows behind it, says when it changes while open, and remembers the fold per project", async () => {
  const opened: { spec: { onMessage(m: unknown): void; onClose(): void; initialState: unknown }; states: WindowState[]; posts: WindowPost[] }[] = [];
  const now = Date.now();
  const sessions = [
    session({ id: "live", herdrPane: "w1:p1", startedAt: 5 }),
    session({ id: "iterm", terminal: "iTerm.app", startedAt: 4 }),
    session({ id: "shown", state: "ended", endedAt: now - 5000, startedAt: 3, prompted: true }),
    session({ id: "old", state: "ended", endedAt: now - 30 * 24 * 3600_000, startedAt: 1, title: "上个月的方案讨论", externalId: "old-1" }),
    session({ id: "lost", itemIds: ["i9"], state: "lost", endedAt: now - 60_000, startedAt: 2, mode: "headless", threadId: "t" }),
    // Started and left without a word: not kept.
    session({ id: "empty", state: "ended", endedAt: now - 1000, startedAt: 4 })
  ];
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
  class ReadyHerdr extends Service {
    static provide = "terminals";
    readonly kind = "herdr" as const;
    constructor(ctx: Context) {
      super(ctx, "terminals");
    }
    onPane = () => () => {};
    watch = () => () => {};
    watching = (): string[] => [];
    bridge = async () => ({ state: "ready" as const, version: "0.9.5" });
    clientAttached = async () => false;
    panes = async () => [];
  }
  // Code link's look back answers the pages; the plugin adds the window's rows behind them.
  const asked: unknown[] = [];
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => sessions;
    links = () => [];
    repositoriesOf = () => [];
    repositoryFoldersOf = this.repositoriesOf;
    review = {
      list: (_projectId: string, opts: unknown) => {
        asked.push(opts);
        return { rows: [reviewRow("shown", now - 5000), reviewRow("lost", now - 60_000, { where: "panel" }), reviewRow("old", now - 30 * 24 * 3600_000, { title: "上个月的方案讨论", resumable: true })], next: null };
      },
      saidIn: async () => ({ rows: [], said: {} })
    };
  }
  const stateFile = path.join(dir, "history-page-state.json");
  const shown: Layout = { type: "split", id: "r", direction: "row", ratio: 0.5, a: { type: "leaf", id: "c1", sessionId: "live" }, b: { type: "leaf", id: "c2", sessionId: "shown" } };
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "history-page-settings.json") }], Contributions, FakeSurfaces, ReadyHerdr, FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile }]] });
  fs.writeFileSync(stateFile, JSON.stringify({ layouts: { [w.project.id]: shown } }));
  for (const s of sessions) s.device = w.ctx.hub.deviceId;
  await settle();
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  const say = async (m: WindowMessage) => {
    win.spec.onMessage(m);
    await settle();
  };
  // Live ones, an outside one among them, and the ended one a cell shows; the rest are History's, not the state's.
  expect(win.states[0]!.sessions.map((s) => s.id)).toEqual(["live", "iterm", "shown"]);
  expect(win.states[0]).toMatchObject({ folded: false });
  expect(win.states[0]).not.toHaveProperty("archive");
  expect(win.states[0]!.sessions.find((s) => s.id === "iterm")).toMatchObject({ where: "outside", terminal: "iTerm2", endedAt: null });

  // A page, with the session rows behind its coding sessions, and the closed terminals with the first page only.
  await say({ type: "history", open: true });
  await say({ type: "historyList", token: 1 });
  const page = win.posts.find((p) => p.type === "historyPage")!;
  expect(page).toMatchObject({ token: 1, terminals: [], agents: {} });
  expect(page.page.rows.map((r) => r.id)).toEqual(["shown", "lost", "old"]);
  expect(page.sessions.map((s) => s.id)).toEqual(["shown", "lost", "old"]);
  // A conversation keeps its name and can be taken up again by its agent.
  expect(page.sessions.find((s) => s.id === "old")).toMatchObject({ conversation: "上个月的方案讨论", resumable: true });
  expect(asked.at(-1)).toEqual({ before: null, query: undefined });
  const cursor = { session: { at: 1, id: "old" }, thread: null, idle: null };
  await say({ type: "historyList", token: 2, before: cursor, query: "方案" });
  expect(win.posts.filter((p) => p.type === "historyPage").at(-1)).toMatchObject({ token: 2, terminals: null });
  expect(asked.at(-1)).toEqual({ before: cursor, query: "方案" });

  // A change while History is open is said once per change; closed, it is not.
  w.ctx.emit("codeLink/changed", w.project.id);
  await settle();
  expect(win.posts.filter((p) => p.type === "historyChanged")).toHaveLength(1);
  await say({ type: "history", open: false });
  w.ctx.emit("codeLink/changed", w.project.id);
  await settle();
  expect(win.posts.filter((p) => p.type === "historyChanged")).toHaveLength(1);

  // Folded for this project only, and still folded when the window opens again.
  await say({ type: "fold", folded: true });
  expect(win.states.at(-1)!.folded).toBe(true);
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).folded).toEqual({ [w.project.id]: true });
  win.spec.onClose();
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  expect(opened[1]!.states[0]).toMatchObject({ folded: true });
});

it("keeps what ran in each pane the window shows before what it shows now, and answers a search of what was said with the rows behind the finds", async () => {
  const opened: { spec: { onMessage(m: unknown): void; onClose(): void; initialState: unknown }; states: WindowState[]; posts: WindowPost[] }[] = [];
  const now = Date.now();
  const sessions = [
    session({ id: "now", agent: "codex", herdrPane: "w1:p1", startedAt: 30 }),
    // Claude Code first, then Codex, in the same pane; and one that ended in a pane no longer shown.
    session({ id: "before", itemIds: ["i1"], herdrPane: "w1:p1", state: "ended", endedAt: now - 5000, startedAt: 20, prompted: true }),
    session({ id: "first", herdrPane: "w1:p1", state: "ended", endedAt: now - 9000, startedAt: 10, prompted: true, title: "最早的一段" }),
    session({ id: "gone", herdrPane: "w9:p9", state: "ended", endedAt: now - 1000, startedAt: 5, prompted: true }),
    session({ id: "quiet", herdrPane: "w1:p1", state: "ended", endedAt: now - 2000, startedAt: 25 })
  ];
  const said: Record<string, string> = { before: "把侧栏分成两组", gone: "侧栏的分组再想想" };
  const searched: string[] = [];
  class FakeSurfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
    open(spec: (typeof opened)[number]["spec"]) {
      const entry = { spec, states: [spec.initialState as WindowState], posts: [] as WindowPost[] };
      opened.push(entry);
      return { id: "s", capabilities: { programmaticPosition: true, forwardedMouseMoves: false }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, focus() {}, setState: (st: WindowState) => void entry.states.push(st), post: (m: WindowPost) => void entry.posts.push(m), close: () => spec.onClose() };
    }
  }
  class ReadyHerdr extends Service {
    static provide = "terminals";
    readonly kind = "herdr" as const;
    constructor(ctx: Context) {
      super(ctx, "terminals");
    }
    onPane = () => () => {};
    watch = () => () => {};
    watching = (): string[] => [];
    bridge = async () => ({ state: "ready" as const, version: "0.9.5" });
    clientAttached = async () => false;
    panes = async () => [];
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => sessions;
    links = () => [];
    repositoriesOf = () => [];
    repositoryFoldersOf = this.repositoriesOf;
    review = {
      list: () => ({ rows: [], next: null }),
      saidIn: async (_projectId: string, query: string) => {
        searched.push(query);
        return { rows: [reviewRow("gone", now - 1000), reviewRow("before", now - 5000)], said };
      }
    };
  }
  const stateFile = path.join(dir, "history-state.json");
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "history-settings.json") }], Contributions, FakeSurfaces, ReadyHerdr, FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile }]] });
  fs.writeFileSync(stateFile, JSON.stringify({ layouts: { [w.project.id]: { type: "leaf", id: "c1", sessionId: "now" } } }));
  for (const s of sessions) s.device = w.ctx.hub.deviceId;
  await settle();
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  const say = async (m: WindowMessage) => {
    win.spec.onMessage(m);
    await settle();
  };
  // The pane Codex runs in now ran Claude Code before: those, oldest first; nothing for a pane the window does not show, nor a start nobody spoke to.
  expect(Object.keys(win.states.at(-1)!.history)).toEqual(["w1:p1"]);
  expect(win.states.at(-1)!.history["w1:p1"]!.map((r) => [r.id, r.ranIn, r.pane])).toEqual([["first", "w1:p1", null], ["before", "w1:p1", null]]);

  // What was said is searched by code link's look back; the finds come back under the ask's token, with the window's rows for them.
  await say({ type: "historySaid", token: 7, query: "侧栏" });
  await vi.waitFor(() => expect(win.posts.some((p) => p.type === "historySaid")).toBe(true));
  expect(searched).toEqual(["侧栏"]);
  const found = win.posts.find((p) => p.type === "historySaid")!;
  expect(found).toMatchObject({ token: 7, found: { rows: [{ id: "gone" }, { id: "before" }], said }, agents: {} });
  expect(found.sessions.map((s) => [s.id, s.ranIn, s.endedAt])).toEqual([["before", "w1:p1", now - 5000], ["gone", "w9:p9", now - 1000]]);
});

it("says where an ended session's pane goes on: a terminal opened on it first, else the newest live session there", () => {
  const now = Date.now();
  const rows = sessionRows({ sessionsOf: () => [session({ id: "older", itemIds: ["i2"], herdrPane: "w1:p1", startedAt: 2 }), session({ id: "newer", itemIds: ["i3"], herdrPane: "w1:p1", startedAt: 3 }), session({ id: "gone", herdrPane: "w1:p1", state: "ended", endedAt: now, startedAt: 4 })] as never, links: () => [] }, { get: () => null }, "p", now);
  expect(rows.map((r) => r.continuedIn)).toEqual([null, null, null]);
  expect(continuedIn("w1:p1", rows, [])).toBe("newer");
  expect(continuedIn("w1:p1", rows, [{ id: "t1", title: "repo", cwd: "/repo", pane: "w1:p1", startedAt: 1, agentTitle: null, sessionId: "newer", note: null, running: null }])).toBe("t1");
  expect(continuedIn("w1:p9", rows, [])).toBeNull();
  expect(continuedIn(null, rows, [])).toBeNull();
});

it("tells the window where the pane of an ended session a cell shows goes on, and nothing for the others", async () => {
  const opened: WindowState[][] = [];
  const now = Date.now();
  const sessions = [
    session({ id: "mate", itemIds: ["i2"], herdrPane: "w1:p1", startedAt: 5 }),
    session({ id: "merged", itemIds: ["i1"], herdrPane: "w1:p1", state: "ended", endedAt: now - 1000, startedAt: 4 }),
    session({ id: "alone", itemIds: ["i3"], herdrPane: "w1:p5", state: "ended", endedAt: now - 1000, startedAt: 3 })
  ];
  class FakeSurfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
    open(spec: { initialState: unknown }) {
      const states = [spec.initialState as WindowState];
      opened.push(states);
      return { id: "s", capabilities: { programmaticPosition: true, forwardedMouseMoves: false }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, focus() {}, setState: (s: WindowState) => void states.push(s), post() {}, close() {} };
    }
  }
  class ReadyHerdr extends Service {
    static provide = "terminals";
    readonly kind = "herdr" as const;
    constructor(ctx: Context) {
      super(ctx, "terminals");
    }
    onPane = () => () => {};
    watch = () => () => {};
    watching = (): string[] => [];
    bridge = async () => ({ state: "ready" as const, version: "0.9.5" });
    clientAttached = async () => false;
    panes = async () => [];
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => sessions;
    links = () => [];
    repositoriesOf = () => [];
    repositoryFoldersOf = this.repositoriesOf;
  }
  const stateFile = path.join(dir, "carried-state.json");
  const layout: Layout = { type: "split", id: "r", direction: "row", ratio: 0.5, a: { type: "leaf", id: "c1", sessionId: "merged" }, b: { type: "leaf", id: "c2", sessionId: "alone" } };
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "carried-settings.json") }], Contributions, FakeSurfaces, ReadyHerdr, FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile }]] });
  fs.writeFileSync(stateFile, JSON.stringify({ layouts: { [w.project.id]: layout } }));
  for (const s of sessions) s.device = w.ctx.hub.deviceId;
  await settle();
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const sent = opened[0]![0]!.sessions;
  expect(sent.map((s) => [s.id, s.pane, s.continuedIn])).toEqual([
    ["mate", "w1:p1", null],
    ["merged", null, "mate"],
    ["alone", null, null]
  ]);
});

it("never shows a state older than one already shown, so a pick from History keeps its cell", async () => {
  const opened: { spec: { onMessage(m: unknown): void; onClose(): void; initialState: unknown }; states: WindowState[] }[] = [];
  const now = Date.now();
  const sessions = [session({ id: "live", herdrPane: "w1:p1", startedAt: 5 }), session({ id: "old", state: "ended", endedAt: now - 60_000, startedAt: 1, prompted: true })];
  // herdr's pane list answers when let go, so a state can be held after it read the layout.
  let held: (() => void)[] | null = null;
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
  class HeldHerdr extends Service {
    static provide = "terminals";
    readonly kind = "herdr" as const;
    constructor(ctx: Context) {
      super(ctx, "terminals");
    }
    onPane = () => () => {};
    watch = () => () => {};
    watching = (): string[] => [];
    bridge = async () => ({ state: "ready" as const, version: "0.9.5" });
    clientAttached = async () => false;
    panes = () =>
      new Promise((resolve) => {
        const answer = () => resolve([{ paneId: "w1:p9", agent: null, agentSession: null, status: "unknown" as const, title: null }]);
        if (held) held.push(answer);
        else answer();
      });
    processes = async () => [];
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => sessions;
    links = () => [];
    repositoriesOf = () => [];
    repositoryFoldersOf = this.repositoriesOf;
  }
  const stateFile = path.join(dir, "stale-state.json");
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "stale-settings.json") }], Contributions, FakeSurfaces, HeldHerdr, FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile }]] });
  const one: Layout = { type: "split", id: "r", direction: "row", ratio: 0.5, a: { type: "leaf", id: "c1", sessionId: "live" }, b: { type: "leaf", id: "c2", sessionId: null } };
  fs.writeFileSync(stateFile, JSON.stringify({ layouts: { [w.project.id]: one }, terminals: { [w.project.id]: [{ id: "t1", title: "repo", cwd: dir, pane: "w1:p9", startedAt: 1 }] } }));
  for (const s of sessions) s.device = w.ctx.hub.deviceId;
  await settle();
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  expect(win.states.at(-1)!.sessions.map((s) => s.id)).toEqual(["live"]);

  // A state begins; the ended session is picked from History into a cell, and another state begins after that.
  held = [];
  w.ctx.emit("codeLink/changed", w.project.id);
  await settle();
  win.spec.onMessage({ type: "layout", layout: { ...one, b: { type: "leaf", id: "c2", sessionId: "old" } } });
  win.spec.onMessage({ type: "refresh" });
  await settle();
  const [older, newer] = held;
  held = null;
  const before = win.states.length;
  newer!();
  await settle();
  older!();
  await settle();
  // The newer state alone is shown, the picked session in it for its cell.
  expect(win.states.length).toBe(before + 1);
  expect(win.states.at(-1)!.sessions.map((s) => s.id)).toEqual(["live", "old"]);
});

it("keeps a terminal that finishes opening while herdr is asked for its panes, and forgets only the terminals whose panes went", async () => {
  const opened: { spec: { onMessage(m: unknown): void; onClose(): void; initialState: unknown }; states: WindowState[] }[] = [];
  // herdr's pane list and a launch each answer when let go.
  let held: (() => void)[] | null = null;
  let alive = ["w1:p9"];
  let launched: () => void = () => undefined;
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
  class HeldHerdr extends Service {
    static provide = "terminals";
    readonly kind = "herdr" as const;
    constructor(ctx: Context) {
      super(ctx, "terminals");
    }
    onPane = () => () => {};
    watch = () => () => {};
    watching = (): string[] => [];
    bridge = async () => ({ state: "ready" as const, version: "0.9.5" });
    clientAttached = async () => false;
    panes = () =>
      new Promise((resolve) => {
        const answer = () => resolve(alive.map((paneId) => ({ paneId, agent: null, agentSession: null, status: "unknown" as const, title: null })));
        if (held) held.push(answer);
        else answer();
      });
    processes = async () => [];
    launch = () => new Promise((resolve) => (launched = () => resolve({ paneId: "w1:pB", workspaceId: "w1" })));
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => [];
    links = () => [];
    repositoriesOf = () => [];
    repositoryFoldersOf = this.repositoriesOf;
  }
  const stateFile = path.join(dir, "opening-state.json");
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "opening-settings.json") }], Contributions, FakeSurfaces, HeldHerdr, FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile }]] });
  fs.writeFileSync(stateFile, JSON.stringify({ terminals: { [w.project.id]: [{ id: "t1", title: "repo", cwd: dir, pane: "w1:p9", startedAt: 1 }] } }));
  await settle();
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  const ids = () => win.states.at(-1)!.terminals.map((t) => t.id);
  const saved = () => (JSON.parse(fs.readFileSync(stateFile, "utf8")).terminals[w.project.id] as { id: string }[]).map((t) => t.id);

  // A new terminal starts opening; the window hears of it.
  held = [];
  win.spec.onMessage({ type: "newTerminal", terminalId: "t2", cwd: dir });
  await settle();
  held.shift()!();
  await settle();
  expect(ids()).toEqual(["t1", "t2"]);
  // A state begins while it opens; meanwhile it finishes opening, and the first terminal's pane goes.
  w.ctx.emit("codeLink/changed", w.project.id);
  await settle();
  launched();
  await settle();
  alive = ["w1:pB"];
  held.shift()!();
  await settle();
  // That state still has the new terminal, and only the gone one left the saved list.
  expect(ids()).toEqual(["t2"]);
  expect(saved()).toEqual(["t2"]);
  for (const answer of held.splice(0)) answer();
  held = null;
  await settle();
  expect(ids()).toEqual(["t2"]);
  expect(saved()).toEqual(["t2"]);
});

it("shows a session code link asks for: the window opens or comes forward with it to reveal, only while herdr can show panes", async () => {
  const opened: { spec: Record<string, unknown> & { onMessage(m: unknown): void; onClose(): void }; states: WindowState[]; posts: WindowPost[]; focused: number }[] = [];
  const sessions = [session({ id: "s1", herdrPane: "w1:p1" }), session({ id: "s2", herdrPane: "w1:p2" }), session({ id: "s3", mode: "headless" }), session({ id: "s4", state: "ended", endedAt: 5, title: "An earlier ticket" })];
  let bridge: { state: string } = { state: "ready" };
  const herdrShown: string[] = [];

  class FakeSurfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
    open(spec: (typeof opened)[number]["spec"]) {
      const entry = { spec, states: [spec.initialState as WindowState], posts: [] as WindowPost[], focused: 0 };
      opened.push(entry);
      return { id: spec.id, capabilities: { programmaticPosition: true, forwardedMouseMoves: false }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, focus: () => void entry.focused++, setState: (st: WindowState) => void entry.states.push(st), post: (m: WindowPost) => void entry.posts.push(m), close: () => spec.onClose() };
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
    bridge = async () => bridge;
    clientAttached = async () => false;
    panes = async () => [];
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => sessions;
    links = () => [];
    herdrInstall = async () => ({ command: null, guide: "" });
    showInHerdr = async (_projectId: string, itemId: string) => (herdrShown.push(itemId), "Shown in herdr");
  }

  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings-reveal.json") }], Contributions, FakeSurfaces, FakeHerdr, FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile: path.join(dir, "reveal.json") }]] });
  const ticket = w.ctx.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Shown", workType: "coding", status: "doing", by: "human" });
  sessions[0]!.itemIds = [ticket.id];
  await settle();
  const ask = (sessionId: string) => w.ctx.serial("codeLink/show-session", w.project.id, sessionId);

  expect(await w.ctx.serial("codeLink/terminal-window", w.project.id)).toBe(true);
  // Closed: no cells to name.
  expect(w.ctx.bail("codeLink/cells", w.project.id)).toBeUndefined();
  // Closed: it opens, already asked to reveal the session.
  expect(await ask("s1")).toBe(true);
  expect(opened).toHaveLength(1);
  // Open: the cells it shows, numbered in reading order, empty ones counted.
  expect(w.ctx.bail("codeLink/cells", w.project.id)).toEqual([]);
  const leaf = (id: string, sessionId: string | null) => ({ type: "leaf", id, sessionId });
  opened[0]!.spec.onMessage({ type: "layout", layout: { type: "split", id: "r", direction: "row", ratio: 0.5, a: leaf("c1", null), b: leaf("c2", "s1") } });
  expect(w.ctx.bail("codeLink/cells", w.project.id)).toEqual([{ sessionId: "s1", n: 2 }]);
  const first = opened[0]!.states[0]!.reveal;
  expect(first).toMatchObject({ sessionId: "s1" });
  // Open: it comes forward with a new ask, and every later state keeps it until the next.
  expect(await ask("s2")).toBe(true);
  expect(opened).toHaveLength(1);
  expect(opened[0]!.focused).toBe(1);
  const second = opened[0]!.states.at(-1)!.reveal!;
  expect(second.sessionId).toBe("s2");
  expect(second.at).toBeGreaterThan(first!.at);
  // An ended one, paneless (a ticket's earlier session): it comes along with the ask, so a cell can show its conversation.
  expect(opened[0]!.states.at(-1)!.sessions.some((s) => s.id === "s4")).toBe(false);
  expect(await ask("s4")).toBe(true);
  await settle();
  expect(opened[0]!.states.at(-1)!.reveal!.sessionId).toBe("s4");
  expect(opened[0]!.states.at(-1)!.sessions.some((s) => s.id === "s4")).toBe(true);
  // Nothing to show here: a run without a pane, or a session it does not know, is left to code link.
  expect(await ask("s3")).toBeUndefined();
  expect(await ask("gone")).toBeUndefined();
  // herdr unable to show panes in this window: no answer, so code link falls back.
  bridge = { state: "unsupported" };
  expect(await w.ctx.serial("codeLink/terminal-window", w.project.id)).toBeUndefined();
  expect(await ask("s1")).toBeUndefined();

  // "Show in herdr" in the window means herdr's own client, never this window again.
  opened[0]!.spec.onMessage({ type: "focusHerdr", sessionId: "s1" });
  await settle();
  expect(herdrShown).toEqual([ticket.id]);
  expect(opened[0]!.posts.at(-1)).toEqual({ type: "toast", text: "Shown in herdr" });
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
    repositoryFoldersOf = this.repositoriesOf;
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
  // Each step waits for the state it leads to, not a fixed time: under load the window's refresh can take longer.
  const until = (check: () => boolean) => vi.waitUntil(check, { timeout: 20_000, interval: 10 });
  const listed = (states: WindowState[], id: string) => states.at(-1)!.terminals.find((t) => t.id === id);

  // A new terminal: a plain shell in a tab of the project's workspace, nothing typed into it.
  win.spec.onMessage({ type: "newTerminal", terminalId: "t1", cwd: repo });
  await until(() => !!listed(win.states, "t1")?.pane);
  expect(fake.of("workspace.create")).toEqual([{ cwd: repo, label: w.project.name, focus: false }]);
  expect(fake.of("pane.send_input")).toEqual([]);
  expect(win.states.some((s) => s.terminals.some((t) => t.id === "t1" && t.pane === null))).toBe(true);
  expect(win.states.at(-1)!.terminals).toEqual([expect.objectContaining({ id: "t1", title: path.basename(repo), cwd: repo, pane: "w1:p1" })]);
  win.spec.onMessage({ type: "attach", cell: "c1", sessionId: "t1", cols: 80, rows: 24 });
  await until(() => attached.length > 0);
  expect(attached).toEqual(["w1:p1"]);

  // Kept: a window opened later lists it again.
  win.spec.onClose();
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  expect(opened[1]!.states[0]!.terminals).toEqual([expect.objectContaining({ id: "t1", pane: "w1:p1" })]);

  // Sessions that cannot be read are a warning; a terminal still opens.
  sessionsBroken = true;
  const next = opened[1]!;
  next.spec.onMessage({ type: "newTerminal", terminalId: "t2", cwd: null });
  await until(() => !!listed(next.states, "t2")?.pane);
  expect(next.states.at(-1)).toMatchObject({ sessions: [], warning: expect.any(String) });
  expect(next.states.at(-1)!.terminals.map((t) => t.id)).toEqual(["t1", "t2"]);
  sessionsBroken = false;

  // The tray's "Start in a terminal": a plain terminal in a new cell of this window, in the project's folder.
  expect(await w.ctx.serial("codeLink/new-terminal", w.project.id)).toBe(true);
  const added = next.states.at(-1)!.terminals.find((t) => t.id !== "t1" && t.id !== "t2");
  expect(added).toMatchObject({ cwd: repo, pane: expect.any(String) });
  await until(() => next.states.at(-1)!.reveal?.sessionId === added!.id);
  fake.exit(added!.pane!);

  // Closed by the person: the pane ends and the terminal is forgotten. One whose pane went is forgotten too.
  next.spec.onMessage({ type: "closeTerminal", terminalId: "t1" });
  await until(() => !listed(next.states, "t1"));
  expect(fake.of("pane.close")).toEqual([{ pane_id: "w1:p1" }]);
  fake.exit(listed(next.states, "t2")!.pane!);
  next.spec.onMessage({ type: "refresh" });
  await until(() => next.states.at(-1)!.terminals.length === 0);

  // herdr gone: the window says so, nothing is kept.
  fake.stop();
  next.spec.onMessage({ type: "newTerminal", terminalId: "t3", cwd: repo });
  await until(() => next.posts.at(-1)?.type === "toast");
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).terminals[w.project.id]).toEqual([]);
  next.spec.onClose();
}, 30_000);

it("shows how herdr reads the agent in a plain terminal as it changes, nothing for a bare shell, and lets the pane go with the window", async () => {
  const fake = new FakeHerdr();
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
    repositoryFoldersOf = this.repositoriesOf;
    herdrInstall = async () => ({ command: null, guide: "" });
  }

  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings-status.json") }], Contributions, FakeSurfaces, [Herdr, { socket: fake.socket, bin: path.join(dir, "absent"), reconnectMs: 30 }], FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile: path.join(dir, "status.json") }]] });
  const herdr = w.ctx.get("herdr")!;
  herdr.bridge = async () => ({ state: "ready", version: "0.9.5" });
  // "Show in herdr" goes with a herdr client of its own on this machine, and only then.
  let client = true;
  herdr.clientAttached = async () => client;
  await settle();
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  expect(win.states.at(-1)!.herdrClient).toBe(true);
  client = false;
  win.spec.onMessage({ type: "newTerminal", terminalId: "t1", cwd: dir });
  const status = () => win.states.at(-1)!.terminals[0]?.agentStatus;
  const shows = async (want: unknown) => {
    for (let i = 0; i < 100 && status() !== want; i++) await new Promise((r) => setTimeout(r, 20));
    return status();
  };
  expect(await shows(null)).toBeNull();
  expect(win.states.at(-1)!.herdrClient).toBe(false);
  const pane = win.states.at(-1)!.terminals[0]!.pane!;
  expect(herdr.watching()).toEqual([pane]);

  // Heard from herdr, not the next poll; blocked is the person's turn, done is finished work not yet looked at.
  fake.setStatus(pane, "claude", "working");
  expect(await shows("working")).toBe("working");
  fake.setStatus(pane, "claude", "blocked");
  expect(await shows("blocked")).toBe("blocked");
  fake.setStatus(pane, "claude", "done");
  expect(await shows("done")).toBe("done");
  fake.setStatus(pane, "claude", "idle");
  expect(await shows("idle")).toBe("idle");
  // An agent herdr cannot read, and the shell once the agent leaves, show nothing.
  fake.setStatus(pane, "claude", "unknown");
  expect(await shows(null)).toBeNull();
  fake.setStatus(pane, "claude", "working");
  expect(await shows("working")).toBe("working");
  fake.setStatus(pane, null, "unknown");
  expect(await shows(null)).toBeNull();

  win.spec.onClose();
  expect(herdr.watching()).toEqual([]);
  fake.close();
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
    repositoryFoldersOf = this.repositoriesOf;
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
  // An agent herdr sees in a terminal lends it the title it gave the conversation; a shell's title is not one.
  Object.assign(fake.panes.get(pane.t1!)!, { agent: "claude", terminal_title_stripped: "选中面板与侧边栏会话联动" });
  fake.panes.get(pane.t2!)!.terminal_title_stripped = "zsh";
  expect((await now()).map((t) => [t.id, t.agentTitle])).toEqual([["t1", "选中面板与侧边栏会话联动"], ["t2", null], ["t3", null]]);
  fake.panes.get(pane.t1!)!.agent = null;
  // A plain terminal goes by what runs in it; a shell in the foreground is nothing to name it by.
  fake.panes.get(pane.t2!)!.foreground = { cmdline: "pnpm dev", cwd: dir };
  fake.panes.get(pane.t3!)!.foreground = { cmdline: "-zsh", cwd: dir };
  expect((await now()).map((t) => [t.id, t.running])).toEqual([["t1", "选中面板与侧边栏会话联动"], ["t2", "pnpm dev"], ["t3", null]]);
  delete fake.panes.get(pane.t2!)!.foreground;
  delete fake.panes.get(pane.t3!)!.foreground;
  // A session with no ticket in a herdr pane this window did not open goes by its conversation; one in a terminal here does not need to.
  const other = Object.assign(fake.createPane(dir), { agent: "claude", terminal_title_stripped: "整理测试" });
  sessions.push(session({ id: "loose", herdrPane: other.pane_id, startedAt: 9 }), session({ id: "inside", herdrPane: pane.t3!, startedAt: 9 }));
  await now();
  const titles = Object.fromEntries(win.states.at(-1)!.sessions.map((s) => [s.id, s.agentTitle]));
  expect([titles.loose, titles.inside]).toEqual(["整理测试", null]);
  sessions.splice(-2);

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
    repositoryFoldersOf = this.repositoriesOf;
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

  // Saved under a name with its sessions and locks left out; renamed, made the default, then deleted.
  const grid: Layout = { type: "split", id: "g", direction: "row", ratio: 0.3, a: { type: "leaf", id: "a", sessionId: "s1", locked: true }, b: { type: "leaf", id: "b", sessionId: "t1" } };
  await say({ type: "savePreset", name: "  Two  ", layout: grid });
  const saved = win.states.at(-1)!;
  expect(saved.warning).toBeNull();
  expect(saved.presets).toEqual([{ id: expect.any(String), name: "Two", layout: { ...grid, a: { type: "leaf", id: "a", sessionId: null }, b: { ...grid.b, sessionId: null } } }]);
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
  // The window's own layout keeps its locks, for the next time it opens.
  await say({ type: "layout", layout: grid });
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).layouts[w.project.id]).toEqual(grid);
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
  expect(calls.map((c) => [c[0], c[1], c[2].cwd])).toEqual([["wt.exe", ["-d", "C:\\work"], "C:\\work"], ["powershell.exe", ["-NoExit", "-ExecutionPolicy", "Bypass"], "C:\\work"]]);
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

it("starts herdr's server again when it went away, on opening with saved terminals and when a stream ends with it, and the cells attach again", async () => {
  let running = false;
  const revives: boolean[] = [];
  let answer: (result: string) => void = () => undefined;
  const streams: { pane: string; end(reason: string | null): void }[] = [];
  const opened: { spec: { onMessage(m: unknown): void; onClose(): void; initialState: unknown }; states: WindowState[]; posts: WindowPost[] }[] = [];

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
  class GoneHerdr extends Service {
    static provide = "terminals";
    readonly kind = "herdr" as const;
    constructor(ctx: Context) {
      super(ctx, "terminals");
    }
    onPane = () => () => {};
    watch = () => () => {};
    watching = (): string[] => [];
    bridge = async () => (running ? { state: "ready" as const, version: "0.9.5" } : { state: "notRunning" as const, version: "0.9.5" });
    clientAttached = async () => false;
    binary = () => "/opt/homebrew/bin/herdr";
    server = async () => (running ? { version: "0.9.5", protocol: 22, socket: "/h.sock" } : null);
    serverGone = async () => !running;
    panes = async () => (running ? [{ paneId: "w8:p1", agent: null, agentSession: null, status: "unknown" as const, title: null }] : null);
    processes = async () => [];
    revive = (force = false) => {
      revives.push(force);
      return new Promise<string>((resolve) => {
        answer = (result) => {
          running = result === "started";
          resolve(result);
        };
      });
    };
    terminal = async (pane: string) => {
      if (!running) throw new HerdrError("notRunning", `herdr cannot stream ${pane}: notRunning`);
      const ends = new Set<(reason: string | null) => void>();
      streams.push({ pane, end: (reason) => ends.forEach((l) => l(reason)) });
      return { paneId: pane, mode: "control", closed: false, onFrame: () => () => {}, onClose: (l: (reason: string | null) => void) => (ends.add(l), () => ends.delete(l)), input() {}, resize() {}, scroll() {}, mouse() {}, close() {} };
    };
    onScroll = () => () => {};
  }
  class NoCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => [];
    links = () => [];
    herdrInstall = async () => ({ command: "brew install herdr", guide: "https://herdr.dev/docs/install/" });
  }

  const stateFile = path.join(dir, "gone-state.json");
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "gone-settings.json") }], Contributions, FakeSurfaces, GoneHerdr, NoCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile }]] });
  const saved = { id: "t1", title: "repo", cwd: dir, pane: "w8:p1", startedAt: 1 };
  fs.writeFileSync(stateFile, JSON.stringify({ terminals: { [w.project.id]: [saved] } }));
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(check()).toBe(true);
  };

  // Opened with the server gone: it is started again, and the saved terminal stays while it is.
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  expect(win.states[0]).toMatchObject({ bridge: { state: "notRunning" }, revive: "starting", terminals: [expect.objectContaining({ id: "t1", pane: "w8:p1" })] });
  expect(revives).toEqual([false]);
  win.spec.onMessage({ type: "attach", cell: "c1", sessionId: "t1", cols: 80, rows: 24 });
  await until(() => win.posts.some((p) => p.type === "closed"));
  expect(win.posts.at(-1)).toEqual({ type: "closed", cell: "c1", reason: "herdr's server stopped — starting it again, this terminal comes back on its own" });
  expect(revives).toEqual([false]);
  answer("started");
  await until(() => win.posts.at(-1)?.type === "reattach");
  expect(win.posts.at(-1)).toEqual({ type: "reattach", cell: "c1" });
  await until(() => win.states.at(-1)!.bridge.state === "ready");
  expect(win.states.at(-1)).toMatchObject({ revive: null, terminals: [expect.objectContaining({ id: "t1", pane: "w8:p1" })] });

  // Attached, then the server goes away under it: started again, and the cell comes back.
  win.spec.onMessage({ type: "attach", cell: "c1", sessionId: "t1", cols: 80, rows: 24 });
  await until(() => streams.length === 1);
  running = false;
  streams[0]!.end("herdr exited");
  await until(() => revives.length === 2);
  expect(win.posts.at(-1)).toMatchObject({ type: "closed", cell: "c1", reason: expect.stringContaining("starting it again") });
  answer("started");
  await until(() => win.posts.at(-1)?.type === "reattach");

  // A pane that ends while the server runs is just over: no start.
  win.spec.onMessage({ type: "attach", cell: "c1", sessionId: "t1", cols: 80, rows: 24 });
  await until(() => streams.length === 2);
  streams[1]!.end("pane exited");
  await until(() => win.posts.at(-1)?.type === "closed");
  expect(win.posts.at(-1)).toEqual({ type: "closed", cell: "c1", reason: "pane exited" });
  expect(revives).toHaveLength(2);

  // A start that does not work says so and waits for the person's retry.
  running = false;
  win.spec.onMessage({ type: "refresh" });
  await until(() => revives.length === 3);
  answer("failed");
  await until(() => win.states.at(-1)!.revive === "failed");
  win.spec.onMessage({ type: "refresh" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(revives).toHaveLength(3);
  win.spec.onMessage({ type: "startHerdr" });
  await until(() => revives.length === 4);
  expect(revives.at(-1)).toBe(true);
  answer("started");
  await until(() => win.states.at(-1)!.bridge.state === "ready" && win.states.at(-1)!.revive === null);
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).terminals[w.project.id]).toEqual([saved]);
});

it("lists the assistant's conversations from a cache read when they change, never on a refresh; answers a prompt from a card; reads tails for the overview", async () => {
  const opened: { spec: Record<string, unknown> & { onMessage(m: unknown): void; onClose(): void }; states: WindowState[]; posts: WindowPost[] }[] = [];
  const events: [string, unknown][] = [];
  const answered: [string, string, string][] = [];
  let takes: "answered" | "notPrompt" | "failed" = "answered";
  const tails = new Map<string, string | null>([["w1:p1", "$ pnpm test\n12 passed\nAllow? [y/n]"], ["w1:p2", null]]);
  const tailReads: string[] = [];
  const sessions = [
    session({ id: "s1", itemIds: [], herdrPane: "w1:p1", branch: "tom-1/x", state: "waiting", blocked: { kind: "permission" }, activity: "needs your approval: Bash", lastEventAt: 50 }),
    session({ id: "run", mode: "headless", threadId: "t-busy", herdrPane: null, startedAt: 3 }),
    session({ id: "gone", herdrPane: "w1:p2", state: "ended", endedAt: 9 })
  ];
  const threadReads: string[] = [];
  const threadList: { id: string; title: string; engine: string; itemId: string | null; createdAt: number; updatedAt: number }[] = [
    { id: "t-asks", title: "整理 Q4 backlog", engine: "loop", itemId: null, createdAt: 1, updatedAt: 5 },
    { id: "t-busy", title: "", engine: "claude-code", itemId: null, createdAt: 2, updatedAt: 6 }
  ];
  let pending: { threadId: string; kind: string; text: string }[] = [{ threadId: "t-asks", kind: "ask", text: "要我取消 3 张重复工单吗？" }];
  class FakeSurfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
    open(spec: (typeof opened)[number]["spec"]) {
      const entry = { spec, states: [spec.initialState as WindowState], posts: [] as WindowPost[] };
      opened.push(entry);
      return { id: spec.id, capabilities: { programmaticPosition: true, forwardedMouseMoves: false }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, focus() {}, setState: (s: WindowState) => void entry.states.push(s), post: (m: WindowPost) => void entry.posts.push(m), close: () => spec.onClose() };
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
    clientAttached = async () => false;
    panes = async () => [];
    readTail = async (pane: string) => (tailReads.push(pane), tails.get(pane) ?? null);
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => sessions;
    links = () => [];
    herdrInstall = async () => ({ command: null, guide: "https://herdr.dev/docs/install/" });
    sessionAnswer = async (projectId: string, sessionId: string, which: string) => (answered.push([projectId, sessionId, which]), takes);
  }
  class FakeAgent extends Service {
    static provide = "agent";
    constructor(ctx: Context) {
      super(ctx, "agent");
    }
    store = { threads: (projectId: string) => (threadReads.push(projectId), threadList.map((t) => ({ ...t, projectId, boardId: null, branch: null, surface: "assistant", archived: false }))) };
    activeRuns = () => [{ run: { id: "r1" }, thread: { id: "t-busy" } }];
    activities = () => pending.map((p) => ({ projectId: "p", threadId: p.threadId, run: null, pending: { threadId: p.threadId, kind: p.kind, workflow: null, question: { id: "q", text: p.text }, accepts: "text" } }));
    engineOf = (id: string) => (id === "loop" ? { id, title: "Tomrade assistant" } : id === "claude-code" ? { id, title: "Claude Code", local: { approval: { allow: ["enter"], deny: ["esc"] } } } : undefined);
  }
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings-threads.json") }], Contributions, FakeSurfaces, FakeHerdr, FakeCodeLink, FakeAgent, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile: path.join(dir, "state-threads.json") }]] });
  const projectId = w.project.id;
  // The fake agent answers for every project with the same list; the cache is keyed by the window's project.
  (w.ctx.get("agent") as unknown as FakeAgent).activities = () => pending.map((p) => ({ projectId, threadId: p.threadId, run: null, pending: { threadId: p.threadId, kind: p.kind, workflow: null, question: { id: "q", text: p.text }, accepts: "text" } }));
  w.ctx.on("desktop/open", (target) => void events.push(["desktop/open", target]));
  await w.ctx.contributions.run("code-sessions.open", { projectId });
  const win = opened[0]!;
  const say = async (m: WindowMessage) => {
    win.spec.onMessage(m);
    await settle();
  };
  const first = win.states[0]!;
  // Both conversations listed: the one asking, with its question; the one a run drives, with its headless session's thread.
  expect(first.threads.map((t) => [t.id, t.engineName, t.running, t.wait?.kind, t.wait?.text])).toEqual([
    ["t-asks", "Tomrade assistant", false, "question", "要我取消 3 张重复工单吗？"],
    ["t-busy", "Claude Code", true, undefined, undefined]
  ]);
  const since = first.threads[0]!.wait!.since;
  // Its agent declared the keys for its prompt; when its hooks last spoke, for the bar's order.
  expect(first.sessions.find((s) => s.id === "s1")).toMatchObject({ approval: true, needsYou: true, lastEventAt: 50 });
  // Refreshes read the sessions, never the conversations again.
  expect(threadReads).toEqual([projectId]);
  for (let i = 0; i < 5; i++) await say({ type: "refresh" });
  w.ctx.emit("codeLink/changed", projectId);
  await settle();
  expect(threadReads).toHaveLength(1);
  expect(win.states.at(-1)!.threads).toBe(first.threads);
  // The assistant says a question was answered: read again, once the burst settles; a wait that stays keeps its since.
  w.ctx.emit("agent/event", "t-asks", { type: "pending", pending: null });
  w.ctx.emit("agent/event", "t-asks", { type: "delta", runId: "r", text: "…" } as never);
  w.ctx.emit("agent/event", "t-busy", { type: "done", run: { id: "r1" } } as never);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(threadReads).toHaveLength(2);
  expect(win.states.at(-1)!.threads[0]!.wait).toEqual({ kind: "question", text: "要我取消 3 张重复工单吗？", since });
  // A conversation no window lists yet, and each message landing, leave it be: the conversation comes in with its run's start.
  pending = [];
  threadList.push({ id: "t-new", title: "新对话", engine: "loop", itemId: null, createdAt: 7, updatedAt: 8 });
  w.ctx.emit("agent/event", "t-new", { type: "pending", pending: null });
  w.ctx.emit("agent/event", "t-busy", { type: "message", message: { id: "m1" } } as never);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(threadReads).toHaveLength(2);
  w.ctx.emit("agent/run-started", { id: "r2" } as never, { id: "t-new", projectId } as never);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(threadReads).toHaveLength(3);
  expect(win.states.at(-1)!.threads.map((t) => [t.id, t.wait])).toEqual([["t-asks", null], ["t-busy", null], ["t-new", null]]);
  // Words streamed by a run do not make the window read; a run ending does.
  w.ctx.emit("agent/event", "t-busy", { type: "progress", runId: "r1" } as never);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(threadReads).toHaveLength(3);
  w.ctx.emit("agent/run-ended", { id: "r1" } as never, { id: "t-busy", projectId } as never);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(threadReads).toHaveLength(4);

  // Allow from a card: the keys its agent declared go to its pane through code link; not taken, the window is told.
  await say({ type: "answer", sessionId: "s1", which: "allow" });
  expect(answered).toEqual([[projectId, "s1", "allow"]]);
  expect(win.posts.filter((p) => p.type === "toast")).toEqual([]);
  takes = "failed";
  await say({ type: "answer", sessionId: "s1", which: "deny" });
  expect(win.posts.at(-1)).toEqual({ type: "toast", text: "The terminal did not take the answer; answer in its pane" });
  // Its screen asks no permission (a folder's trust, say): nothing was pressed, and the session comes into a cell to be answered there.
  takes = "notPrompt";
  await say({ type: "answer", sessionId: "s1", which: "allow" });
  expect(win.posts.at(-1)).toEqual({ type: "toast", text: "Its screen shows no permission prompt a key could answer safely — answer it in its pane" });
  expect(win.states.at(-1)!.reveal?.sessionId).toBe("s1");
  // An assistant conversation opens in the app window, as a notification's click does.
  await say({ type: "showThread", threadId: "t-asks" });
  expect(events).toEqual([["desktop/open", { projectId, threadId: "t-asks" }]]);
  // The overview asks for the panes' last lines: every live session's pane and terminal, an ended one's never.
  await say({ type: "tails" });
  expect(win.posts.at(-1)).toEqual({ type: "tails", panes: { "w1:p1": "$ pnpm test\n12 passed\nAllow? [y/n]" } });
  // Allow and Deny follow its screen: "Allow? [y/n]" offers no options to pick, so its card had neither.
  expect(first.sessions.find((s) => s.id === "s1")!.prompt).toBeNull();
  // A prompt with yes under the cursor, once its hooks speak again: both; what was seen holds until its next event.
  tails.set("w1:p1", "Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)");
  sessions[0] = { ...sessions[0]!, lastEventAt: 60 };
  await say({ type: "refresh" });
  expect(win.states.at(-1)!.sessions.find((s) => s.id === "s1")!.prompt).toBe("allow");
  const reads = tailReads.length;
  await say({ type: "refresh" });
  expect(tailReads).toHaveLength(reads);
  // Answered, its screen is read again at once: the cursor now on no leaves only Deny.
  takes = "answered";
  tails.set("w1:p1", "Do you want to proceed?\n  1. Yes\n❯ 2. No, and tell Claude what to do differently (esc)");
  await say({ type: "answer", sessionId: "s1", which: "deny" });
  expect(win.states.at(-1)!.sessions.find((s) => s.id === "s1")!.prompt).toBe("deny");
  // An ended session's pane is never read for a prompt.
  expect(tailReads).not.toContain("w1:p2");
  // Closed, the window's conversations are let go; opened again, they are read afresh.
  win.spec.onClose();
  await w.ctx.contributions.run("code-sessions.open", { projectId });
  expect(threadReads).toHaveLength(5);
});

it("records what a cell shows, asks it for a snapshot when a session begins on its pane, plays a session's part back, and keeps a closed terminal's recording for History", async () => {
  const opened: { spec: { onMessage(m: unknown): void; onClose(): void; initialState: unknown }; states: WindowState[]; posts: WindowPost[] }[] = [];
  const started = Date.now() - 10_000;
  const sessions = [session({ id: "a", herdrPane: "w1:p1", startedAt: started, prompted: true })];
  const streams: { pane: string; frame(text: string, at?: { full?: boolean; seq?: number }): void }[] = [];
  class FakeSurfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
    open(spec: (typeof opened)[number]["spec"]) {
      const entry = { spec, states: [spec.initialState as WindowState], posts: [] as WindowPost[] };
      opened.push(entry);
      return { id: "s", capabilities: { programmaticPosition: true, forwardedMouseMoves: false }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, focus() {}, setState: (st: WindowState) => void entry.states.push(st), post: (m: WindowPost) => void entry.posts.push(m), close: () => spec.onClose() };
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
    clientAttached = async () => false;
    panes = async () => [{ paneId: "w1:p2", agent: null, agentSession: null, status: "unknown" as const, title: null }];
    processes = async () => [];
    launch = async () => ({ paneId: "w1:p2", workspaceId: "w1" });
    closePane = async () => true;
    onScroll = () => () => {};
    terminal = async (pane: string) => {
      const frames = new Set<(f: unknown) => void>();
      streams.push({ pane, frame: (text, at = {}) => frames.forEach((l) => l({ seq: at.seq ?? 1, width: 80, height: 24, full: at.full ?? false, bytes: new Uint8Array(Buffer.from(text)) })) });
      return { paneId: pane, mode: "control", closed: false, onFrame: (l: (f: unknown) => void) => (frames.add(l), () => frames.delete(l)), onClose: () => () => {}, input() {}, resize() {}, scroll() {}, mouse() {}, close() {} };
    };
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => sessions;
    links = () => [];
    repositoriesOf = () => [];
    repositoryFoldersOf = () => [];
    review = { list: () => ({ rows: sessions.filter((s) => s.endedAt !== null).map((s) => reviewRow(s.id, s.endedAt!)), next: null }), saidIn: async () => ({ rows: [], said: {} }) };
  }
  const stateFile = path.join(dir, "recording-state.json");
  const recordingsDir = path.join(dir, "recordings");
  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "recording-settings.json") }], Contributions, FakeSurfaces, FakeHerdr, FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile, recordingsDir }]] });
  fs.writeFileSync(stateFile, JSON.stringify({ layouts: { [w.project.id]: { type: "split", id: "r", direction: "row", ratio: 0.5, a: { type: "leaf", id: "c1", sessionId: "a" }, b: { type: "leaf", id: "c2", sessionId: null } } } }));
  for (const s of sessions) s.device = w.ctx.hub.deviceId;
  await settle();
  // The setting is there, on by default, and machine-local.
  expect(w.ctx.settings.section("terminalRecording")).toMatchObject({ scope: "machine", defaults: { enabled: true, maxTotalMB: 1024, keepDays: 14 } });
  await w.ctx.contributions.run("code-sessions.open", { projectId: w.project.id });
  const win = opened[0]!;
  const say = async (m: WindowMessage) => {
    win.spec.onMessage(m);
    await settle();
  };
  const batched = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
  const text = (r: { bytes: Uint8Array }) => Buffer.from(r.bytes).toString();
  await say({ type: "attach", cell: "c1", sessionId: "a", cols: 80, rows: 24 });
  streams[0]!.frame("hello", { full: true, seq: 1 });
  await batched();
  const panes = () => fs.readdirSync(recordingsDir).sort();
  await vi.waitFor(() => expect(panes()).toEqual(["w1_p1"]));

  // Another session begins on the pane: the cell is asked for its screen, and what comes after the answer begins a new stretch.
  const second = Date.now();
  sessions.push(session({ id: "b", herdrPane: "w1:p1", startedAt: second, prompted: true, device: w.ctx.hub.deviceId }));
  w.ctx.emit("codeLink/changed", w.project.id);
  await vi.waitFor(() => expect(win.posts.some((p) => p.type === "snapshot" && p.cell === "c1")).toBe(true));
  const ask = win.posts.find((p) => p.type === "snapshot")!;
  streams[0]!.frame("tail", { seq: 2 });
  await batched();
  await say({ type: "snapshot", cell: "c1", token: ask.token, seq: 2, width: 80, height: 24, bytes: new Uint8Array(Buffer.from("SNAP")) });
  streams[0]!.frame("world", { seq: 3 });
  await batched();
  // Only one ask, however many states follow.
  w.ctx.emit("codeLink/changed", w.project.id);
  await settle();
  expect(win.posts.filter((p) => p.type === "snapshot")).toHaveLength(1);

  // The second session ends; the cell lets the pane go, and the stretches close under their names.
  Object.assign(sessions[1]!, { state: "ended", endedAt: Date.now() });
  await say({ type: "detach", cell: "c1" });
  await vi.waitFor(() => expect(fs.readdirSync(path.join(recordingsDir, "w1_p1")).filter((n) => /^\d+-\d+\.rec$/.test(n))).toHaveLength(2));
  w.ctx.emit("codeLink/changed", w.project.id);
  await say({ type: "historyList", token: 1 });
  expect(win.posts.find((p) => p.type === "historyPage")?.sessions.find((s) => s.id === "b")).toMatchObject({ rawOutput: true, ranIn: "w1:p1" });
  // Its part: what the pane painted from its start — the frame before the snapshot came, the snapshot, what followed —
  // after the whole-screen paint before it, which catches the screen up unseen.
  const replays = () => win.posts.filter((p) => p.type === "replay");
  await say({ type: "replay", cell: "c2", id: "b" });
  await vi.waitFor(() => expect(replays()).toHaveLength(1));
  const replayed = replays();
  expect(replayed[0]!.records.map((r) => [text(r), r.full, r.key])).toEqual([["hello", true, false], ["tail", false, false], ["SNAP", true, true], ["world", false, false]]);
  expect(replayed[0]).toMatchObject({ id: "b", at: 1, cut: false, clean: true, from: second });
  // The first session's part ends where the second began.
  await say({ type: "replay", cell: "c2", id: "a" });
  await vi.waitFor(() => expect(replays()).toHaveLength(2));
  expect(replays().at(-1)).toMatchObject({ id: "a", from: started, to: second });
  // Nothing recorded of a session that never showed here.
  await say({ type: "replay", cell: "c2", id: "nobody" });
  await vi.waitFor(() => expect(replays()).toHaveLength(3));
  expect(replays().at(-1)).toMatchObject({ id: "nobody", records: [], at: 0 });

  // A plain terminal: shown, recorded, closed — and in History with its recording, to play back.
  await say({ type: "newTerminal", terminalId: "t1", cwd: dir });
  await vi.waitFor(() => expect(win.states.at(-1)!.terminals.map((t) => t.pane)).toEqual(["w1:p2"]));
  await say({ type: "attach", cell: "c2", sessionId: "t1", cols: 80, rows: 24 });
  streams.at(-1)!.frame("shell", { full: true });
  await batched();
  await say({ type: "closeTerminal", terminalId: "t1" });
  await vi.waitFor(async () => {
    await say({ type: "historyList", token: 2 });
    expect(win.posts.filter((p) => p.type === "historyPage").at(-1)?.terminals?.map((t) => [t.id, t.pane, t.title])).toEqual([["t1", "w1:p2", path.basename(dir)]]);
  });
  await vi.waitFor(() => expect(fs.readdirSync(path.join(recordingsDir, "w1_p2")).every((n) => /^\d+-\d+\.rec$/.test(n))).toBe(true));
  await say({ type: "replay", cell: "c2", id: "t1" });
  await vi.waitFor(() => expect(replays()).toHaveLength(4));
  expect(replays().at(-1)).toMatchObject({ id: "t1", records: [expect.objectContaining({ full: true })] });
  expect(text(replays().at(-1)!.records[0]!)).toBe("shell");

  // Turned off: what is being recorded stops, and nothing new is recorded.
  await say({ type: "attach", cell: "c1", sessionId: "a", cols: 80, rows: 24 });
  w.ctx.settings.set({ ...w.ctx.settings.get(), terminalRecording: { enabled: false, maxTotalMB: 1024, keepDays: 14 } });
  await settle();
  const before = fs.readdirSync(path.join(recordingsDir, "w1_p1")).length;
  streams.at(-1)!.frame("unrecorded", { full: true });
  await batched();
  await say({ type: "detach", cell: "c1" });
  await settle();
  expect(fs.readdirSync(path.join(recordingsDir, "w1_p1")).length).toBeLessThanOrEqual(before);
  win.spec.onClose();
});
