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
import { CodeLink, HANDOFF_PROMPT, handedPrompt } from "@tomradex/code-link";
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

it("lets a built-in assistant's conversation claim a ticket for the code it turns to, and hands it to a CLI agent in a terminal cell with what it came to", { timeout: 30_000 }, async () => {
  const { ctx, project, codeLink, agent, fake } = await machine();
  try {
    const thread = agent.newThread(project.id, "inside", null, { title: "Dedupe script" });
    const said = agent.send(project.id, thread.id, { kind: "text", text: "write a dedupe script" });
    await until(() => agent.store.run(project.id, said.runId)?.status === "done");
    // claimed: a new ticket named after the conversation, on it from here, marked by a note where its code starts
    const claimed = await codeLink.claimThread(project.id, thread.id);
    expect(claimed).toMatchObject({ ok: true, branch: null });
    const item = claimed.ok ? ctx.items.get(project.id, claimed.itemId)! : null;
    expect(item).toMatchObject({ title: "Dedupe script", status: "doing", workType: "coding" });
    expect(agent.store.thread(project.id, thread.id)).toMatchObject({ itemId: item!.id });
    const note = agent.store.messages(project.id, thread.id).at(-1)!.block;
    expect(note).toEqual({ type: "note", text: `Claimed ${item!.key}: the code from here is written for it.`, claimed: item!.key });
    // claiming again keeps the ticket it is on
    expect(await codeLink.claimThread(project.id, thread.id)).toMatchObject({ ok: true, itemId: item!.id });
    expect(ctx.items.list({ projectId: project.id }).length).toBe(1);
    // a conversation writing in the background for another claims nothing itself
    const child = agent.newThread(project.id, "inside", null, { title: "child", parentId: thread.id });
    expect(await codeLink.claimThread(project.id, child.id)).toEqual({ ok: false, message: "Only a conversation of the assistant panel claims a ticket this way." });

    // to a CLI agent: not one that runs only inside Tomrade; a CLI starts afresh in the thread's folder with the recap
    expect(await codeLink.toCli(project.id, thread.id, "inside")).toEqual({ ok: false, message: "Inside runs only inside Tomrade, so a terminal cannot take this conversation up." });
    const recap = handedPrompt("Dedupe script", "");
    const handed = await codeLink.toCli(project.id, thread.id, "fake-cli");
    expect(handed).toMatchObject({ ok: true, launched: true });
    const sessionId = handed.ok ? handed.sessionId : "";
    expect(codeLink.store.session(project.id, sessionId)).toMatchObject({ mode: "terminal", threadId: thread.id, agent: "fake-cli", externalId: null, state: "running" });
    expect(agent.store.thread(project.id, thread.id)).toMatchObject({ engine: "fake-cli", surface: "code", itemId: item!.id });
    const dir = codeLink.sessionDir(sessionId);
    expect(fs.readFileSync(path.join(dir, "run.command"), "utf8")).not.toContain("--resume");
    const prompt = fs.readFileSync(path.join(dir, "prompt.md"), "utf8");
    expect(prompt.startsWith(recap.split("\n")[0]!)).toBe(true);
    expect(prompt).toContain("User: write a dedupe script");
    expect(agent.store.messages(project.id, thread.id).at(-1)!.block).toMatchObject({ type: "note", text: expect.stringMatching(/^Handed to Fake CLI in a terminal cell \(pane w1:p\d+\), with what this conversation came to/) });
  } finally {
    fake.close();
    await ctx.fiber.dispose();
  }
});

it("takes an ended session on no ticket up again in the background, as the same session, and only once", { timeout: 30_000 }, async () => {
  const { ctx, project, codeLink, fake } = await machine();
  try {
    const cwd = path.join(root, "loose");
    fs.mkdirSync(cwd, { recursive: true });
    const session = codeLink.store.createSession(project.id, { repoId: "", branch: "", itemIds: [], mode: "terminal", agent: "fake-cli", threadId: null, device: "here", externalId: "cli-9" });
    codeLink.store.patchSession(project.id, session.id, { cwd, title: "Loose chat", state: "ended", endedAt: Date.now() });
    const resumed = await codeLink.resumeSession(project.id, session.id);
    expect(resumed).toMatchObject({ ok: true, sessionId: session.id, launched: true });
    expect(codeLink.store.session(project.id, session.id)).toMatchObject({ state: "running", endedAt: null, externalId: "cli-9" });
    expect(fs.readFileSync(path.join(codeLink.sessionDir(session.id), "run.command"), "utf8")).toContain("--resume cli-9");
    // running again: a second process on the same session is refused
    expect(await codeLink.resumeSession(project.id, session.id)).toMatchObject({ ok: false });
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

it("ends a terminal session and cuts its link when its conversation is deleted, so nothing lists a thread that is gone", { timeout: 30_000 }, async () => {
  const { ctx, project, codeLink, agent, fake } = await machine();
  try {
    const thread = agent.newThread(project.id, "fake-cli", null, { title: "Doomed chat" });
    const sent = agent.send(project.id, thread.id, { kind: "text", text: "hi" });
    await until(() => agent.store.run(project.id, sent.runId)?.status === "done");
    const moved = await codeLink.toTerminal(project.id, thread.id);
    const sessionId = moved.ok ? moved.sessionId : "";
    expect(codeLink.store.session(project.id, sessionId)).toMatchObject({ threadId: thread.id, state: "running" });
    expect(agent.deleteThread(project.id, thread.id)).toBe(true);
    expect(codeLink.store.session(project.id, sessionId)).toMatchObject({ threadId: null, state: "ended" });
  } finally {
    // a session an older version left behind: its conversation is gone, the link stays until the project opens
    const old = agent.newThread(project.id, "fake-cli", null, { title: "Old chat" });
    const left = codeLink.store.createSession(project.id, { repoId: "", branch: "", itemIds: [], mode: "terminal", agent: "fake-cli", threadId: old.id, device: "d" });
    agent.store.deleteThread(project.id, old.id);
    expect(codeLink.store.session(project.id, left.id)).toMatchObject({ threadId: old.id });
    ctx.emit("db/opened", project.id);
    expect(codeLink.store.session(project.id, left.id)).toMatchObject({ threadId: null, state: "ended" });
    fake.close();
    await ctx.fiber.dispose();
  }
});
