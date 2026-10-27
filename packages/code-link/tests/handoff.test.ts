/**
 * A free conversation (no ticket) handed to a terminal cell and back: its warm runtime closed, its engine's CLI
 * resuming the same session in the folder the SDK runs use, nothing starting here meanwhile, and the next message
 * here resuming the session the CLI's hooks reported once it exited.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { Context } from "cordis";
import { Agent, type Engine } from "@tomradex/agent";
import { CodeLink, HANDOFF_PROMPT } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import { agentWorkspace } from "@tomradex/engine-kit";
import GitHubAccount from "@tomradex/github";
import { Herdr } from "@tomradex/herdr";
import { Mcp } from "@tomradex/mcp";
import { Repos } from "@tomradex/repos";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { FakeHerdr, fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-handoff-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function machine() {
  const hubDir = path.join(root, "hub");
  fs.mkdirSync(hubDir, { recursive: true });
  const turns: { text: string; resume: string | undefined; cwd: string | undefined }[] = [];
  const released: { projectId: string; threadId: string }[] = [];
  let holding = false;
  let letGo = () => {};
  const cli: Engine = {
    id: "fake-cli",
    title: "Fake CLI",
    author: "ai:fake-cli",
    capabilities: ["backlog", "code"],
    available: async () => ({ ok: true }),
    async turn(input, io) {
      const text = input.input.kind === "text" ? input.input.text : "";
      turns.push({ text, resume: io.resume, cwd: input.cwd });
      if (text === "hold") await new Promise<void>((resolve) => { letGo = resolve; holding = true; io.signal.addEventListener("abort", () => resolve(), { once: true }); });
      io.emit({ type: "text", text: "ok" });
      return { stop: "end", resume: io.resume ?? "cli-1" };
    },
    release: (thread) => void released.push(thread)
  };
  // an agent that runs only inside Tomrade: nothing to resume in a terminal
  const inside: Engine = { id: "inside", title: "Inside", author: "ai:inside", capabilities: ["backlog", "code"], terminal: { mode: "none" }, available: async () => ({ ok: true }), async turn() { return { stop: "end" }; } };
  const enginePlugin = { name: "fake-cli-engine", inject: ["agent"], apply: (ctx: Context) => { ctx.agent.engine(cli); ctx.agent.engine(inside); } };
  const bag = await fresh({
    hubDir,
    plugins: [
      Tools, [Settings, { path: path.join(hubDir, "settings.json") }], GitHubAccount,
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      Repos, Contributions, Agent, enginePlugin,
      [CodeLink, { scanMs: 0, defaultsPath: path.join(hubDir, "code-link.json") }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  bag.ctx.agent.store.setBrief(bag.project.id, "Test project: the brief is written.");
  bag.ctx.codeLink.pulls = async () => null;
  await bag.ctx.plugin(Mcp, { port: 0 });
  const fake = new FakeHerdr();
  await bag.ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket });
  await settle();
  return { ...bag, codeLink: bag.ctx.codeLink, agent: bag.ctx.agent, turns, released, fake, held: () => holding, letGo: () => letGo() };
}

it("takes a free conversation to a terminal cell in the folder its runs use, keeps a second process off its session, and brings it back once the CLI exited", { timeout: 30_000 }, async () => {
  const { ctx, project, codeLink, agent, turns, released, fake, held, letGo } = await machine();
  try {
    // an agent that runs only inside Tomrade has no way to a terminal; a conversation that never ran has nothing to resume
    const inside = agent.newThread(project.id, "inside", null, { title: "Inside only" });
    expect(codeLink.handoffOf(project.id, inside.id)).toEqual({ where: "here", toTerminal: { ok: false, reason: "builtin" }, terminal: null });
    const thread = agent.newThread(project.id, "fake-cli", null, { title: "Dedupe chat" });
    expect(codeLink.handoffOf(project.id, thread.id)).toEqual({ where: "here", toTerminal: { ok: false, reason: "noSession" }, terminal: null });
    expect(await codeLink.toTerminal(project.id, thread.id)).toEqual({ ok: false, message: "Nothing to resume yet: say something here first, so Fake CLI opens a session." });
    const first = agent.send(project.id, thread.id, { kind: "text", text: "hi" });
    await until(() => agent.store.run(project.id, first.runId)?.status === "done");
    expect(agent.store.external(project.id, thread.id)).toEqual({ "fake-cli": "cli-1" });
    // not while a turn runs
    const second = agent.send(project.id, thread.id, { kind: "text", text: "hold" });
    await until(held);
    expect(codeLink.handoffOf(project.id, thread.id)).toEqual({ where: "here", toTerminal: { ok: false, reason: "running" }, terminal: null });
    expect(await codeLink.toTerminal(project.id, thread.id)).toEqual({ ok: false, message: "A turn is in progress; stop it, or wait for it to end." });
    letGo();
    await until(() => agent.store.run(project.id, second.runId)?.status === "done");
    expect(codeLink.handoffOf(project.id, thread.id)).toEqual({ where: "here", toTerminal: { ok: true }, terminal: null });

    // to the terminal: the runtime here closed first, then the CLI in the thread's own folder, resuming its session with Tomrade's hooks
    const moved = await codeLink.toTerminal(project.id, thread.id);
    expect(moved).toMatchObject({ ok: true, launched: true, pane: "w1:p1" });
    expect(released).toEqual([{ projectId: project.id, threadId: thread.id }]);
    const sessionId = moved.ok ? moved.sessionId : "";
    const folder = agentWorkspace(project.id, thread.id);
    expect(codeLink.store.session(project.id, sessionId)).toMatchObject({ mode: "terminal", threadId: thread.id, itemIds: [], agent: "fake-cli", externalId: "cli-1", title: "Dedupe chat", cwd: folder, herdrPane: "w1:p1", state: "running" });
    expect(fake.of("workspace.create")).toEqual([{ cwd: folder, label: project.name, focus: false }]);
    const dir = codeLink.sessionDir(sessionId);
    const script = fs.readFileSync(path.join(dir, "run.command"), "utf8");
    expect(script).toContain("--resume cli-1");
    expect(script).toContain("--mcp-config");
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toBe(HANDOFF_PROMPT);
    // the conversation left the panel's list for the bar's, and says where it went and what changes there
    expect(agent.store.thread(project.id, thread.id)).toMatchObject({ surface: "code" });
    expect(agent.store.threads(project.id).map((th) => th.id)).not.toContain(thread.id);
    const notes = () => agent.store.messages(project.id, thread.id).flatMap((m) => (m.block.type === "note" ? [m.block.text] : []));
    expect(notes().at(-1)).toBe("Moved to a terminal cell (pane w1:p1): Fake CLI resumes this session there. Tomrade's approval cards and permission settings do not apply in the terminal — the CLI asks there itself.");
    expect(codeLink.handoffOf(project.id, thread.id)).toEqual({ where: "terminal", toTerminal: { ok: false, reason: "running" }, terminal: { sessionId, live: true, pane: "w1:p1", agent: "fake-cli" } });
    // one process on the session: nothing starts here, and it cannot come back while the CLI runs
    expect(() => agent.send(project.id, thread.id, { kind: "text", text: "more" })).toThrow("This conversation goes on with Fake CLI in a terminal (pane w1:p1); bring it back to the conversation first.");
    expect(agent.activeRuns()).toEqual([]);
    expect(await codeLink.backToPanel(project.id, thread.id)).toEqual({ ok: false, message: "Fake CLI still runs this conversation in the terminal (pane w1:p1). Wait for it to exit there, or close it." });
    expect(await codeLink.toTerminal(project.id, thread.id)).toEqual({ ok: false, message: "This conversation is already in a terminal." });

    // the CLI ran as its hooks say, and exited
    codeLink.sessions.event(project.id, sessionId, { hook_event_name: "SessionStart", session_id: "cli-2", cwd: folder });
    codeLink.sessions.event(project.id, sessionId, { hook_event_name: "SessionEnd" });
    expect(codeLink.handoffOf(project.id, thread.id)).toMatchObject({ where: "terminal", terminal: { sessionId, live: false } });
    expect(await codeLink.backToPanel(project.id, thread.id)).toMatchObject({ ok: true, sessionId });
    expect(agent.store.thread(project.id, thread.id)).toMatchObject({ surface: "assistant" });
    expect(agent.store.threads(project.id).map((th) => th.id)).toContain(thread.id);
    expect(agent.store.external(project.id, thread.id)).toEqual({ "fake-cli": "cli-2" });
    expect(notes().at(-1)).toBe("Back in the conversation: the next message goes on through Fake CLI with the same session.");
    expect(codeLink.handoffOf(project.id, thread.id)).toEqual({ where: "here", toTerminal: { ok: true }, terminal: null });
    expect(await codeLink.backToPanel(project.id, thread.id)).toEqual({ ok: false, message: "This conversation is not in a terminal." });
    // an app start keeps terminal conversations in the bar only while their session lives: one brought back stays back
    ctx.emit("db/opened", project.id);
    expect(agent.store.thread(project.id, thread.id)).toMatchObject({ surface: "assistant" });
    // the next message here resumes the session the CLI ran as, through the SDK, in the same folder
    const next = agent.send(project.id, thread.id, { kind: "text", text: "and now" });
    await until(() => agent.store.run(project.id, next.runId)?.status === "done");
    expect(turns.at(-1)).toEqual({ text: "and now", resume: "cli-2", cwd: undefined });
  } finally {
    fake.close();
    await ctx.fiber.dispose();
  }
});

it("starts a coding agent on the person's own words with no ticket: a terminal session in the project's folder, the words its first prompt", { timeout: 30_000 }, async () => {
  const { ctx, project, codeLink, fake } = await machine();
  try {
    expect(await codeLink.startLoose(project.id, { engine: "fake-cli", prompt: "  " })).toMatchObject({ ok: false, gate: "prompt" });
    // an agent that runs only inside Tomrade has no terminal to start in
    expect(await codeLink.startLoose(project.id, { engine: "inside", prompt: "Tidy up" })).toMatchObject({ ok: false, gate: "engine" });
    const started = await codeLink.startLoose(project.id, { engine: "fake-cli", prompt: "Tidy the release notes\nand the changelog" });
    expect(started).toMatchObject({ ok: true, launched: true, threadId: null, mode: "terminal", engine: "fake-cli", branch: "" });
    const sessionId = started.ok ? started.sessionId : "";
    // no repository on this machine: the home folder
    expect(codeLink.store.session(project.id, sessionId)).toMatchObject({ mode: "terminal", threadId: null, itemIds: [], agent: "fake-cli", title: "Tidy the release notes", cwd: os.homedir(), prompted: true, state: "running" });
    expect(codeLink.store.session(project.id, sessionId)?.herdrPane).toBe(started.ok ? started.pane : null);
    const dir = codeLink.sessionDir(sessionId);
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toMatch(/^Tidy the release notes\nand the changelog\n\nLanguage: /);
    const script = fs.readFileSync(path.join(dir, "run.command"), "utf8");
    expect(script).toContain("--mcp-config");
    expect(script).not.toContain("--resume");
  } finally {
    fake.close();
    await ctx.fiber.dispose();
  }
});
