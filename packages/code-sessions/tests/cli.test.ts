import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { Service, type Context } from "cordis";
import CodeSessions, { type Layout, type WindowPost, type WindowState } from "@tomradex/code-sessions";
import { engineNamed, type TermAnswer } from "../src/cli.js";
import { Contributions } from "@tomradex/contributions";
import { Settings } from "@tomradex/settings";
import { Herdr } from "@tomradex/herdr";
import { FakeHerdr, fresh, settle } from "@tomradex/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-term-cli-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const until = (check: () => boolean) => vi.waitUntil(check, { timeout: 20_000, interval: 10 });

it("knows a coding agent by its id or name, whole or by how it starts", () => {
  const engines = [{ id: "claude-code", title: "Claude Code" }, { id: "codex", title: "Codex" }, { id: "pi", title: "Pi" }];
  expect(engineNamed(engines, "codex")?.id).toBe("codex");
  expect(engineNamed(engines, "claude")?.id).toBe("claude-code");
  expect(engineNamed(engines, "Claude Code")?.id).toBe("claude-code");
  expect(engineNamed(engines, "PI")?.id).toBe("pi");
  expect(engineNamed(engines, "gemini")).toBeUndefined();
  expect(engineNamed(engines, "")).toBeUndefined();
});

it("answers tomrade term over the MCP port: a pane in the folder, a ticket started with an agent, a pane handed to the person's terminal", async () => {
  const fake = new FakeHerdr();
  const repo = fs.mkdtempSync(path.join(dir, "repo-"));
  const elsewhere = fs.mkdtempSync(path.join(dir, "elsewhere-"));
  const opened: { spec: { onMessage(m: unknown): void; onClose(): void; initialState: unknown }; states: WindowState[]; posts: WindowPost[]; focused: number }[] = [];
  const handlers = new Map<string, (request: Record<string, unknown>) => Promise<TermAnswer>>();
  const starts: unknown[] = [];
  const sessions: Record<string, unknown>[] = [];

  class FakeSurfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
    open(spec: (typeof opened)[number]["spec"]) {
      const entry = { spec, states: [spec.initialState as WindowState], posts: [] as WindowPost[], focused: 0 };
      opened.push(entry);
      return { id: "s", capabilities: { programmaticPosition: true, forwardedMouseMoves: false }, bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), workArea: () => ({ x: 0, y: 0, width: 1, height: 1 }), setPosition() {}, focus: () => void entry.focused++, setState: (s: WindowState) => void entry.states.push(s), post: (m: WindowPost) => void entry.posts.push(m), close: () => spec.onClose() };
    }
  }
  class FakeMcp extends Service {
    static provide = "mcp";
    constructor(ctx: Context) {
      super(ctx, "mcp");
    }
    cli(name: string, handler: (request: Record<string, unknown>) => Promise<TermAnswer>) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    }
  }
  class FakeAgent extends Service {
    static provide = "agent";
    constructor(ctx: Context) {
      super(ctx, "agent");
    }
    codeEngines = () => [{ id: "claude-code", title: "Claude Code" }, { id: "codex", title: "Codex" }];
    engineOf = (id: string) => this.codeEngines().find((e) => e.id === id);
  }
  class FakeCodeLink extends Service {
    static provide = "codeLink";
    constructor(ctx: Context) {
      super(ctx, "codeLink");
    }
    sessionsOf = () => sessions;
    links = () => [];
    repositoriesOf = () => [{ workstream: "Main", name: "tomrade", path: repo, defaultBranch: "main" }];
    repositoryFoldersOf = () => [{ name: "tomrade", path: repo }];
    herdrInstall = async () => ({ command: null, guide: "" });
    startDefaults = () => ({ mode: "terminal", engine: "claude-code", options: { model: "opus" } });
    start = async (projectId: string, itemId: string, opts: Record<string, unknown>) => {
      starts.push({ projectId, itemId, opts });
      sessions.push({ id: "s9", itemIds: [itemId], branch: "tom-1/ship-it", state: "running", mode: "terminal", agent: opts.engine, herdrPane: "w1:p9", terminal: null, device: "here", threadId: null, worktree: null, activity: null, summary: null, blocked: null, startedAt: 2, endedAt: null, lastEventAt: null });
      return { ok: true, continued: false, threadId: null, sessionId: "s9", branch: "tom-1/ship-it", worktree: null, cwd: repo, mode: "terminal", command: "codex", launched: true, pane: "w1:p9", engine: opts.engine ?? "claude-code" };
    };
    // The window puts the session in a cell, as it does for a start shown in it.
    showSession = async (_projectId: string, sessionId: string) => {
      setTimeout(() => opened[0]!.spec.onMessage({ type: "layout", layout: { type: "split", id: "s1", direction: "row", ratio: 0.5, a: layoutNow(), b: { type: "leaf", id: "c3", sessionId } } }), 20);
      return true;
    };
  }
  let laid: Extract<Layout, { type: "split" }> | null = null;
  const layoutNow = () => laid!;

  const w = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings.json") }], Contributions, FakeSurfaces, FakeAgent, FakeMcp, [Herdr, { socket: fake.socket, bin: path.join(dir, "herdr"), reconnectMs: 30 }], FakeCodeLink, [CodeSessions, { document: "file:///ui/code-sessions.html", stateFile: path.join(dir, "state.json") }]] });
  const herdr = w.ctx.get("herdr")!;
  herdr.bridge = async () => ({ state: "ready", version: "0.9.5" });
  fake.answer = (method, params) => (method === "pane.get" && params.pane_id === "w1:p1" ? { result: { type: "pane_info", pane: { pane_id: "w1:p1", terminal_id: "term_one" } } } : undefined);
  const activated: number[] = [];
  w.ctx.on("desktop/activate", () => void activated.push(1));
  await settle();
  const term = handlers.get("term")!;
  expect(term).toBeDefined();

  // `tomrade term .` in the repository: a terminal there, brought into a cell, and that cell's number said.
  const answer = term({ op: "open", cwd: repo });
  await until(() => opened.length === 1 && !!opened[0]!.states.at(-1)?.reveal);
  const win = opened[0]!;
  const id = win.states.at(-1)!.reveal!.sessionId;
  expect(win.states.at(-1)!.terminals.find((t) => t.id === id)).toMatchObject({ cwd: repo, pane: "w1:p1" });
  laid = { type: "split", id: "s0", direction: "row", ratio: 0.5, a: { type: "leaf", id: "c1", sessionId: null }, b: { type: "leaf", id: "c2", sessionId: id } };
  win.spec.onMessage({ type: "layout", layout: laid });
  expect(await answer).toEqual({ ok: true, text: `Opened pane 2 in the Terminal window · ${repo}` });
  expect(activated.length).toBe(1);
  expect(fake.of("workspace.create")).toEqual([{ cwd: repo, label: w.project.name, focus: false }]);
  // A folder no project holds goes to the project the window showed last.
  const other = term({ op: "open", cwd: elsewhere });
  await until(() => win.states.at(-1)!.reveal!.sessionId !== id);
  const second = win.states.at(-1)!.reveal!.sessionId;
  win.spec.onMessage({ type: "layout", layout: { ...laid, b: { type: "split", id: "s2", direction: "column", ratio: 0.5, a: laid.b, b: { type: "leaf", id: "c4", sessionId: second } } } });
  expect((await other).text).toBe(`Opened pane 3 in the Terminal window · ${elsewhere}`);
  win.spec.onMessage({ type: "layout", layout: laid });
  expect(await term({ op: "open", cwd: path.join(dir, "missing") })).toEqual({ ok: false, text: "That folder does not exist" });

  // `--attach`: the panes listed by number, as the window numbers them; one with a terminal handed to herdr's own client.
  const name = path.basename(repo);
  expect(await term({ op: "attach", cwd: repo })).toEqual({ ok: true, text: `The panes of ${w.project.name}'s Terminal window:`, cells: ["1  empty", `2  ${name} · ${repo}`] });
  expect(await term({ op: "attach", cwd: repo, cell: 2 })).toEqual({ ok: true, text: `Attaching pane 2 · ${name} · ${repo}. herdr's detach key (Ctrl+B, then Q) hands it back to Tomrade, where it goes on.`, attach: { herdr: path.join(dir, "herdr"), socket: fake.socket, terminal: "term_one" }, projectId: w.project.id, cell: "c2" });
  expect(await term({ op: "attach", cwd: repo, cell: 1 })).toMatchObject({ ok: false, text: "Pane 1 shows no terminal to attach", cells: expect.any(Array) });
  expect(await term({ op: "attach", cwd: repo, cell: 7 })).toMatchObject({ ok: false, text: `${w.project.name}'s Terminal window has no pane 7. Its panes:` });
  // Let go by the person's terminal: the cell streams it again.
  await term({ op: "detached", projectId: w.project.id, cell: "c2" });
  expect(win.posts).toContainEqual({ type: "reattach", cell: "c2" });

  // `--agent codex TOM-1`: code link's own Start, in a terminal, with that agent; the cell it lands in is said.
  const ticket = w.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Ship it", by: "human" });
  expect((await term({ op: "start", cwd: repo, key: ticket.key.toLowerCase(), agent: "codex" })).text).toBe(`Pane 3 · claimed ${ticket.key} · started Codex on tom-1/ship-it`);
  expect(starts).toEqual([{ projectId: w.project.id, itemId: ticket.id, opts: { mode: "terminal", engine: "codex" } }]);
  // Unnamed, the agent last started with, and its options.
  await term({ op: "start", cwd: repo, key: ticket.key });
  expect(starts[1]).toEqual({ projectId: w.project.id, itemId: ticket.id, opts: { mode: "terminal", engine: "claude-code", options: { model: "opus" } } });
  expect(await term({ op: "start", cwd: repo, key: ticket.key, agent: "gemini" })).toEqual({ ok: false, text: "No coding agent called gemini. The ones here: claude-code, codex" });
  expect(await term({ op: "start", cwd: repo, key: "TOM-404" })).toEqual({ ok: false, text: "No ticket TOM-404 in your projects on this computer" });
  win.spec.onClose();
}, 30_000);
