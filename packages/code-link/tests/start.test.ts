/**
 * Start hands a ticket to a local coding agent: six gates, then a thread on
 * the ticket's branch in a worktree of its own, a session that follows the
 * agent, and the tools the agent reports back with. A fake code engine stands
 * in for Claude Code so the whole path runs offline.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Context } from "cordis";
import { Agent, type Engine, type TurnInput } from "@tomradex/agent";
import { fakeLlm } from "@tomradex/llm";
import { CodeLink, BOOTSTRAP_LABEL, sessionContext, terminalApp, type StartBatchCard, type StartResult } from "@tomradex/code-link";
import { geminiHooks } from "../src/gemini-hooks.js";
import { Contributions } from "@tomradex/contributions";
import { Repos, normalizeRemote } from "@tomradex/repos";
import GitHubAccount from "@tomradex/github";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { FakeHerdr, fresh, settle } from "@tomradex/testkit";
import { Herdr, herdrInstall } from "@tomradex/herdr";
import { Tools, defineTool } from "@tomradex/tools";
import { z } from "zod";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-start-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
/** Each shape built once with git, then copied: every spawn costs, and a fresh repository is the same bytes each time. */
const templates = new Map<string, { remote: string; checkout: string }>();
function codeRepo(opts: { manifest?: boolean } = {}): { remote: string; checkout: string } {
  const key = `${opts.manifest !== false}`;
  let template = templates.get(key);
  if (!template) {
    const remote = path.join(root, `template-${key}-remote.git`);
    fs.mkdirSync(remote, { recursive: true });
    git(["init", "--bare", "-b", "main", "."], remote);
    const checkout = path.join(root, `template-${key}-checkout`);
    fs.mkdirSync(checkout, { recursive: true });
    git(["init", "-q", "-b", "main"], checkout);
    git(["remote", "add", "origin", remote], checkout);
    git(["config", "user.email", "dev@localhost"], checkout);
    git(["config", "user.name", "Dev"], checkout);
    fs.writeFileSync(path.join(checkout, "README.md"), "# app\n");
    if (opts.manifest !== false) fs.writeFileSync(path.join(checkout, "package.json"), '{ "name": "app" }\n');
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "initial"], checkout);
    git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], checkout);
    template = { remote, checkout };
    templates.set(key, template);
  }
  const remote = path.join(root, `remote-${n++}.git`);
  const checkout = path.join(root, `checkout-${n++}`);
  fs.cpSync(template.remote, remote, { recursive: true });
  fs.cpSync(template.checkout, checkout, { recursive: true });
  git(["remote", "set-url", "origin", remote], checkout);
  return { remote, checkout };
}

/** A repository with no remote: a folder of its own with one commit on main. */
function localRepo(): string {
  const folder = path.join(root, `local-${n++}`);
  fs.mkdirSync(folder);
  git(["init", "-q", "-b", "main"], folder);
  git(["config", "user.email", "dev@localhost"], folder);
  git(["config", "user.name", "Dev"], folder);
  fs.writeFileSync(path.join(folder, "package.json"), '{ "name": "app" }\n');
  git(["add", "-A"], folder);
  git(["commit", "-q", "-m", "initial"], folder);
  return folder;
}

function gitWithFailure(command: "ls-remote" | "push", stderr: string): string {
  const file = path.join(root, `git-${n++}`);
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "${command}" ]; then\n  echo "${stderr.replaceAll('"', '\\"')}" >&2\n  exit 128\nfi\nexec git "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** A code-capable engine that records what it was asked and makes one commit in the worktree. */
function fakeCodeEngine(turns: TurnInput[]): Engine {
  return {
    id: "fake-code",
    title: "Fake coding agent",
    author: "ai:fake-code",
    capabilities: ["backlog", "code", "general"],
    available: async () => ({ ok: true }),
    async turn(input, io) {
      turns.push(input);
      if (input.input.kind === "text" && input.input.text === "hold for transfer") {
        await new Promise<void>((resolve) => {
          if (io.signal.aborted) resolve();
          else io.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { stop: "cancelled", resume: io.resume };
      }
      // An orientation pass: the agent reads and writes the brief, nothing else.
      if (input.purpose === "backlog" && input.input.kind === "text" && input.input.text.startsWith("Orientation:")) {
        await io.tools.execute("update_project_brief", { body: "Shop: products are pulled from the supplier feed, never edited here." });
        io.emit({ type: "text", text: "brief written" });
        return { stop: "end", resume: "fake-session-o" };
      }
      if (input.cwd && input.purpose === "code") {
        fs.writeFileSync(path.join(input.cwd, `work-${turns.length}.ts`), "export {};\n");
        git(["add", "-A"], input.cwd);
        git(["commit", "-q", "-m", `${input.ticket?.key ?? "TOM-0"}: work`], input.cwd);
      }
      io.emit({ type: "text", text: "done a step" });
      return { stop: "end", resume: "fake-session-1" };
    }
  };
}

async function machine(repo: { remote: string; checkout: string } | null, opts: { gitBinary?: string; defaultsPath?: string; llm?: (system: string, user: string) => unknown; codeEngine?: false; brief?: false; startTimeoutMs?: number } = {}) {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const turns: TurnInput[] = [];
  const enginePlugin = { name: "fake-code-engine", inject: ["agent"], apply: (ctx: Context) => void ctx.agent.engine(fakeCodeEngine(turns)) };
  const bag = await fresh({
    hubDir,
    plugins: [
      Tools,
      [Settings, { path: path.join(hubDir, "settings.json") }], GitHubAccount,
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      [Repos, { gitBinary: opts.gitBinary ?? "git" }],
      Contributions,
      Agent,
      ...(opts.codeEngine === false ? [] : [enginePlugin]),
      ...(opts.llm ? [fakeLlm(opts.llm)] : []),
      [CodeLink, { scanMs: 0, gitBinary: opts.gitBinary ?? "git", defaultsPath: opts.defaultsPath ?? path.join(hubDir, "code-link.json"), ...(opts.startTimeoutMs ? { startTimeoutMs: opts.startTimeoutMs } : {}) }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  // A project that already knows its code: no orientation starts under a test about something else.
  if (opts.brief !== false) bag.ctx.agent.store.setBrief(bag.project.id, "Test project: the brief is written.");
  let row = null as ReturnType<typeof bag.ctx.repos.create> | null;
  if (repo) {
    row = bag.ctx.repos.create({ projectId: bag.project.id, remote: repo.remote });
    bag.boards.update(bag.project.id, bag.board.id, { repoId: row.id });
  }
  const ticket = (title: string, status: "backlog" | "todo" | "doing" = "todo") => bag.items.create({ projectId: bag.project.id, boardId: bag.board.id, title, workType: "coding", status, by: "human" });
  // GitHub is never asked from a test; one that needs its answer sets its own.
  bag.ctx.codeLink.pulls = async () => null;
  return { ...bag, codeLink: bag.ctx.codeLink, agent: bag.ctx.agent, repo: row, checkout: repo?.checkout ?? null, hubDir, turns, ticket };
}

async function until(check: () => boolean, timeout = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("offers no terminal app of your own first in Settings — automatic — and keeps it unset while other settings are saved", async () => {
  const { ctx } = await machine(null);
  const field = (ctx.settings.sections("en").find((s) => s.id === "codeLink")!.schema.properties as Record<string, { enum: string[]; enumLabels: Record<string, string> }>).terminal;
  expect(field.enum[0]).toBe("auto");
  expect(field.enumLabels.auto).toBe("No — Tomrade's own terminal (automatic)");
  expect(field.enum).not.toContain("herdr");
  expect(field.enum.at(-1)).toBe("none");
  expect((ctx.settings.sections("zh").find((s) => s.id === "codeLink")!.schema.properties as Record<string, { enumLabels: Record<string, string> }>).terminal.enumLabels.auto).toBe("不用：Tomrade 自己的终端（自动）");
  // The window saves every section at once: an untouched terminal goes along as automatic, never as what it resolved to.
  ctx.settings.set({ ...ctx.settings.get(), theme: "dark" });
  expect(ctx.settings.get().codeLink?.terminal).toBe("auto");
});

it("continues a ticket a terminal agent claimed itself as a prompt in that agent's pane, and in a new pane once it closed", { timeout: 60_000 }, async () => {
  const { codeLink, ctx, project, repo, checkout, ticket } = await machine(codeRepo());
  await ctx.repos.setCheckout(repo!.remote, checkout!);
  const { Mcp } = await import("@tomradex/mcp");
  await ctx.plugin(Mcp, { port: 0 });
  const fake = new FakeHerdr();
  await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket });
  await settle();
  // One agent's pane, where it claimed this ticket over MCP (no thread of Tomrade's) beside others, and handed its merge over.
  const pane = fake.createPane(checkout!);
  const item = ticket("Claimed in a shared pane");
  codeLink.store.ensureActiveDelivery(project.id, item.id);
  const claimed = codeLink.store.createSession(project.id, { repoId: repo!.id, branch: `tom-${item.keyNum}/shared`, itemIds: [item.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId });
  codeLink.store.patchSession(project.id, claimed.id, { herdrPane: pane.pane_id });
  codeLink.sessions.blockMerge(project.id, claimed.id, "CI cannot start on this repository");

  // Waiting on the person there, its agent does not take a prompt: Continue says so, and starts nothing.
  fake.setStatus(pane.pane_id, "claude", "blocked");
  await settle();
  const held = await ctx.contributions.run("code-link.start-terminal", { projectId: project.id, itemId: item.id });
  expect(held.toast).toBe(`The agent in herdr pane ${pane.pane_id} still works this ticket and did not take the prompt — it may be waiting for you there. Go on with it in that pane.`);
  expect(fake.of("tab.create")).toEqual([]);
  expect(codeLink.store.sessions(project.id, { itemId: item.id })).toHaveLength(1);

  fake.setStatus(pane.pane_id, "claude", "working");
  await settle();
  const again = await codeLink.start(project.id, item.id, { mode: "terminal" });
  expect(again).toMatchObject({ ok: true, continued: true, launched: true, command: null, threadId: null, sessionId: claimed.id, pane: pane.pane_id });
  const file = path.join(codeLink.sessionDir(claimed.id), "prompt.md");
  expect(fake.of("agent.prompt").at(-1)).toEqual({ target: pane.pane_id, text: `Tomrade: continue ${item.key} — read ${file} and follow it.` });
  expect(fs.readFileSync(file, "utf8")).toContain("Last note: merge blocked: CI cannot start on this repository");
  // No second agent: no tab, no workspace, no other session on the ticket.
  expect(fake.of("tab.create")).toEqual([]);
  expect(fake.of("workspace.create")).toEqual([]);
  expect(codeLink.store.sessions(project.id, { itemId: item.id }).map((s) => s.id)).toEqual([claimed.id]);
  expect(codeLink.store.session(project.id, claimed.id)).toMatchObject({ state: "running", blocked: null });

  // Its pane gone, Continue starts the ticket in a terminal of its own, as before.
  fake.exit(pane.pane_id);
  const fresh = await codeLink.start(project.id, item.id, { mode: "terminal" });
  expect(fresh).toMatchObject({ ok: true, launched: true });
  expect(fresh.ok && fresh.sessionId).not.toBe(claimed.id);
  expect(fake.of("agent.prompt")).toHaveLength(2);
});

// Several Starts, each a worktree: well past the default timeout on a busy machine.
it("runs a ticket in a tab of its project's herdr workspace, follows the pane's status as the session's, and continues it in the same pane", { timeout: 60_000 }, async () => {
  const world = await machine(codeRepo());
  const { codeLink, ctx, project, repo, checkout, ticket } = world;
  await ctx.repos.setCheckout(repo!.remote, checkout!);
  const { Mcp } = await import("@tomradex/mcp");
  await ctx.plugin(Mcp, { port: 0 });
  const fake = new FakeHerdr();
  fake.stop();
  // A herdr CLI whose server never comes up: a launch with herdr stopped tries to start it, and goes elsewhere.
  const herdrBin = path.join(fs.mkdtempSync(path.join(root, "herdr-cli-")), "herdr");
  fs.writeFileSync(herdrBin, '#!/bin/sh\n[ "$1" = --version ] && echo "herdr 0.9.5" && exit 0\nexit 1\n', { mode: 0o755 });
  await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket, bin: herdrBin });
  await settle();
  // No saved terminal preference: herdr, once it is installed.
  expect(ctx.settings.get().codeLink?.terminal).toBe("auto");
  const installed = vi.spyOn(ctx.herdr, "installed").mockResolvedValue(null);
  expect(await codeLink.herdrStatus()).toBe("notInstalled");
  installed.mockResolvedValue("0.9.5");
  expect(await codeLink.herdrStatus()).toBe("notRunning");
  fake.start();
  const item = ticket("Herdr work");

  const result = await codeLink.start(project.id, item.id, { mode: "terminal" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // The project's workspace, its first tab named for the ticket, in its worktree, with the session's script typed into its pane.
  expect(result).toMatchObject({ mode: "terminal", launched: true, pane: "w1:p1" });
  expect(await codeLink.herdrStatus()).toBe("running");
  expect(fake.of("workspace.create")).toEqual([{ cwd: result.cwd, label: project.name, focus: false }]);
  expect(fake.of("tab.rename")).toEqual([{ tab_id: "w1:t1", label: item.key }]);
  const dir = codeLink.sessionDir(result.sessionId);
  expect(fake.of("pane.send_input")).toEqual([{ pane_id: "w1:p1", text: `bash '${path.join(dir, "run.command")}'`, keys: ["enter"] }]);
  expect(codeLink.store.session(project.id, result.sessionId)).toMatchObject({ herdrPane: "w1:p1", state: "running" });
  const row = async () => (await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!.rows.find((r) => r.label === "Session")!;
  expect((await row()).value).toContain("in herdr");
  await until(() => fake.of("events.subscribe").length === 2);
  // herdr's sidebar shows the ticket and where it stands, on its pane: the workspace is the project's.
  await until(() => fake.of("pane.report_metadata").length >= 1);
  expect(fake.of("pane.report_metadata").at(-1)).toEqual({ pane_id: "w1:p1", source: "tomrade", tokens: { ticket: item.key, status: "Doing", session: "running" } });

  // herdr's reading of the pane moves the session: blocked is "needs you", done a stop with what the screen says.
  fake.setStatus("w1:p1", "claude", "working");
  await until(() => codeLink.store.session(project.id, result.sessionId)!.lastEventAt !== null && codeLink.store.session(project.id, result.sessionId)!.state === "running");
  fake.setStatus("w1:p1", "claude", "blocked");
  await until(() => codeLink.store.session(project.id, result.sessionId)!.state === "waiting");
  // herdr names no tool: the ask is a permission, worded where it shows
  expect(codeLink.store.session(project.id, result.sessionId)).toMatchObject({ state: "waiting", activity: null, ask: { kind: "permission", tool: null, action: null, detail: null } });
  expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "waiting" })]));
  // …and the person at the terminal is told there, once.
  await until(() => fake.of("notification.show").length === 1);
  expect(fake.of("notification.show")).toEqual([{ title: `${item.key} needs you`, body: "waits for your approval", sound: "request" }]);
  await until(() => fake.of("pane.report_metadata").at(-1)?.tokens?.session === "waiting for you");
  fake.setStatus("w1:p1", "claude", "working");
  await until(() => codeLink.store.session(project.id, result.sessionId)!.state === "running");
  fake.panes.get("w1:p1")!.text = "⏺ Scaffold in place.\n╭────╮\n│ > │\n╰────╯\n? for shortcuts";
  fake.setStatus("w1:p1", "claude", "done");
  await until(() => codeLink.store.session(project.id, result.sessionId)!.state === "waiting");
  expect(codeLink.store.session(project.id, result.sessionId)!.summary).toBe("⏺ Scaffold in place.");
  // idle says nothing: the person may have looked, or not.
  fake.setStatus("w1:p1", "claude", "idle");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(codeLink.store.session(project.id, result.sessionId)!.state).toBe("waiting");

  // The session's own hook spoke: herdr's reading of the screen defers to it for a while.
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")) as { mcpServers: { tomrade: { headers: Record<string, string> } } };
  const token = mcpConfig.mcpServers.tomrade.headers["X-Tomrade-Run"];
  await fetch(ctx.mcp.eventUrlFor(token)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hook_event_name: "Stop", session_id: "cli-h", last_assistant_message: "Hooks say: done with tests." }) });
  expect(codeLink.store.session(project.id, result.sessionId)).toMatchObject({ state: "waiting", summary: "Hooks say: done with tests." });
  // The hook named the agent's own session: herdr is told how to bring it back, connected, after a restart of its own.
  await until(() => fake.of("pane.report_agent_session").length === 1);
  const resumeScript = path.join(dir, "resume.command");
  expect(fake.of("pane.report_agent_session")).toEqual([{ pane_id: "w1:p1", source: "tomrade", agent: "fake-code", agent_session_id: "cli-h", resume_argv: ["bash", resumeScript] }]);
  expect(fs.readFileSync(path.join(dir, "resume-id"), "utf8")).toBe("cli-h");
  const resume = fs.readFileSync(resumeScript, "utf8");
  expect(resume).toContain(`--resume "$(cat '${path.join(dir, "resume-id")}')"`);
  expect(resume).toContain(`--mcp-config "${path.join(dir, "mcp.json")}"`);
  expect(resume).toContain(`"$(cat "${path.join(dir, "resume-prompt.md")}")"`);
  expect(resume).toContain("export TOMRADE_MCP_TOKEN=");
  expect(fs.readFileSync(path.join(dir, "resume-prompt.md"), "utf8")).toContain("herdr restarted");
  fake.setStatus("w1:p1", "claude", "working");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(codeLink.store.session(project.id, result.sessionId)).toMatchObject({ state: "waiting", summary: "Hooks say: done with tests." });

  // Continue goes into the same pane as a prompt — no new workspace, the same token — and the prompt file is what it reads.
  const again = await codeLink.start(project.id, item.id, { mode: "terminal" });
  expect(again).toMatchObject({ ok: true, continued: true, launched: true, pane: "w1:p1", command: null, sessionId: result.sessionId });
  expect(fake.of("workspace.create").length).toBe(1);
  expect(fake.of("agent.prompt")).toEqual([{ target: "w1:p1", text: `Tomrade: continue this ticket — read ${path.join(dir, "prompt.md")} and follow it.` }]);
  expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toContain(item.key);
  expect(JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")).mcpServers.tomrade.headers["X-Tomrade-Run"]).toBe(token);
  expect(codeLink.store.session(project.id, result.sessionId)!.state).toBe("running");

  // The pane closing is the end of the session, whatever a hook said last; then Continue opens a new pane.
  fake.exit("w1:p1");
  await until(() => codeLink.store.session(project.id, result.sessionId)!.state === "ended");
  // …and the pane's sidebar row is cleared; the session id was reported once.
  await until(() => fake.of("pane.report_metadata").at(-1)?.tokens?.ticket === null);
  expect(fake.of("pane.report_metadata").at(-1)).toEqual({ pane_id: "w1:p1", source: "tomrade", tokens: { ticket: null, status: null, session: null } });
  expect(fake.of("pane.report_agent_session").length).toBe(1);
  const fresh2 = await codeLink.start(project.id, item.id, { mode: "terminal" });
  // A new tab in the same workspace.
  expect(fresh2).toMatchObject({ ok: true, launched: true, pane: "w1:p2" });
  expect(fake.of("workspace.create").length).toBe(1);
  expect(fake.of("tab.create")).toEqual([{ workspace_id: "w1", cwd: fresh2.ok ? fresh2.cwd : "", label: item.key, focus: false }]);

  // Jump to pane: herdr shows it and says so in its window…
  const opened = vi.spyOn(terminalApp, "open").mockResolvedValue();
  const jump = () => ctx.contributions.run("code-link.open-terminal", { projectId: project.id, itemId: item.id });
  expect((await jump()).toast).toBe("Shown in herdr (pane w1:p2)");
  expect(fake.of("pane.focus").at(-1)).toEqual({ pane_id: "w1:p2" });
  expect(fake.of("notification.show").at(-1)).toEqual({ title: `${item.key} · ${item.title}`, body: "", sound: "none" });
  expect(opened).not.toHaveBeenCalled();
  // …and with no herdr client attached to see it, the system terminal opens herdr's own, attached.
  fake.attached = false;
  expect((await jump()).toast).toBe(`Opened herdr in ${process.platform === "darwin" ? "Terminal" : "the system terminal"}, at pane w1:p2`);
  const attach = path.join(codeLink.sessionDir("herdr-attach"), "run.command");
  expect(opened).toHaveBeenLastCalledWith("Terminal", attach, os.homedir());
  expect(fs.readFileSync(attach, "utf8")).toContain(`exec '${herdrBin}'`);
  fake.attached = true;
  opened.mockClear();

  // With Tomrade's Terminal window on, the jump and a continue show the session there, and herdr's own client is left alone.
  const asked: string[] = [];
  const shows = ctx.on("codeLink/show-session", (_projectId, sessionId) => {
    asked.push(sessionId);
    return true;
  });
  const answers = ctx.on("codeLink/terminal-window", () => true);
  expect(await codeLink.terminalWindow(project.id)).toBe(true);
  const focused = fake.of("pane.focus").length;
  expect(await jump()).toEqual({});
  expect(asked).toEqual([fresh2.ok ? fresh2.sessionId : ""]);
  expect(fake.of("pane.focus").length).toBe(focused);
  const continued = await ctx.contributions.run("code-link.start-terminal", { projectId: project.id, itemId: item.id });
  // No pane to look for: the window shows it.
  expect(continued.toast).toBe(`Continuing on ${fresh2.ok ? fresh2.branch : ""}`);
  expect(asked.length).toBe(2);
  shows();
  answers();
  expect(await codeLink.terminalWindow(project.id)).toBe(false);
  expect((await jump()).toast).toMatch(/^Shown in herdr \(pane w1:p\d\)$/);

  // herdr gone, and its server does not start: the session opens in the system terminal instead, and the person is told why.
  fake.stop();
  expect(await codeLink.herdrStatus()).toBe("notRunning");
  const stopped = await codeLink.start(project.id, ticket("Stopped").id, { mode: "terminal" });
  expect(stopped).toMatchObject({ ok: true, launched: true, pane: null, warnings: [expect.stringContaining("herdr is not running")] });
  installed.mockResolvedValue(null);
  expect(await codeLink.herdrStatus()).toBe("notInstalled");
  // Left on automatic, a machine without herdr opens the system terminal, with nothing to explain.
  const plain = await codeLink.start(project.id, ticket("Plain").id, { mode: "terminal" });
  expect(plain).toMatchObject({ ok: true, launched: true, pane: null });
  expect(plain).not.toHaveProperty("warnings");
  expect(opened).toHaveBeenLastCalledWith("Terminal", path.join(codeLink.sessionDir(plain.ok ? plain.sessionId : ""), "run.command"), expect.any(String));
  // herdr picked by name back when it was a choice reads as automatic: the system terminal, nothing to explain.
  ctx.settings.set({ ...ctx.settings.get(), codeLink: { ...ctx.settings.get().codeLink, terminal: "herdr" } });
  const alone = ticket("Alone");
  const without = await codeLink.start(project.id, alone.id, { mode: "terminal" });
  expect(without).toMatchObject({ ok: true, launched: true, pane: null });
  expect(without).not.toHaveProperty("warnings");
  expect(without.ok && without.command).toMatch(/^"claude" /);
  expect(opened).toHaveBeenLastCalledWith("Terminal", path.join(codeLink.sessionDir(without.ok ? without.sessionId : ""), "run.command"), expect.any(String));
  // the worktree's own terminal too: the system terminal, as on automatic
  const shell = await ctx.contributions.run("code-link.open-terminal", { projectId: project.id, itemId: alone.id });
  expect(shell.toast).toMatch(/^Opened /);
  expect(opened).toHaveBeenCalledTimes(4);
  opened.mockRestore();
  fake.close();
});

it("takes the id herdr's own integration reported on an agent's pane when the agent's hooks never reach Tomrade, and keeps one the hooks gave", { timeout: 60_000 }, async () => {
  const { codeLink, ctx, project, repo, checkout, ticket } = await machine(codeRepo());
  await ctx.repos.setCheckout(repo!.remote, checkout!);
  const fake = new FakeHerdr();
  await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket });
  await settle();
  // Antigravity's panes: herdr's agy integration reported the conversation on the first; the second reported nothing.
  const pane = (id: string, conversation: string | null) =>
    fake.panes.set(id, { pane_id: id, workspace_id: "w1", tab_id: "w1:t1", cwd: checkout!, label: null, agent: "agy", agent_status: "idle", text: "", agent_session: conversation ? { source: "herdr:antigravity_cli", agent: "agy", kind: "id", value: conversation } : null });
  pane("w1:p1", "agy-conv-1");
  pane("w1:p2", null);
  pane("w1:p3", "agy-conv-3");
  pane("w1:p4", "agy-conv-4");
  const session = (herdrPane: string, agent: string, externalId: string | null = null) => {
    const item = ticket(`Work in ${herdrPane}`);
    const made = codeLink.store.createSession(project.id, { repoId: repo!.id, branch: "", itemIds: [item.id], mode: "terminal", agent, threadId: null, device: ctx.hub.deviceId, externalId });
    codeLink.store.patchSession(project.id, made.id, { herdrPane, state: "running" });
    return made.id;
  };
  const named = session("w1:p1", "agy");
  const unnamed = session("w1:p2", "agy");
  const hooked = session("w1:p3", "agy", "from-hooks");
  // herdr reads another agent than the session's in its pane: that id is not this session's
  const other = session("w1:p4", "gemini");
  ctx.emit("codeLink/changed", project.id);
  const panes = ["w1:p1", "w1:p2", "w1:p3", "w1:p4"];
  await until(() => panes.every((id) => fake.of("events.subscribe").some((s) => JSON.stringify(s).includes(id))));
  for (const id of panes) fake.setStatus(id, "agy", "working");
  await until(() => codeLink.store.session(project.id, named)!.externalId === "agy-conv-1");
  await until(() => [unnamed, hooked, other].every((id) => codeLink.store.session(project.id, id)!.state === "running" && codeLink.store.session(project.id, id)!.lastEventAt !== null));
  // nothing reported stays without; an id the hooks gave is never replaced
  expect(codeLink.store.session(project.id, unnamed)!.externalId).toBeNull();
  expect(codeLink.store.session(project.id, hooked)!.externalId).toBe("from-hooks");
  expect(codeLink.store.session(project.id, other)!.externalId).toBeNull();
  // herdr's integration reports the conversation later than its first reading of the screen: a later event takes it up
  fake.panes.get("w1:p2")!.agent_session = { source: "herdr:antigravity_cli", agent: "agy", kind: "id", value: "agy-conv-2" };
  await new Promise((resolve) => setTimeout(resolve, 2100));
  fake.setStatus("w1:p2", "agy", "blocked");
  await until(() => codeLink.store.session(project.id, unnamed)!.externalId === "agy-conv-2");
  // the id known, its pane is not read for one again
  const lists = fake.of("pane.list").length;
  await new Promise((resolve) => setTimeout(resolve, 2100));
  fake.setStatus("w1:p1", "agy", "done");
  await until(() => codeLink.store.session(project.id, named)!.state === "waiting");
  expect(fake.of("pane.list").length).toBe(lists);
  fake.close();
});

it("installs herdr with Homebrew, or herdr's own installer without it, in a terminal the person watches, and runs nothing where only the guide fits", async () => {
  // No herdr on this machine: the terminal setting, left on automatic, is the system terminal.
  const { codeLink } = await machine(null);
  const opened = vi.spyOn(terminalApp, "open").mockResolvedValue();
  const plan = vi.spyOn(codeLink, "herdrInstall").mockResolvedValue(herdrInstall({ brew: true }));
  try {
    expect(await codeLink.installHerdr()).toEqual({ launched: true, command: "brew install herdr" });
    const script = path.join(codeLink.sessionDir("setup"), "herdr", "run.command");
    expect(opened).toHaveBeenCalledWith("Terminal", script, os.homedir());
    expect(fs.readFileSync(script, "utf8")).toContain("brew install herdr");
    plan.mockResolvedValue(herdrInstall({ brew: false, platform: "linux" }));
    expect(await codeLink.installHerdr()).toEqual({ launched: true, command: "curl -fsSL https://herdr.dev/install.sh | sh" });
    expect(fs.readFileSync(script, "utf8")).toContain("curl -fsSL https://herdr.dev/install.sh | sh");
    plan.mockResolvedValue(herdrInstall({ brew: false, platform: "win32" }));
    await expect(codeLink.installHerdr()).rejects.toThrow("install guide");
    expect(opened).toHaveBeenCalledTimes(2);
  } finally {
    opened.mockRestore();
  }
});

async function untilRunsSettle(agent: Agent, timeout = 8000) {
  const t0 = Date.now();
  while (agent.activeRuns().length) {
    if (Date.now() - t0 > timeout) throw new Error("runs did not settle");
    await new Promise((r) => setTimeout(r, 15));
  }
}

it("offers the connected account for credential failures, reprobes after switching, and supplies headless gh credentials", async () => {
  const local = codeRepo();
  const remote = "https://github.com/example/private-app";
  git(["remote", "set-url", "origin", remote], local.checkout);
  const binary = path.join(root, `git-credential-probe-${n++}`);
  fs.writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "fetch" ]; then echo 'Repository not found' >&2; exit 128; fi\nif [ "$1" = "ls-remote" ]; then\n  git config --local --get-all credential.https://github.com.helper | grep -q tomrade-credential && exit 0\n  echo 'Repository not found' >&2; exit 128\nfi\nexec git "$@"\n`, { mode: 0o755 });
  const world = await machine({ ...local, remote }, { gitBinary: binary });
  const { ctx, codeLink, project, repo, hubDir } = world;
  const connection = vi.spyOn(ctx.github, "status").mockResolvedValue({ connected: true, label: "@right-account" });
  ctx.settings.set({ ...ctx.settings.get(), github: { token: "fake-project-token" } });
  await ctx.repos.setCheckout(remote, local.checkout);
  await codeLink.scan(project.id);
  expect(await codeLink.githubCredentialAccount(project.id, repo!.id)).toBe("@right-account");
  connection.mockResolvedValueOnce({ connected: false });
  await expect(codeLink.useGithubCredential(project.id, repo!.id)).rejects.toThrow("Connect your GitHub account");
  const state = await codeLink.useGithubCredential(project.id, repo!.id);
  expect(state).toMatchObject({ remote: "ok", remoteDetail: null });
  expect(state.remoteAt).toBeGreaterThan(0);
  expect(await codeLink.remoteIdentity(remote)).toEqual({ host: "github.com", login: "right-account", tomrade: true });
  expect(await codeLink.githubCredentialAccount(project.id, repo!.id)).toBeNull();
  const item = world.ticket("Use the connected account");
  codeLink.setRepoPolicy(project.id, repo!.id, { agentPush: false });
  expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: true });
  await untilRunsSettle(world.agent);
  expect(world.turns.at(-1)?.env).toEqual({ GH_TOKEN: "fake-project-token", GITHUB_TOKEN: "fake-project-token" });
  expect(JSON.stringify(world.agent.store.messages(project.id, world.turns.at(-1)!.threadId))).not.toContain("fake-project-token");
  git(["remote", "set-url", "origin", "https://github.com/example/different"], local.checkout);
  await expect(codeLink.useGithubCredential(project.id, repo!.id)).rejects.toThrow("origin has changed");
  connection.mockRestore();
});

it("repoints a helper an earlier version left under the Hub, on the next scan", async () => {
  const local = codeRepo();
  const remote = "https://github.com/example/private-app";
  git(["remote", "set-url", "origin", remote], local.checkout);
  // The scan's fetch and remote probe answer here, as for a private repository, rather than from github.com.
  const binary = path.join(root, `git-offline-${n++}`);
  fs.writeFileSync(binary, `#!/bin/sh\ncase "$1" in fetch|ls-remote|pull|push) echo 'Repository not found' >&2; exit 128;; esac\nexec git "$@"\n`, { mode: 0o755 });
  const world = await machine({ ...local, remote }, { gitBinary: binary });
  const { ctx, codeLink, project, hubDir } = world;
  const connection = vi.spyOn(ctx.github, "status").mockResolvedValue({ connected: true, label: "@right-account" });
  ctx.settings.set({ ...ctx.settings.get(), github: { token: "fake-project-token" } });
  // An upgrade left this checkout opted in, naming the helper's old Hub home.
  const legacy = path.join(hubDir, "old-hub", "bin", "tomrade-credential");
  git(["config", "--local", "--replace-all", "credential.https://github.com.helper", ""], local.checkout);
  git(["config", "--local", "--add", "credential.https://github.com.helper", `!'${legacy}'`], local.checkout);
  expect(git(["config", "--local", "--get-all", "credential.https://github.com.helper"], local.checkout)).toContain(legacy);
  await ctx.repos.setCheckout(remote, local.checkout);
  await codeLink.scan(project.id);
  const config = fs.readFileSync(path.join(local.checkout, ".git/config"), "utf8");
  expect(config).toContain(path.join(hubDir, "bin", "tomrade-credential"));
  expect(config).not.toContain(legacy);
  expect(await codeLink.remoteIdentity(remote)).toEqual({ host: "github.com", login: "right-account", tomrade: true });
  connection.mockRestore();
});

it("keeps an unsuccessful credential reprobe unreachable and does not offer account switching for network failures", async () => {
  const local = codeRepo();
  const remote = "https://github.com/example/still-private";
  git(["remote", "set-url", "origin", remote], local.checkout);
  const binary = path.join(root, `git-denied-${n++}`);
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "fetch" ] || [ "$1" = "ls-remote" ]; then echo "Repository not found" >&2; exit 128; fi\nexec git "$@"\n', { mode: 0o755 });
  const { ctx, codeLink, project, repo, hubDir } = await machine({ ...local, remote }, { gitBinary: binary });
  const connection = vi.spyOn(ctx.github, "status").mockResolvedValue({ connected: true, label: "@account" });
  ctx.settings.set({ ...ctx.settings.get(), github: { token: "fake-token" } });
  await ctx.repos.setCheckout(remote, local.checkout);
  await codeLink.scan(project.id);
  expect(await codeLink.useGithubCredential(project.id, repo!.id)).toMatchObject({ remote: "unreachable", remoteDetail: "Repository not found" });
  codeLink.store.upsertRepoState(project.id, repo!.id, { remote: "unreachable", remoteDetail: "Could not resolve host" });
  expect(await codeLink.githubCredentialAccount(project.id, repo!.id)).toBeNull();
  const ssh = ctx.repos.create({ projectId: project.id, remote: "git@github.com:example/ssh.git" });
  await expect(codeLink.useGithubCredential(project.id, ssh.id)).rejects.toThrow("HTTPS GitHub");
  connection.mockRestore();
});

describe("starting a ticket", () => {
  it("hands a main conversation each workstream's repository folder on this machine", async () => {
    const world = await machine(codeRepo());
    const { ctx, project, board, repo } = world;
    world.boards.update(project.id, board.id, { repoPath: "mobile-app" });
    const input = (purpose: "backlog" | "code") => ({ threadId: "t", projectId: project.id, purpose, input: { kind: "text", text: "hi" }, messages: [], cards: [], brief: null, pending: null, options: {} }) as TurnInput;
    const before = input("backlog");
    await ctx.parallel("agent/prepare-turn", before);
    expect(before.repositories).toEqual([{ workstream: board.name, name: repo!.name, path: null, defaultBranch: "main", readiness: "unknown", hasBrief: false }]);

    await ctx.repos.setCheckout(repo!.remote, world.checkout!);
    await world.codeLink.scan(project.id);
    const after = input("backlog");
    await ctx.parallel("agent/prepare-turn", after);
    expect(after.repositories).toEqual([{ workstream: board.name, name: repo!.name, path: path.join(world.checkout!, "mobile-app"), defaultBranch: "main", readiness: "scaffolded", hasBrief: false }]);
    const code = input("code");
    await ctx.parallel("agent/prepare-turn", code);
    expect(code.repositories).toBeUndefined();
  });

  it("recognises a project rooted at the workstream's repository path", async () => {
    const local = codeRepo({ manifest: false });
    const world = await machine(local);
    const { codeLink, ctx, project, board, repo, ticket } = world;
    world.boards.update(project.id, board.id, { repoPath: "mobile-app" });
    await ctx.repos.setCheckout(repo!.remote, local.checkout);
    await codeLink.scan(project.id);
    const feature = ticket("Add charts");
    expect(await codeLink.start(project.id, feature.id, { mode: "run" })).toMatchObject({ ok: false, gate: "readiness" });
    const bootstrap = ctx.items.list({ projectId: project.id }).find((item) => item.labels.includes(BOOTSTRAP_LABEL))!;
    expect(bootstrap.blocks).toContain(feature.id);

    fs.mkdirSync(path.join(local.checkout, "mobile-app"));
    fs.writeFileSync(path.join(local.checkout, "mobile-app", "package.json"), '{ "name": "mobile-app" }\n');
    git(["add", "-A"], local.checkout);
    git(["commit", "-q", "-m", "add mobile app"], local.checkout);
    git(["push", "-q", "origin", "main"], local.checkout);
    await codeLink.scan(project.id);
    expect(codeLink.repoState(project.id, repo!.id)).toMatchObject({ readiness: "scaffolded", manifests: ["mobile-app/package.json"] });

    const started = await codeLink.start(project.id, feature.id, { mode: "run" });
    expect(started).toMatchObject({ ok: true });
    expect(ctx.items.get(project.id, bootstrap.id)!.blocks).not.toContain(feature.id);
    await untilRunsSettle(world.agent);
  });

  it("answers each gate with the thing that clears it", async () => {
    const world = await machine(null);
    const { codeLink, ctx, project, board, ticket } = world;
    const item = ticket("Gated");

    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "workstream" });

    const repo = codeRepo({ manifest: false });
    const row = ctx.repos.create({ projectId: project.id, remote: repo.remote });
    world.boards.update(project.id, board.id, { repoId: row.id });
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "checkout", remote: row.remote });

    await ctx.repos.setCheckout(repo.remote, repo.checkout);
    const gated = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(gated).toMatchObject({ ok: false, gate: "readiness" });
    const bootstrap = ctx.items.list({ projectId: project.id }).find((i) => i.labels.includes(BOOTSTRAP_LABEL))!;
    expect(bootstrap.blocks).toContain(item.id);
    expect(gated.ok ? null : gated.bootstrapKey).toBe(bootstrap.key);
    // Asked again, the same bootstrap ticket answers — not a second one.
    await codeLink.start(project.id, item.id, { mode: "run" });
    expect(ctx.items.list({ projectId: project.id }).filter((i) => i.labels.includes(BOOTSTRAP_LABEL))).toHaveLength(1);

    // The bootstrap ticket itself may start in an empty repository; once the repository has a project, the blocker is what stands.
    ctx.items.update(project.id, bootstrap.id, { status: "cancelled" }, "human");
    fs.writeFileSync(path.join(repo.checkout, "package.json"), "{}\n");
    git(["add", "-A"], repo.checkout);
    git(["commit", "-q", "-m", "scaffold"], repo.checkout);
    git(["push", "-q", "origin", "main"], repo.checkout);
    await codeLink.scan(project.id);
    const blocker = ticket("Blocker");
    ctx.items.update(project.id, blocker.id, { blocks: [item.id] }, "human");
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "blocked", blockers: [blocker.key] });

    // Waiting is the human's call: starting anyway works ahead, and the brief says what is still open.
    const ahead = await codeLink.start(project.id, item.id, { mode: "run", allowBlocked: true });
    expect(ahead).toMatchObject({ ok: true });
    await untilRunsSettle(world.agent);
    expect((world.turns.at(-1)!.messages[0]?.block as { text: string }).text).toContain(`Waits on (still open): ${blocker.key} Blocker (todo)`);

    ctx.items.update(project.id, item.id, { humanLocked: true }, "human");
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "locked" });
  });

  it("stops at the checkout gate at once when this machine's folder is unset, gone, or no longer a repository", async () => {
    const repo = codeRepo();
    const { codeLink, ctx, project, ticket, repo: row } = await machine(repo);
    const item = ticket("Synced from another machine");
    const at = Date.now();
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "checkout", repo: { id: row!.id }, remote: row!.remote });

    await ctx.repos.setCheckout(repo.remote, repo.checkout);
    fs.rmSync(path.join(repo.checkout, ".git"), { recursive: true, force: true });
    const notGit = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(notGit).toMatchObject({ ok: false, gate: "checkout", placed: { dir: repo.checkout, problem: "not-git" }, message: expect.stringContaining("is not a git repository") });
    expect(ctx.repos.checkouts()).toContainEqual(expect.objectContaining({ checkout: repo.checkout, problem: "not-git" }));

    // A folder this machine once named that is not there any more.
    const gone = path.join(root, `gone-${n++}`);
    ctx.hub.catalog.setRepo(normalizeRemote(repo.remote), { checkout: gone });
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "checkout", placed: { dir: gone, problem: "missing" } });
    expect(Date.now() - at).toBeLessThan(5000);
    // Nothing was left behind for the ticket to wait on.
    expect(codeLink.sessionsOf(project.id, item.id)).toEqual([]);
    expect(ctx.items.get(project.id, item.id)!.status).toBe("todo");
  });

  it("fails a start that does not finish in time, rather than leave the ticket waiting", async () => {
    const repo = codeRepo();
    const { codeLink, ctx, project, ticket } = await machine(repo, { startTimeoutMs: 200 });
    await ctx.repos.setCheckout(repo.remote, repo.checkout);
    const item = ticket("Stuck on git");
    // A step that never answers, as git waiting on a credential window does.
    codeLink.scan = () => new Promise(() => {});
    await expect(codeLink.start(project.id, item.id, { mode: "run" })).rejects.toThrow(`Starting ${item.key} took longer than 1 seconds`);
  });

  it("keeps what a stopped ticket's gate names on the start card, beside the others' outcomes", async () => {
    const repo = codeRepo();
    const { codeLink, agent, project, ticket, repo: row } = await machine(repo);
    const item = ticket("No folder here");
    const thread = agent.newThread(project.id, "fake-code");
    agent.postCard(project.id, thread.id, { id: "start-batch-t", schema: "start-batch", title: item.key, data: { tickets: [{ itemId: item.id, key: item.key, title: item.title }], results: [{ itemId: "other", key: "TOM-0", title: "", ok: true }] } }, "human");
    const results = await codeLink.startTickets(project.id, { itemIds: [item.id], requestedBy: thread.id, engine: "fake-code", cardId: "start-batch-t" });
    expect(results).toEqual([expect.objectContaining({ key: item.key, ok: false, gate: "checkout", repo: { id: row!.id, name: row!.name }, remote: row!.remote })]);
    const card = agent.store.cards(project.id, thread.id).find((c) => c.id === "start-batch-t")!;
    expect(card.data).toMatchObject({ config: { engine: "fake-code" }, results: [{ key: "TOM-0", ok: true }, { key: item.key, ok: false, gate: "checkout", remote: row!.remote }] });
  });

  it("shows each ticket's outcome on the start card as it comes, before the next one has started", async () => {
    const { codeLink, agent, project, ticket } = await machine(codeRepo());
    const first = ticket("Quick one");
    const second = ticket("Slow one");
    const thread = agent.newThread(project.id, "fake-code");
    const tickets = [first, second].map((i) => ({ itemId: i.id, key: i.key, title: i.title }));
    agent.postCard(project.id, thread.id, { id: "start-batch-p", schema: "start-batch", title: "both", data: { tickets, config: { engine: "fake-code" } } }, "human");
    let release = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    codeLink.start = async (_projectId, itemId) => {
      if (itemId === second.id) await slow;
      return { ok: true, continued: false, threadId: null, sessionId: `s-${itemId}`, branch: `b-${itemId}`, worktree: null, cwd: root, mode: "run", command: "fake", launched: false, pane: null, engine: "fake-code" } as StartResult;
    };
    const card = () => agent.store.cards(project.id, thread.id).find((c) => c.id === "start-batch-p")!.data as StartBatchCard;
    const started = codeLink.startTickets(project.id, { itemIds: [first.id, second.id], requestedBy: thread.id, engine: "fake-code", cardId: "start-batch-p" });
    await expect.poll(() => card().results?.map((r) => r.key)).toEqual([first.key]);
    expect(card().tickets).toEqual(tickets);
    release();
    await started;
    expect(card().results?.map((r) => r.key)).toEqual([first.key, second.key]);
  });

  it("does not mistake a repository it cannot reach for an empty one", async () => {
    // A checkout whose origin cannot be fetched: an empty clone of a full repository looks exactly like this.
    const checkout = path.join(root, `checkout-${n++}`);
    fs.mkdirSync(checkout, { recursive: true });
    git(["init", "-q", "-b", "main"], checkout);
    git(["remote", "add", "origin", path.join(root, "no-such-remote.git")], checkout);
    const world = await machine({ remote: path.join(root, "no-such-remote.git"), checkout });
    const { codeLink, ctx, project, repo, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout);
    const item = ticket("Unreachable");

    await codeLink.scan(project.id);
    expect(codeLink.repoState(project.id, repo!.id)).toMatchObject({ readiness: "unknown", remote: "unreachable", remoteDetail: expect.any(String), remoteAt: null, summary: expect.stringContaining("origin") });
    expect((await ctx.contributions.statusItems({ projectId: project.id })).find((s) => s.id === "code-link")!.text).toContain("1 unreachable");
    const gated = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(gated).toMatchObject({ ok: false, gate: "remote" });
    expect(ctx.items.list({ projectId: project.id }).some((i) => i.labels.includes(BOOTSTRAP_LABEL))).toBe(false);
  });

  it("refuses a scaffolded repository when the live probe reports a credential failure", async () => {
    const source = codeRepo();
    const world = await machine(source, { gitBinary: gitWithFailure("ls-remote", "remote: Repository not found.") });
    const { codeLink, ctx, project, repo, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, source.checkout);
    await codeLink.scan(project.id);
    expect(codeLink.repoState(project.id, repo!.id)?.readiness).toBe("scaffolded");

    const result = await codeLink.start(project.id, ticket("Private work").id, { mode: "run" });
    expect(result).toMatchObject({ ok: false, gate: "remote", remote: repo!.remote, message: expect.stringContaining("private repository") });
    expect(codeLink.sessionsOf(project.id)).toEqual([]);
  });

  it("starts a scaffolded repository with a prompt warning during a network outage", async () => {
    const source = codeRepo();
    const world = await machine(source, { gitBinary: gitWithFailure("ls-remote", "fatal: Could not resolve host: github.com") });
    const { codeLink, ctx, agent, project, repo, ticket, turns } = world;
    await ctx.repos.setCheckout(repo!.remote, source.checkout);
    await codeLink.scan(project.id);

    const result = await codeLink.start(project.id, ticket("Offline work").id, { mode: "run" });
    expect(result).toMatchObject({ ok: true, warnings: [expect.stringContaining("commit locally, do not push")] });
    await untilRunsSettle(agent);
    expect((turns[0].messages[0]?.block as { text: string }).text).toContain(result.ok ? result.warnings?.[0] : "missing warning");
  });

  it("refuses an account that can read origin but cannot dry-run a push", async () => {
    const source = codeRepo();
    const world = await machine(source, { gitBinary: gitWithFailure("push", "remote: Permission denied\nfatal: The requested URL returned error: 403") });
    const { codeLink, ctx, project, repo, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, source.checkout);
    await codeLink.scan(project.id);

    const result = await codeLink.start(project.id, ticket("Protected write").id, { mode: "run" });
    expect(result).toMatchObject({ ok: false, gate: "remote", message: expect.stringContaining("credentials") });
  });

  it("starts the bootstrap ticket in an empty repository on an unborn branch, and its first push creates the default branch", async () => {
    const remote = path.join(root, `remote-${n++}.git`);
    fs.mkdirSync(remote, { recursive: true });
    git(["init", "--bare", "-b", "main", "."], remote);
    const checkout = path.join(root, `checkout-${n++}`);
    fs.mkdirSync(checkout, { recursive: true });
    git(["init", "-q", "-b", "main"], checkout);
    git(["remote", "add", "origin", remote], checkout);
    git(["config", "user.email", "dev@localhost"], checkout);
    git(["config", "user.name", "Dev"], checkout);

    const world = await machine({ remote, checkout });
    const { codeLink, ctx, agent, project, repo, turns, ticket } = world;
    await ctx.repos.setCheckout(remote, checkout);
    // A monorepo layout from day one: the workstream's folder does not exist yet either.
    world.boards.update(project.id, world.board.id, { repoPath: "mobile-app" });
    const feature = ticket("First feature");
    const gated = await codeLink.start(project.id, feature.id, { mode: "run" });
    expect(gated).toMatchObject({ ok: false, gate: "readiness" });
    const bootstrap = ctx.items.list({ projectId: project.id }).find((i) => i.labels.includes(BOOTSTRAP_LABEL))!;

    const result = await codeLink.start(project.id, bootstrap.id, { mode: "run" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No commit anywhere yet: the worktree sits on the ticket's branch, unborn, and the workstream's folder was made for the agent.
    expect(result.cwd).toBe(path.join(result.worktree!, "mobile-app"));
    expect(fs.existsSync(result.cwd)).toBe(true);
    expect(git(["symbolic-ref", "HEAD"], result.cwd)).toBe(`refs/heads/${result.branch}`);
    await untilRunsSettle(agent);
    expect(turns).toHaveLength(1);
    expect(turns[0].messages[0]?.block).toMatchObject({ type: "text", text: expect.stringContaining("Bootstrap") });
    expect((turns[0].messages[0]?.block as { text: string }).text).toContain("lives in mobile-app/");
    // The fake agent made the repository's first commit on that branch.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], result.cwd)).toBe(result.branch);

    const pr = await codeLink.openPr(project.id, bootstrap.id);
    expect(pr.pushed).toBe(true);
    expect(pr.message).toContain("became it");
    expect(git(["ls-remote", "--heads", remote, "main"], checkout)).toMatch(/refs\/heads\/main/);
    await codeLink.scan(project.id);
    expect(ctx.items.get(project.id, bootstrap.id)!.status).toBe("done");
    // No manifest, but the fake agent's code is on main now: the project exists and the feature may start.
    expect(codeLink.repoState(project.id, repo!.id)!.readiness).toBe("scaffolded");
    expect(await codeLink.start(project.id, feature.id, { mode: "run" })).toMatchObject({ ok: true });
    expect(ctx.items.list({ projectId: project.id }).filter((i) => i.labels.includes(BOOTSTRAP_LABEL))).toHaveLength(1);
    await untilRunsSettle(agent);
  });

  it("bootstraps a workstream once, even when a scan still reads it empty afterwards", async () => {
    const world = await machine(codeRepo({ manifest: false }));
    const { codeLink, ctx, project, repo, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, world.checkout!);
    const feature = ticket("First feature");
    expect(await codeLink.start(project.id, feature.id, { mode: "run" })).toMatchObject({ ok: false, gate: "readiness" });
    const bootstrap = ctx.items.list({ projectId: project.id }).find((i) => i.labels.includes(BOOTSTRAP_LABEL))!;
    // Its work never reached main — merged nowhere, or a stack with nothing a scan recognises.
    ctx.items.update(project.id, bootstrap.id, { status: "done" }, "human");

    const started = await codeLink.start(project.id, feature.id, { mode: "run" });
    expect(started).toMatchObject({ ok: true, warnings: [expect.stringContaining(`${bootstrap.key} (bootstrap) is done`)] });
    expect(ctx.items.list({ projectId: project.id }).filter((i) => i.labels.includes(BOOTSTRAP_LABEL))).toHaveLength(1);
    await untilRunsSettle(world.agent);
  });

  it("reads readiness fresh before gating on empty", async () => {
    const world = await machine(codeRepo({ manifest: false }));
    const { codeLink, ctx, project, repo, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, world.checkout!);
    await codeLink.scan(project.id);
    expect(codeLink.repoState(project.id, repo!.id)!.readiness).toBe("empty");
    // Filled after the last scan; the start must not act on the stale reading.
    fs.writeFileSync(path.join(world.checkout!, "package.json"), "{}\n");
    git(["add", "-A"], world.checkout!);
    git(["commit", "-q", "-m", "scaffold"], world.checkout!);
    git(["push", "-q", "origin", "main"], world.checkout!);
    expect(await codeLink.start(project.id, ticket("Feature").id, { mode: "run" })).toMatchObject({ ok: true });
    expect(ctx.items.list({ projectId: project.id }).filter((i) => i.labels.includes(BOOTSTRAP_LABEL))).toHaveLength(0);
    await untilRunsSettle(world.agent);
  });

  it("runs the ticket in a worktree on its own branch, follows the session, and takes the agent's report", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, hubDir, turns, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Push notifications");

    const result = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ continued: false, branch: `tom-${item.keyNum}/push-notifications`, mode: "run" });
    expect(result.worktree).toBe(path.join(hubDir, "worktrees", path.basename(repo!.remote, ".git"), result.threadId));
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], result.cwd)).toBe(result.branch);

    const thread = agent.store.thread(project.id, result.threadId)!;
    expect(thread).toMatchObject({ itemId: item.id, branch: result.branch, engine: "fake-code", boardId: item.boardId });
    expect(ctx.items.get(project.id, item.id)!.status).toBe("doing");
    const [link] = codeLink.links(project.id, item.id);
    expect(link).toMatchObject({ branch: result.branch, threadId: result.threadId, source: "start" });

    await untilRunsSettle(agent);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ purpose: "code", cwd: result.cwd, ticket: { key: item.key, branch: result.branch } });
    expect(turns[0].messages.at(-1)?.block).toMatchObject({ type: "text" });
    expect(agent.store.messages(project.id, thread.id)[0].block).toMatchObject({ type: "text", text: expect.stringContaining(`Implement ${item.key}`) });

    // The run's end is the session's heartbeat: idle, with the CLI session id kept for Continue.
    const [session] = codeLink.sessionsOf(project.id, item.id);
    expect(session).toMatchObject({ mode: "headless", agent: "fake-code", threadId: result.threadId, state: "idle", externalId: "fake-session-1", itemIds: [item.id] });

    // The commit the agent made is on the branch; the scan sees it through the checkout's refs.
    await codeLink.scan(project.id);
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ ahead: 1, behind: 0 });

    // Starting again continues the same thread rather than opening another.
    const again = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(again).toMatchObject({ ok: true, continued: true, threadId: result.threadId });
    await untilRunsSettle(agent);
    expect(turns).toHaveLength(2);
    expect(agent.store.messages(project.id, thread.id).filter((m) => m.role === "user").at(-1)?.block).toMatchObject({ type: "text", text: expect.stringContaining(`Continue ${item.key}`) });

    // The agent reports a pull request; the ticket moves to Verifying and the Code section shows it.
    const reported = (await ctx.tools.execute("link_code", { key: item.key, prUrl: "https://github.com/acme/app/pull/12" }, { by: "ai:fake-code", projectId: project.id })) as { status: string };
    expect(reported.status).toBe("verifying");
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ prNumber: 12, prState: "open", prUrl: "https://github.com/acme/app/pull/12" });
    const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!;
    expect(section.rows.find((r) => r.label === "Pull request")).toMatchObject({ value: "#12 · open", href: "https://github.com/acme/app/pull/12" });
    expect(section.rows.find((r) => r.label === "Session")?.value).toMatch(/^idle · run by Tomrade/);
    expect(section.rows.find((r) => r.label === "Worktree")).toMatchObject({ value: result.worktree, command: "code-link.open-terminal" });
    // the session at work says so on the card, beside the pull request
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual([
      { id: "session", label: expect.stringMatching(/ at work · in the assistant · \d+ min$/), tone: "faint" },
      { id: "pr", label: "PR #12", tone: "strong", title: "https://github.com/acme/app/pull/12" }
    ]);
    // An agent elsewhere (an IM conversation) reads the same code.
    const read = await ctx.tools.execute("get_code_links", { key: item.key.toLowerCase() }, { by: "ai:test", projectId: project.id });
    expect(read).toMatchObject({
      key: item.key, status: "verifying", delivery: { sequence: 1, state: "active" },
      links: [{ branch: result.branch, ahead: 1, prNumber: 12, prUrl: "https://github.com/acme/app/pull/12", prState: "open", mergedSha: null }],
      session: { mode: "headless", agent: "fake-code", state: "idle", blocked: null, threadId: result.threadId },
      proposals: []
    });
  });

  it("names a new branch on a Chinese title with the model's English slug, and falls back to the local rule without a model", async () => {
    // The model answers only the CJK title; the plain one is slugged locally and never asked.
    const asked: string[] = [];
    const world = await machine(codeRepo(), {
      llm: (system, user) => {
        asked.push(user);
        expect(system).toContain("git branch");
        return { slug: user.includes("统一") ? "Unify Usage Statistics" : "should-not-be-asked" };
      }
    });
    await world.ctx.repos.setCheckout(world.repo!.remote, world.checkout!);
    const chinese = world.ticket("统一 ticket 用量与用量统计的 token 口径");
    const result = await world.codeLink.start(world.project.id, chinese.id, { mode: "run" });
    expect(result).toMatchObject({ ok: true, branch: `tom-${chinese.keyNum}/unify-usage-statistics` });
    expect(asked).toEqual(["统一 ticket 用量与用量统计的 token 口径"]);

    // Starting the same ticket again continues its branch and does not ask the model a second time.
    const again = await world.codeLink.start(world.project.id, chinese.id, { mode: "run" });
    expect(again).toMatchObject({ ok: true, continued: true, branch: result.ok ? result.branch : "" });
    expect(asked).toHaveLength(1);

    // A model that answers with prose or rubbish cannot leak it into the branch.
    const messy = await machine(codeRepo(), { llm: () => ({ slug: "  Unify usage!!! statistics. " }) });
    await messy.ctx.repos.setCheckout(messy.repo!.remote, messy.checkout!);
    const other = messy.ticket("统一 ticket 用量");
    const tidy = await messy.codeLink.start(messy.project.id, other.id, { mode: "run" });
    if (!tidy.ok) throw new Error(tidy.message);
    expect(tidy.branch).toMatch(/^tom-\d+\/[a-z0-9-]+$/);
    expect(tidy.branch).toBe(`tom-${other.keyNum}/unify-usage-statistics`);
  });

  it("falls back to a local slug when no model answers a Chinese title", async () => {
    const world = await machine(codeRepo(), { llm: () => ({ nope: true }) }); // the answer does not fit the schema
    await world.ctx.repos.setCheckout(world.repo!.remote, world.checkout!);
    const item = world.ticket("统一 ticket 用量与用量统计的 token 口径");
    const result = await world.codeLink.start(world.project.id, item.id, { mode: "run" });
    // No model: the same latin fragments the local rule has always found.
    expect(result).toMatchObject({ ok: true, branch: `tom-${item.keyNum}/ticket-token` });

    const symbols = await machine(codeRepo(), { llm: () => ({ slug: "!!!" }) });
    await symbols.ctx.repos.setCheckout(symbols.repo!.remote, symbols.checkout!);
    const empty = symbols.ticket("!!! ???");
    const fallback = await symbols.codeLink.start(symbols.project.id, empty.id, { mode: "run" });
    expect(fallback).toMatchObject({ ok: true, branch: `tom-${empty.keyNum}/work` });
  });

  it("works a repository with no remote: nothing probed or pushed, the branch handed over for review, a local merge finishes it", async () => {
    const folder = localRepo();
    const world = await machine(null);
    const { codeLink, ctx, agent, project, board, turns, ticket } = world;
    const { repo } = await ctx.repos.addFromFolder(project.id, folder);
    world.boards.update(project.id, board.id, { repoId: repo.id });
    const item = ticket("Local feature");

    const result = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(result).toMatchObject({ ok: true, branch: `tom-${item.keyNum}/local-feature` });
    if (!result.ok) return;
    expect(result.warnings).toBeUndefined();
    await untilRunsSettle(agent);
    const prompt = JSON.stringify(agent.store.messages(project.id, result.threadId)[0].block);
    expect(prompt).toContain("this repository has no remote");
    expect(prompt).not.toContain("git push");
    expect(turns).toHaveLength(1);

    await codeLink.scan(project.id);
    expect(codeLink.repoStates(project.id)[0]).toMatchObject({ remote: "none", readiness: "scaffolded" });
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ ahead: 1 });
    const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!;
    expect(section.rows.find((r) => r.label === "Pull request")).toMatchObject({ value: "none — no remote · merge into main", command: "code-link.merge-local" });
    expect(await codeLink.openPr(project.id, item.id)).toMatchObject({ pushed: false, message: expect.stringContaining("has no remote") });

    const handed = (await sessionContext.run({ projectId: project.id, sessionId: result.sessionId }, () => ctx.tools.execute("link_code", { scopeChecked: true }, { by: "ai:fake-code", projectId: project.id }))) as { status: string };
    expect(handed.status).toBe("verifying");

    git(["merge", "-q", "--no-ff", "-m", `Merge ${item.key}`, result.branch], folder);
    await codeLink.scan(project.id);
    expect(ctx.items.get(project.id, item.id)!.status).toBe("done");
  });

  describe("orientation: a project's first look at a repository it was pointed at", () => {
    it("has a coding agent read the repository in a worktree and write the project brief, once", async () => {
      const folder = localRepo();
      const world = await machine(null, { brief: false });
      const { codeLink, ctx, agent, project, board, turns } = world;
      const { repo } = await ctx.repos.addFromFolder(project.id, folder);
      // Nothing is read for a repository no workstream names: the agent would have nowhere to work.
      await codeLink.scan(project.id);
      expect(agent.store.threads(project.id)).toEqual([]);

      world.boards.update(project.id, board.id, { repoId: repo.id });
      await codeLink.scan(project.id);
      await until(() => !!agent.brief(project.id));
      expect(agent.brief(project.id)).toContain("pulled from the supplier feed");
      const threads = agent.store.threads(project.id);
      expect(threads.map((t) => t.title)).toEqual([`Orientation · ${path.basename(folder)}`]);
      expect(threads[0].boardId).toBe(board.id);
      const orientation = turns.find((t) => t.purpose === "backlog")!;
      expect(orientation.input).toMatchObject({ kind: "text", text: expect.stringContaining("Read CLAUDE.md or AGENTS.md, README, the manifests (package.json)") });
      expect(orientation.input).toMatchObject({ text: expect.stringContaining("update_project_brief") });
      // In a worktree of its own, never in the person's folder.
      expect(orientation.cwd).toBeTruthy();
      expect(orientation.cwd).not.toBe(folder);
      expect(fs.existsSync(path.join(orientation.cwd!, "package.json"))).toBe(true);

      await codeLink.scan(project.id);
      expect(agent.store.threads(project.id)).toHaveLength(1);
      expect(turns.filter((t) => t.purpose === "backlog")).toHaveLength(1);
    }, 20_000);

    it("writes the brief from the repository's own documents when no coding agent is installed", async () => {
      const folder = localRepo();
      fs.writeFileSync(path.join(folder, "README.md"), "# Shop\n\nA storefront whose products come from the supplier feed.\n");
      fs.writeFileSync(path.join(folder, "CLAUDE.md"), "Vue 3, pnpm test.\n");
      const world = await machine(null, { codeEngine: false, brief: false });
      const { codeLink, ctx, agent, project, board } = world;
      const { repo } = await ctx.repos.addFromFolder(project.id, folder);
      world.boards.update(project.id, board.id, { repoId: repo.id });
      await codeLink.scan(project.id);
      const brief = agent.brief(project.id)!;
      expect(brief).toContain("not by an agent that read the code");
      expect(brief).toContain("Manifests: package.json.");
      expect(brief).toContain("## CLAUDE.md\nVue 3, pnpm test.");
      expect(brief).toContain("## README.md\n# Shop");
      expect(agent.store.threads(project.id)).toEqual([]);
    }, 20_000);

    it("starts nothing for a repository with no project in it, or a project whose brief is already written", async () => {
      const empty = await machine(codeRepo({ manifest: false }), { brief: false });
      await empty.ctx.repos.setCheckout(empty.repo!.remote, empty.checkout!);
      await empty.codeLink.scan(empty.project.id);
      expect(empty.codeLink.repoStates(empty.project.id)[0]).toMatchObject({ readiness: "empty" });
      expect(empty.agent.brief(empty.project.id)).toBeNull();
      expect(empty.agent.store.threads(empty.project.id)).toEqual([]);

      const known = await machine(codeRepo());
      known.agent.store.setBrief(known.project.id, "Already known.");
      await known.ctx.repos.setCheckout(known.repo!.remote, known.checkout!);
      await known.codeLink.scan(known.project.id);
      expect(known.agent.brief(known.project.id)).toBe("Already known.");
      expect(known.agent.store.threads(known.project.id)).toEqual([]);
      expect(known.turns).toEqual([]);
    }, 20_000);
  });

  describe("a bootstrap started ahead of the ticket that needs it", () => {
    /** A repository with nothing in it, a workstream on it, and a feature ticket whose Start stops at the readiness gate. */
    async function emptyRepository() {
      const folder = path.join(root, `unborn-${n++}`);
      fs.mkdirSync(folder);
      git(["init", "-q", "-b", "main"], folder);
      git(["config", "user.email", "dev@localhost"], folder);
      git(["config", "user.name", "Dev"], folder);
      const world = await machine(null);
      const { codeLink, ctx, project, board, ticket } = world;
      const { repo } = await ctx.repos.addFromFolder(project.id, folder);
      world.boards.update(project.id, board.id, { repoId: repo.id });
      const feature = ticket("Welcome page");
      const gate = await codeLink.start(project.id, feature.id, { mode: "run", engine: "fake-code", options: { model: "m1" } });
      expect(gate).toMatchObject({ ok: false, gate: "readiness" });
      const bootstrap = ctx.items.list({ projectId: project.id }).find((i) => !gate.ok && i.key === gate.bootstrapKey)!;
      return { ...world, feature, bootstrap };
    }

    it("starts the bootstrap with the ticket's choices, remembers the ticket, and starts it by itself once the bootstrap is done", async () => {
      const { codeLink, ctx, agent, project, turns, feature, bootstrap } = await emptyRepository();
      const started = await codeLink.start(project.id, bootstrap.id, { mode: "run", engine: "fake-code", options: { model: "m1" }, then: feature.id });
      expect(started).toMatchObject({ ok: true });
      expect(codeLink.followOns()).toEqual([expect.objectContaining({ projectId: project.id, itemId: feature.id, afterItemId: bootstrap.id, options: { mode: "run", engine: "fake-code", options: { model: "m1" } } })]);
      // Started again while the bootstrap is still open, the ticket is remembered once.
      await codeLink.start(project.id, bootstrap.id, { mode: "run", engine: "fake-code", options: { model: "m1" }, then: feature.id });
      expect(codeLink.followOns()).toHaveLength(1);
      await untilRunsSettle(agent);
      expect(turns.length).toBeGreaterThan(0);
      expect(turns.every((turn) => turn.ticket?.key === bootstrap.key)).toBe(true);
      expect(ctx.items.get(project.id, feature.id)!.status).toBe("todo");

      ctx.items.update(project.id, bootstrap.id, { status: "done" }, "human");
      await until(() => turns.some((turn) => turn.ticket?.key === feature.key));
      await untilRunsSettle(agent);
      expect(codeLink.followOns()).toEqual([]);
      const run = turns.find((turn) => turn.ticket?.key === feature.key)!;
      expect(run.options).toMatchObject({ model: "m1" });
      expect(ctx.items.get(project.id, feature.id)!.status).toBe("doing");
      const thread = agent.store.threads(project.id, null).find((t) => t.itemId === feature.id)!;
      const notes = agent.store.messages(project.id, thread.id).filter((m) => m.role === "system").map((m) => JSON.stringify(m.block));
      expect(notes.some((note) => note.includes(`${bootstrap.key} landed`))).toBe(true);
      // Done is done once: nothing starts again.
      ctx.items.update(project.id, bootstrap.id, { status: "verifying" }, "human");
      ctx.items.update(project.id, bootstrap.id, { status: "done" }, "human");
      await untilRunsSettle(agent);
      expect(turns.filter((turn) => turn.ticket?.key === feature.key)).toHaveLength(1);
    }, 30_000);

    it("forgets the ticket when it is cancelled before the bootstrap lands, and survives a restart of the store", async () => {
      const { codeLink, ctx, agent, project, turns, feature, bootstrap, hubDir } = await emptyRepository();
      await codeLink.start(project.id, bootstrap.id, { mode: "run", engine: "fake-code", then: feature.id });
      await untilRunsSettle(agent);
      // Beside the Start defaults, as a file this machine keeps.
      const file = path.join(hubDir, "code-link-follow-ons.json");
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([expect.objectContaining({ itemId: feature.id, afterItemId: bootstrap.id })]);
      ctx.items.update(project.id, feature.id, { status: "cancelled" }, "human");
      expect(codeLink.followOns()).toEqual([]);
      ctx.items.update(project.id, bootstrap.id, { status: "done" }, "human");
      await untilRunsSettle(agent);
      expect(turns.map((turn) => turn.ticket?.key)).toEqual([bootstrap.key]);
    }, 30_000);
  });

  describe("merging from Tomrade in a repository with no remote", () => {
    /** A local repository, a ticket worked to Verifying on its branch, and that branch's worktree removed. */
    async function handed(title: string, opts: { agentMerge?: boolean } = {}) {
      const folder = localRepo();
      const world = await machine(null);
      const { codeLink, ctx, agent, project, board, ticket } = world;
      const { repo } = await ctx.repos.addFromFolder(project.id, folder);
      world.boards.update(project.id, board.id, { repoId: repo.id });
      if (opts.agentMerge) codeLink.setRepoPolicy(project.id, repo.id, { agentMerge: true });
      const item = ticket(title);
      const result = await codeLink.start(project.id, item.id, { mode: "run" });
      if (!result.ok) throw new Error(result.message);
      await untilRunsSettle(agent);
      await codeLink.scan(project.id);
      const as = (call: () => Promise<unknown>) => sessionContext.run({ projectId: project.id, sessionId: result.sessionId }, call);
      await as(() => ctx.tools.execute("link_code", { scopeChecked: true }, { by: "ai:fake-code", projectId: project.id }));
      expect(ctx.items.get(project.id, item.id)!.status).toBe("verifying");
      const main = () => git(["rev-parse", "main"], folder);
      return { ...world, folder, item, result, as, main, before: main() };
    }

    it("merges from a clean checkout on the default branch and finishes the ticket on that merge", async () => {
      const { codeLink, ctx, project, item, result, folder, main, before } = await handed("Merge here");
      const merged = await codeLink.mergeLocal(project.id, item.id);
      expect(merged).toMatchObject({ merged: true, sha: main() });
      expect(main()).not.toBe(before);
      expect(git(["log", "-1", "--format=%s", "main"], folder)).toBe(`${item.key}: Merge here`);
      expect(git(["merge-base", "--is-ancestor", result.branch, "main"], folder)).toBe("");
      expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ mergedSha: main() });
      expect(ctx.items.get(project.id, item.id)!.status).toBe("done");
    });

    it("merges through a temporary worktree when the default branch is not checked out, leaving the checkout as it was", async () => {
      const { codeLink, ctx, project, item, folder, main, before } = await handed("Merge elsewhere");
      git(["checkout", "-q", "-b", "side", "main"], folder);
      expect(await codeLink.mergeLocal(project.id, item.id)).toMatchObject({ merged: true });
      expect(main()).not.toBe(before);
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], folder)).toBe("side");
      expect(git(["worktree", "list", "--porcelain"], folder)).not.toContain("tomrade-merge-");
      expect(ctx.items.get(project.id, item.id)!.status).toBe("done");
    });

    it("refuses a default branch with uncommitted changes, and aborts a conflict, changing nothing", async () => {
      const { codeLink, ctx, project, item, folder, main, before } = await handed("Not now");
      fs.writeFileSync(path.join(folder, "package.json"), '{ "name": "changed" }\n');
      expect(await codeLink.mergeLocal(project.id, item.id)).toMatchObject({ merged: false, message: expect.stringContaining("uncommitted changes") });
      expect(main()).toBe(before);
      git(["checkout", "-q", "--", "package.json"], folder);

      fs.writeFileSync(path.join(folder, "work-1.ts"), "export const clash = 1;\n");
      git(["add", "-A"], folder);
      git(["commit", "-q", "-m", "clash on main"], folder);
      const clashed = main();
      expect(await codeLink.mergeLocal(project.id, item.id)).toMatchObject({ merged: false, message: expect.stringContaining("conflicts with main in work-1.ts") });
      expect(main()).toBe(clashed);
      expect(fs.existsSync(path.join(folder, ".git", "MERGE_HEAD"))).toBe(false);
      expect(git(["status", "--porcelain"], folder)).toBe("");
      expect(ctx.items.get(project.id, item.id)!.status).toBe("verifying");
    });

    it("lets the agent merge only where agent merging is on, and tells it so", async () => {
      const off = await handed("Person merges");
      const refused = (await off.as(() => off.ctx.tools.execute("merge_branch", {}, { by: "ai:fake-code", projectId: off.project.id }))) as { merged: boolean; message: string };
      expect(refused).toMatchObject({ merged: false, message: expect.stringContaining("Agents don't merge") });
      expect(off.main()).toBe(off.before);

      const on = await handed("Agent merges", { agentMerge: true });
      const prompt = JSON.stringify(on.agent.store.messages(on.project.id, on.result.threadId)[0].block);
      expect(prompt).toContain("call merge_branch");
      const merged = (await on.as(() => on.ctx.tools.execute("merge_branch", {}, { by: "ai:fake-code", projectId: on.project.id }))) as { merged: boolean };
      expect(merged).toMatchObject({ merged: true });
      expect(on.ctx.items.get(on.project.id, on.item.id)!.status).toBe("done");
    });
  });

  it("scans a repository added while a slower scan is still fetching", async () => {
    const slowGit = path.join(root, `git-slow-${n++}`);
    fs.writeFileSync(slowGit, `#!/bin/sh\nif [ "$1" = "fetch" ]; then sleep 1; fi\nexec git "$@"\n`, { mode: 0o755 });
    const world = await machine(codeRepo(), { gitBinary: slowGit });
    const { ctx, codeLink, project, repo, checkout } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const running = codeLink.scan(project.id);
    const { repo: local } = await ctx.repos.addFromFolder(project.id, localRepo());
    await running;
    const t0 = Date.now();
    // The follow-up scan runs git too; a loaded machine needs well over the 5 s a quiet one does.
    while (codeLink.repoStates(project.id).find((s) => s.repoId === local.id)?.remote !== "none" && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 50));
    expect(codeLink.repoStates(project.id).find((s) => s.repoId === local.id)).toMatchObject({ remote: "none", readiness: "scaffolded" });
  });

  it("says a run here is waiting while it asks permission, however long that takes, and stuck when it fails", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    let fail = false;
    agent.engine({
      id: "asking",
      title: "Asking agent",
      author: "ai:asking",
      capabilities: ["code"],
      available: async () => ({ ok: true }),
      async turn(_input, io) {
        if (fail) throw new Error("model overloaded");
        const said = await io.requestPermission!("Run npm install?", ["Allow", "Deny"]);
        io.emit({ type: "text", text: `got ${said}` });
        return { stop: "end" };
      }
    });
    const item = ticket("Ask before installing");
    const started = await codeLink.start(project.id, item.id, { mode: "run", engine: "asking" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const session = () => codeLink.sessionsOf(project.id, item.id)[0];

    // The question holds the run: the ticket says the session waits for the person…
    await vi.waitFor(() => expect(session()).toMatchObject({ state: "waiting", ask: { kind: "permission" } }), { timeout: 10_000 });
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "waiting" })]));
    // …and still does after a long silence, where a running session would be called idle.
    codeLink.sessions.sweep(project.id, Date.now() + 11 * 60 * 1000);
    expect(session().state).toBe("waiting");

    const question = agent.thread(project.id, started.threadId).pending!.question;
    agent.send(project.id, started.threadId, { kind: "answer", questionId: question.id, value: "Allow" });
    await untilRunsSettle(agent);
    expect(session()).toMatchObject({ state: "idle", activity: null });

    // A run that fails is stuck, not idle.
    fail = true;
    await codeLink.start(project.id, item.id, { mode: "run", engine: "asking" });
    await untilRunsSettle(agent);
    expect(session()).toMatchObject({ state: "error", summary: expect.stringContaining("model overloaded") });
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "stuck" })]));
  });

  it("does not answer the agent's open question with Continue, and points at the conversation instead", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    agent.engine({
      id: "asker",
      title: "Asking agent",
      author: "ai:asker",
      capabilities: ["code"],
      available: async () => ({ ok: true }),
      async turn(_input, io) {
        const result = await io.tools.execute("ask_user", { question: "Postgres or SQLite?", options: ["Postgres", "SQLite"] });
        return { stop: (result as { suspended?: boolean })?.suspended === false ? "end" : "asked" };
      }
    });
    const item = ticket("Pick a database");
    const first = await codeLink.start(project.id, item.id, { mode: "run", engine: "asker" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await untilRunsSettle(agent);
    expect(agent.store.pending(project.id, first.threadId)?.question.text).toBe("Postgres or SQLite?");
    const said = () => agent.store.messages(project.id, first.threadId).filter((m) => m.role === "user").length;
    const before = said();

    // Continue: nothing is sent — a message would count as the answer — and the question is handed back.
    const again = await codeLink.start(project.id, item.id, { mode: "run", engine: "asker" });
    expect(again).toMatchObject({ ok: true, continued: true, threadId: first.threadId, waitingOn: "Postgres or SQLite?" });
    expect(said()).toBe(before);
    expect(agent.store.pending(project.id, first.threadId)?.question.text).toBe("Postgres or SQLite?");

    // The Code section's Continue and its Conversation row both bring the conversation up.
    expect(await ctx.contributions.run("code-link.start-run", { projectId: project.id, itemId: item.id })).toMatchObject({ showThread: first.threadId, toast: expect.stringContaining("Postgres or SQLite?") });
    expect(await ctx.contributions.run("code-link.open-thread", { projectId: project.id, itemId: item.id })).toEqual({ showThread: first.threadId });
    const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!;
    expect(section.rows.find((r) => r.label === "Conversation")).toMatchObject({ command: "code-link.open-thread" });
  });

  it("speaks the person's language in the Code section, the badges and the status bar", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
    const item = ticket("中文界面");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    await untilRunsSettle(agent);
    const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!;
    expect(section.title).toBe("代码");
    expect(section.rows.map((r) => r.label)).toEqual(expect.arrayContaining(["分支", "会话", "继续", "对话", "工作树"]));
    expect(section.rows.find((r) => r.label === "会话")?.value).toMatch(/^空闲 · 由 Tomrade 运行/);
    expect((await ctx.contributions.statusItems({ projectId: project.id })).find((s) => s.id === "code-link")?.text).toMatch(/^代码：1 个会话/);
    expect(ctx.contributions.commands().find((c) => c.id === "code-link.start-run")).toMatchObject({ title: "在这里开始工单", group: "代码" });
    // The agent reads the brief in English but answers in the language the person reads Tomrade in.
    const brief = agent.store.messages(project.id, started.threadId)[0]?.block;
    expect(brief?.type === "text" && brief.text).toContain("write everything the person will read");
    expect(brief?.type === "text" && brief.text).toContain("Simplified Chinese");
  });

  it("archives completed code conversations while retaining their messages and links", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Archive delivered code");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);
    const messages = agent.store.messages(project.id, started.threadId);
    await ctx.tools.execute("link_code", { key: item.key, branch: started.branch, prState: "merged" }, { by: "human", projectId: project.id });
    expect(ctx.items.get(project.id, item.id)?.status).toBe("done");
    expect(agent.store.threads(project.id).map(t => t.id)).not.toContain(started.threadId);
    expect(agent.store.archivedThreads(project.id).map(t => t.id)).toContain(started.threadId);
    expect(agent.store.messages(project.id, started.threadId)).toEqual(messages);
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ threadId: started.threadId, branch: started.branch, prState: "merged" });
    expect(codeLink.store.session(project.id, started.sessionId)).toMatchObject({ state: "ended", threadId: started.threadId });
  });

  it.each(["scan", "db/opened", "storage/imported"] as const)("backfills completed sessions on %s without repeating archive operations", async trigger => {
    const { codeLink, ctx, agent, project, repo, ticket } = await machine(codeRepo());
    const done = ticket("Previously completed");
    ctx.items.update(project.id, done.id, { status: "done" }, "human");
    const open = ticket("Still needs work");
    const cancelled = ticket("Cancelled work");
    ctx.items.update(project.id, cancelled.id, { status: "cancelled" }, "human");
    const seed = (itemIds: string[], mode: "headless" | "terminal" = "headless") => {
      const thread = agent.store.createThread(project.id, "fake-code", "Historical code", null, itemIds[0], "tom-history", "code");
      return codeLink.store.createSession(project.id, { repoId: repo!.id, branch: "tom-history", itemIds, mode, agent: "fake-code", threadId: thread.id, device: "test" });
    };
    const completed = [seed([done.id]), seed([done.id], "terminal")];
    const untouched = [seed([open.id]), seed([done.id, open.id]), seed([cancelled.id]), seed([])];
    const archive = vi.spyOn(agent, "archiveThread");
    const check = async () => {
      if (trigger === "scan") await codeLink.scan(project.id);
      else ctx.emit(trigger, project.id);
    };
    await check();
    for (const session of completed) {
      expect(agent.store.thread(project.id, session.threadId!)?.archived).toBe(true);
      expect(codeLink.store.session(project.id, session.id)?.state).toBe("ended");
    }
    for (const session of untouched) {
      expect(agent.store.thread(project.id, session.threadId!)?.archived).toBe(false);
      expect(codeLink.store.session(project.id, session.id)?.state).not.toBe("ended");
    }
    expect(archive).toHaveBeenCalledTimes(2);
    const rows = completed.map(session => codeLink.store.session(project.id, session.id));
    await check();
    expect(archive).toHaveBeenCalledTimes(2);
    expect(completed.map(session => codeLink.store.session(project.id, session.id))).toEqual(rows);
  });

  it("defers archiving a completed ticket until its active run ends", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    agent.engine({ ...fakeCodeEngine([]), id: "held", async turn() { await gate; return { stop: "end" }; } });
    const item = ticket("Finish while running");
    const started = await codeLink.start(project.id, item.id, { mode: "run", engine: "held" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    try {
      ctx.items.update(project.id, item.id, { status: "done" }, "human");
      expect(agent.store.thread(project.id, started.threadId)?.archived).toBe(false);
      expect(codeLink.store.session(project.id, started.sessionId)?.state).not.toBe("ended");
    } finally {
      release();
    }
    await untilRunsSettle(agent);
    expect(agent.store.thread(project.id, started.threadId)?.archived).toBe(true);
    expect(codeLink.store.session(project.id, started.sessionId)?.state).toBe("ended");
  });

  it("brings an archived conversation back when its ticket is continued", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Archived midway");
    const first = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await untilRunsSettle(agent);
    agent.archiveThread(project.id, first.threadId);
    expect(agent.store.archivedThreads(project.id).map((t) => t.id)).toContain(first.threadId);
    const again = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(again).toMatchObject({ ok: true, continued: true, threadId: first.threadId });
    expect(agent.store.thread(project.id, first.threadId)?.archived).toBe(false);
    await untilRunsSettle(agent);
  });

  it("puts away a finished ticket's threads that never got a session, once, and leaves one a person brought back", async () => {
    const { codeLink, ctx, agent, project, ticket } = await machine(codeRepo());
    const item = ticket("Left a stray thread");
    const stray = agent.store.createThread(project.id, "fake-code", "Stray", null, item.id, "tom-stray", "assistant");
    ctx.items.update(project.id, item.id, { status: "done" }, "human");
    expect(agent.store.thread(project.id, stray.id)?.archived).toBe(true);
    agent.unarchiveThread(project.id, stray.id, { restored: true });
    await codeLink.scan(project.id);
    expect(agent.store.thread(project.id, stray.id)).toMatchObject({ archived: false, restored: true });
  });

  it("never brings a finished ticket's worktree back on its own; only reopening and starting it does", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Finished and tidied");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);
    await ctx.tools.execute("link_code", { key: item.key, branch: started.branch, prState: "merged" }, { by: "human", projectId: project.id });
    expect(agent.store.thread(project.id, started.threadId)?.archived).toBe(true);
    // The person tidies up after the merge.
    git(["worktree", "remove", "--force", started.worktree!], checkout!);
    git(["branch", "-D", started.branch], checkout!);

    // Looking at the conversation reports; it does not make anything.
    expect(await agent.workdir(project.id, started.threadId)).toMatchObject({ cwd: null, problem: null });
    await codeLink.scan(project.id);
    expect(fs.existsSync(started.worktree!)).toBe(false);
    expect(git(["branch", "--list", started.branch], checkout!)).toBe("");

    // Archived means read-only.
    expect(() => agent.send(project.id, started.threadId, { kind: "text", text: "one more thing" })).toThrow(/archived/);
    // Brought back by hand, a turn still does not quietly recreate finished work.
    agent.unarchiveThread(project.id, started.threadId, { restored: true });
    expect(await agent.workdir(project.id, started.threadId)).toMatchObject({ cwd: null, code: "finished" });
    expect(await agent.workdir(project.id, started.threadId, { create: true })).toMatchObject({ cwd: null, code: "finished" });
    expect(fs.existsSync(started.worktree!)).toBe(false);

    expect(() => agent.send(project.id, started.threadId, { kind: "text", text: "one more thing" })).toThrow(/Reopen it/);

    // Bringing the work back is the person's call: reopen the ticket and continue this conversation.
    ctx.items.update(project.id, item.id, { status: "doing" }, "human");
    const again = await codeLink.start(project.id, item.id, { mode: "run", threadId: started.threadId, message: "one more thing" });
    expect(again).toMatchObject({ ok: true, continued: true, threadId: started.threadId, branch: `${started.branch}-2` });
    if (!again.ok) return;
    expect(fs.existsSync(again.worktree!)).toBe(true);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], again.worktree!)).toBe(`${started.branch}-2`);
    expect(agent.store.thread(project.id, started.threadId)).toMatchObject({ branch: `${started.branch}-2`, restored: false });
    await untilRunsSettle(agent);
    expect(agent.store.messages(project.id, started.threadId).some((m) => m.role === "user" && m.block.type === "text" && m.block.text.endsWith("one more thing"))).toBe(true);
  });

  it("does not rebuild the worktree of a conversation whose ticket was deleted", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Deleted later");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);
    ctx.items.delete(project.id, item.id, "human");
    git(["worktree", "remove", "--force", started.worktree!], checkout!);
    expect(await agent.workdir(project.id, started.threadId, { create: true })).toMatchObject({ cwd: null, code: "finished" });
    expect(fs.existsSync(started.worktree!)).toBe(false);
  });

  it("moves a kept worktree onto the reopened delivery's branch, and refuses while it has uncommitted work", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Reopened with its worktree");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);
    await ctx.tools.execute("link_code", { key: item.key, branch: started.branch, prState: "merged" }, { by: "human", projectId: project.id });
    agent.unarchiveThread(project.id, started.threadId, { restored: true });
    ctx.items.update(project.id, item.id, { status: "doing" }, "human");
    fs.writeFileSync(path.join(started.worktree!, "scratch.txt"), "half done\n");
    expect(await codeLink.start(project.id, item.id, { mode: "run", threadId: started.threadId })).toMatchObject({ ok: false, gate: "workdir", message: expect.stringContaining("uncommitted") });
    expect(agent.store.thread(project.id, started.threadId)?.branch).toBe(started.branch);
    fs.rmSync(path.join(started.worktree!, "scratch.txt"));
    const again = await codeLink.start(project.id, item.id, { mode: "run", threadId: started.threadId });
    expect(again).toMatchObject({ ok: true, threadId: started.threadId, worktree: started.worktree, branch: `${started.branch}-2` });
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], started.worktree!)).toBe(`${started.branch}-2`);
    await untilRunsSettle(agent);
  });

  it("names the conversations a Start opened in the thread list", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const started = await codeLink.start(project.id, ticket("Named in the list").id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const plain = agent.newThread(project.id);
    const listed = agent.withOrigins(project.id, agent.store.threads(project.id));
    expect(listed.find((th) => th.id === started.threadId)?.origins).toEqual(["Code Link"]);
    expect(listed.find((th) => th.id === plain.id)?.origins).toBeUndefined();
    await untilRunsSettle(agent);
  });

  it("leaves no thread behind when a Start is refused at the working folder", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, hubDir, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    // Nothing can be made under the Hub's worktrees folder.
    fs.rmSync(path.join(hubDir, "worktrees"), { recursive: true, force: true });
    fs.writeFileSync(path.join(hubDir, "worktrees"), "");
    const item = ticket("Refused at the folder");
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "workdir" });
    expect(agent.store.threadsForItem(project.id, item.id)).toEqual([]);
    fs.rmSync(path.join(hubDir, "worktrees"));
    const retried = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(retried.ok).toBe(true);
    expect(agent.store.threadsForItem(project.id, item.id)).toHaveLength(1);
    await untilRunsSettle(agent);
  });

  it("says why a continued conversation has no folder: a workstream with no repository, one whose repository is gone, no workstream at all", async () => {
    const { codeLink, ctx, agent, boards, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Conversation moved off the workstream");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);

    const docs = boards.create({ projectId: project.id, name: "Docs" });
    agent.setWorkstream(project.id, started.threadId, docs.id);
    // A conversation may run without a folder, so looking is no problem; a Start that needs one says why.
    expect(await agent.workdir(project.id, started.threadId)).toMatchObject({ cwd: null, problem: null, code: "no-board-repo" });
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "workdir", cause: { code: "no-board-repo" }, board: { id: docs.id, name: "Docs" }, message: expect.stringContaining("Docs has no repository yet") });

    boards.update(project.id, docs.id, { repoId: "repo-gone" });
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "workdir", cause: { code: "unknown-repo", repoId: "repo-gone" }, message: expect.stringContaining("repo-gone") });

    agent.setWorkstream(project.id, started.threadId, null);
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "workdir", cause: { code: "no-board" }, message: expect.stringContaining("no workstream") });
  });

  it("names the worktree that already has the ticket's branch", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Branch held elsewhere");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);
    // Another session takes the branch into a worktree of its own, and Tomrade's is gone.
    git(["worktree", "remove", "--force", started.worktree!], checkout!);
    const elsewhere = path.join(root, `elsewhere-${n++}`);
    git(["worktree", "add", "-q", elsewhere, started.branch], checkout!);
    const refused = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(refused).toMatchObject({ ok: false, gate: "workdir", cause: { code: "branch-in-use", branch: started.branch }, message: expect.stringContaining("already checked out in") });
    if (refused.ok) return;
    expect(fs.realpathSync(refused.cause!.heldAt!)).toBe(fs.realpathSync(elsewhere));
    // Not this ticket's worktree, so only the person lets go of it there; its files stay, detached at the same commit.
    expect(refused.cause!.releasable).toBe(true);
    const head = git(["rev-parse", "HEAD"], elsewhere);
    const released = await codeLink.start(project.id, item.id, { mode: "run", releaseBranch: true });
    expect(released).toMatchObject({ ok: true, branch: started.branch });
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], elsewhere)).toBe("HEAD");
    expect(git(["rev-parse", "HEAD"], elsewhere)).toBe(head);
    await untilRunsSettle(agent);
  });

  it("continues where this ticket's earlier session left its branch, and never takes it from uncommitted work or a running session", async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Branch left in a session's worktree");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    if (!started.ok) throw new Error(started.message);
    await untilRunsSettle(agent);
    git(["worktree", "remove", "--force", started.worktree!], checkout!);
    // A terminal session that claimed the ticket worked it in a worktree of its own, and is waiting at its prompt.
    const theirs = path.join(root, `claimed-${n++}`);
    git(["worktree", "add", "-q", theirs, started.branch], checkout!);
    const outside = codeLink.store.createSession(project.id, { repoId: repo!.id, branch: started.branch, itemIds: [item.id], mode: "terminal", agent: "claude-code", threadId: null, device: "test", worktree: theirs });
    codeLink.store.patchSession(project.id, outside.id, { state: "running" });
    expect(await codeLink.start(project.id, item.id, { mode: "run", releaseBranch: true })).toMatchObject({ ok: false, cause: { code: "branch-in-use", releasable: false } });
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], theirs)).toBe(started.branch);

    codeLink.store.patchSession(project.id, outside.id, { state: "waiting" });
    fs.appendFileSync(path.join(theirs, "README.md"), "half done\n");
    expect(await codeLink.start(project.id, item.id, { mode: "run", releaseBranch: true })).toMatchObject({ ok: false, cause: { code: "branch-in-use", releasable: false } });
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], theirs)).toBe(started.branch);
    expect(fs.readFileSync(path.join(theirs, "README.md"), "utf8")).toContain("half done");

    git(["checkout", "--", "README.md"], theirs);
    const continued = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(continued).toMatchObject({ ok: true, branch: started.branch });
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], theirs)).toBe("HEAD");
    await untilRunsSettle(agent);
  });

  it("starts a reopened ticket in a fresh delivery, thread and suffixed branch", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Revise notifications");

    const first = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await untilRunsSettle(agent);
    await ctx.tools.execute("link_code", { key: item.key, branch: first.branch, prState: "merged" }, { by: "human", projectId: project.id });
    expect(ctx.items.get(project.id, item.id)!.status).toBe("done");

    // Linking a merged pull request afterwards is history: on the finished delivery, nothing reopened.
    expect(await sessionContext.run({ projectId: project.id, sessionId: first.sessionId }, () => ctx.tools.execute("link_code", { prState: "merged", scopeChecked: true }, { by: "human", projectId: project.id }))).toMatchObject({
      status: "done",
      warning: expect.stringContaining("not changed")
    });
    expect(codeLink.deliveries(project.id, item.id)).toHaveLength(1);
    ctx.items.update(project.id, item.id, { status: "todo" }, "human");
    const second = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second).toMatchObject({ continued: false, branch: `tom-${item.keyNum}/revise-notifications-2` });
    expect(second.threadId).not.toBe(first.threadId);
    expect(codeLink.links(project.id, item.id).map((link) => [link.delivery, link.branch])).toEqual([
      [1, first.branch],
      [2, second.branch]
    ]);
    expect(codeLink.sessionsOf(project.id, item.id).map((session) => session.delivery).sort()).toEqual([1, 2]);
  });

  it("asks the person before an open pull request reopens a finished ticket", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Finished already");
    const first = await codeLink.start(project.id, item.id, { mode: "run" });
    if (!first.ok) throw new Error(first.message);
    await untilRunsSettle(agent);
    await ctx.tools.execute("link_code", { key: item.key, branch: first.branch, prState: "merged" }, { by: "human", projectId: project.id });
    expect(ctx.items.get(project.id, item.id)!.status).toBe("done");

    const inSession = (tool: string, args: unknown) => sessionContext.run({ projectId: project.id, sessionId: first.sessionId }, () => ctx.tools.execute(tool, args, { by: "human", projectId: project.id }));
    const prUrl = "https://github.com/acme/app/pull/9";
    expect(await inSession("link_code", { branch: "tom-x/more", prUrl, scopeChecked: true })).toMatchObject({ ok: false, status: "done" });
    expect(await inSession("link_code", { branch: "tom-x/more", prUrl, scopeChecked: true })).toMatchObject({ ok: false });
    expect(codeLink.proposals(project.id, item.id)).toMatchObject([{ fromStatus: "done", toStatus: "doing" }]);
    expect(ctx.items.get(project.id, item.id)!.status).toBe("done");
    expect(codeLink.deliveries(project.id, item.id)).toHaveLength(1);
    expect(codeLink.links(project.id, item.id).map((link) => link.branch)).toEqual([first.branch]);

    // A session Tomrade started stays with its one ticket, finished or not.
    const other = ticket("Something else");
    await expect(inSession("claim_ticket", { key: other.key })).rejects.toThrow(`this session already owns ${item.key}`);
    await expect(inSession("claim_ticket", { key: other.key, parallel: true })).rejects.toThrow(`cannot claim ${other.key} in parallel — start_ticket ${other.key}`);
    expect(codeLink.sessionsOf(project.id, other.id)).toEqual([]);
    await untilRunsSettle(agent);
  });

  it("moves a session left on an earlier delivery onto the reopened one, never with the branch already merged", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Revise reminders");
    const first = await codeLink.start(project.id, item.id, { mode: "run" });
    if (!first.ok) throw new Error(first.message);
    await untilRunsSettle(agent);
    await ctx.tools.execute("link_code", { key: item.key, branch: first.branch, prState: "merged" }, { by: "human", projectId: project.id });
    expect(ctx.items.get(project.id, item.id)!.status).toBe("done");
    ctx.items.update(project.id, item.id, { status: "todo" }, "human");

    const inSession = (tool: string, args: unknown) => sessionContext.run({ projectId: project.id, sessionId: first.sessionId }, () => ctx.tools.execute(tool, args, { by: "human", projectId: project.id }));
    const claimed = (await inSession("claim_ticket", { key: item.key })) as { branch: string };
    expect(claimed.branch).toBe(`tom-${item.keyNum}/revise-reminders-2`);
    expect(codeLink.store.session(project.id, first.sessionId)).toMatchObject({ delivery: 2, branch: claimed.branch });

    await expect(inSession("link_code", { branch: first.branch, prState: "merged", scopeChecked: true })).rejects.toThrow("already merged in");
    await inSession("link_code", { scopeChecked: true });
    expect(ctx.items.get(project.id, item.id)!.status).not.toBe("done");
    expect(codeLink.links(project.id, item.id).map((link) => [link.delivery, link.branch])).toEqual([
      [1, first.branch],
      [2, claimed.branch]
    ]);
    await untilRunsSettle(agent);
  });

  it("tells the agent who merges, and hands a refused merge to the person with a link", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const brief = (threadId: string) => JSON.stringify(agent.store.messages(project.id, threadId)[0].block);

    const off = ticket("Merge by hand");
    const manual = await codeLink.start(project.id, off.id, { mode: "run" });
    if (!manual.ok) throw new Error(manual.message);
    await untilRunsSettle(agent);
    expect(brief(manual.threadId)).toContain("do not merge the pull request; the human merges it");

    expect(codeLink.setRepoPolicy(project.id, repo!.id, { agentMerge: true }).agentMerge).toBe(true);
    expect(await codeLink.mergeChecks(project.id, repo!.id)).toEqual([{ engine: "fake-code", title: "Fake coding agent", check: null }]);
    const engine = agent.codeEngines().find((e) => e.id === "fake-code")!;
    engine.permissionModes = { default: "full-access", choices: [] };
    expect(await codeLink.mergeChecks(project.id, repo!.id)).toEqual([{ engine: "fake-code", title: "Fake coding agent", check: { state: "allowed", why: "bypass", mode: "full-access" } }]);
    engine.permissionModes = { default: "ask", choices: [] };
    expect(await codeLink.mergeChecks(project.id, repo!.id)).toEqual([{ engine: "fake-code", title: "Fake coding agent", check: null }]);
    delete engine.permissionModes;
    const item = ticket("Merge it yourself");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    if (!started.ok) throw new Error(started.message);
    await untilRunsSettle(agent);
    expect(brief(started.threadId)).toContain("merging is yours");
    expect(brief(started.threadId)).toContain("report_merge_blocked");
    expect(brief(started.threadId)).toContain("If the checks cannot be read at all");
    expect(brief(started.threadId)).toContain("'no checks reported' means there is nothing to wait for");

    const prUrl = "https://github.com/acme/app/pull/7";
    const link = codeLink.links(project.id, item.id)[0]!;
    codeLink.store.patchLink(project.id, link.id, { prUrl, prNumber: 7, prState: "open" });
    const response = codeLink.sessions.event(project.id, started.sessionId, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: `gh pr merge ${prUrl} --squash` },
      tool_error: "GraphQL: Base branch policy prohibits the merge. Required status check \"ci\" is expected."
    });
    expect(response).toMatchObject({ additionalContext: expect.stringContaining("Do not try to merge another way") });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", blocked: "merge", summary: expect.stringContaining("merge blocked:") });
    const notes = agent.store.messages(project.id, started.threadId).filter((message) => message.block.type === "note").map((message) => (message.block as { text: string }).text);
    expect(notes.at(-1)).toContain("merge blocked:");
    // a merge refusal is not a credential stop: other gh commands still run
    expect(codeLink.sessions.event(project.id, started.sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr view 7" } })).toEqual({});

    const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find((entry) => entry.id === "code")!;
    expect(section.rows).toContainEqual(expect.objectContaining({ label: "Merge", state: "warn", href: prUrl }));

    // origin being reachable clears credential stops, not a merge the person still owes
    await codeLink.scan(project.id);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ blocked: "merge" });
  });

  it("stops a session retry loop after git reports that its credentials cannot see origin", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Private push");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await untilRunsSettle(agent);

    const response = codeLink.sessions.event(project.id, started.sessionId, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "git push origin HEAD" },
      tool_error: "remote: Repository not found.\nfatal: repository 'https://token@github.com/acme/private.git/' not found"
    });
    expect(response).toMatchObject({ additionalContext: expect.stringContaining("Credentials are the human's to fix") });
    expect(JSON.stringify(response)).not.toContain("token@");
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", blocked: "credentials", activity: null, summary: expect.stringContaining("cannot reach origin") });
    const notes = () => agent.store.messages(project.id, started.threadId).filter((message) => message.block.type === "note").map((message) => (message.block as { text: string }).text);
    expect(notes().at(-1)).toContain("cannot reach origin from this worktree");

    const denied = codeLink.sessions.event(project.id, started.sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin HEAD" } });
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("blocked: push") } });
    expect(codeLink.sessions.event(project.id, started.sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" } })).toEqual({});
    codeLink.sessions.touch(project.id, started.sessionId, { state: "running", summary: "blocked: push waiting for the human" });
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("error");

    const continued = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(continued).toMatchObject({ ok: true, continued: true });
    expect(codeLink.sessionsOf(project.id, item.id)[0].blocked).toBeNull();
    await untilRunsSettle(agent);

    codeLink.sessions.event(project.id, started.sessionId, {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create" },
      tool_output: { exit_code: 1, stderr: "Invalid username or token." }
    });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", blocked: "credentials" });
    await codeLink.scan(project.id);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "idle", blocked: null });

    // Claude Code's own field names; a limit is said as one, and the thread waits for it
    codeLink.sessions.event(project.id, started.sessionId, { hook_event_name: "StopFailure", error: "rate_limit", error_details: "You've hit your limit · resets 8pm" });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", blocked: null, summary: expect.stringMatching(/^usage limit — lifts at (tomorrow )?20:00$/) });
    codeLink.sessions.event(project.id, started.sessionId, { hook_event_name: "StopFailure", error: "authentication_failed", error_details: "Invalid API key" });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", summary: "stopped: authentication_failed — Invalid API key" });
  });

  it("opens a terminal session: files for the agent, a token that binds its calls and hooks to the ticket", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    const item = ticket("Terminal work");

    // Without the MCP server there is nothing for the agent to connect to.
    expect(await codeLink.start(project.id, item.id, { mode: "terminal" })).toMatchObject({ ok: false, gate: "mcp" });

    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    // a terminal agent gets no system prompt from Tomrade: the project's rules travel in its first prompt
    ctx.agent.setRules(project.id, "- Commit messages in English");
    // What the Start was offered with is the terminal agent's first instruction after its brief, as it is a headless run's.
    const result = await codeLink.start(project.id, item.id, { mode: "terminal", message: "PR #9 conflicts with main: merge origin/main first" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ mode: "terminal", launched: false });
    expect(result.command).toMatch(/^"claude" --mcp-config ".*mcp\.json" --settings ".*settings\.json" "\$\(cat ".*prompt\.md"\)"$/);
    const dir = codeLink.sessionDir(result.sessionId);
    const mcpConfig = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")) as { mcpServers: { tomrade: { url: string; headers: Record<string, string> } } };
    expect(mcpConfig.mcpServers.tomrade.url).toBe(ctx.mcp.urlFor(project.id));
    const token = mcpConfig.mcpServers.tomrade.headers["X-Tomrade-Run"];
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toEqual(expect.arrayContaining(["SessionStart", "Stop", "Notification", "SessionEnd"]));
    expect(JSON.stringify(settings)).not.toMatch(/(?:^|\s)>\/dev\/null/);
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toContain(`Implement ${item.key}`);
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toContain(`this run owns exactly ${item.key}`);
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toContain("inspect the full diff");
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toContain("\n\nPR #9 conflicts with main: merge origin/main first\n\nProject rules");
    expect(fs.readFileSync(path.join(dir, "prompt.md"), "utf8")).toMatch(/Project rules — [^\n]*\n- Commit messages in English$/);
    expect(fs.existsSync(path.join(dir, "run.command"))).toBe(true);

    // The native MCP client goes through the session binding, not the plain
    // project endpoint. Deferred tool execution must retain the Tools service.
    const client = new Client({ name: "terminal-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpConfig.mcpServers.tomrade.url), { requestInit: { headers: { "X-Tomrade-Run": token } } }));
    const listed = await client.callTool({ name: "list_items", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(JSON.stringify(listed.content)).toContain(item.key);
    const crossTicketWrite = await client.callTool({ name: "change_status", arguments: { id: item.id, status: "done" } });
    expect(crossTicketWrite.isError).toBe(true);
    expect(JSON.stringify(crossTicketWrite.content)).toContain("coding session cannot edit the backlog");
    expect(ctx.items.get(project.id, item.id)!.status).toBe("doing");
    // A follow-up may be filed: it waits in Backlog, names the session it came from, and stays out of the session.
    ctx.tools.register(
      defineTool({
        name: "find_similar",
        title: "Find similar",
        description: "",
        input: z.object({ title: z.string().optional(), body: z.string().optional() }),
        readOnly: true,
        execute: ({ title }) => (title === "Already there" ? { verdict: "duplicate", matches: [{ key: item.key, title: item.title }] } : { verdict: "none", matches: [] })
      })
    );
    const filed = await client.callTool({ name: "create_item", arguments: { title: "Follow-up found on the way", body: "Seen while testing." } });
    expect(filed.isError).not.toBe(true);
    const followUp = ctx.items.list({ projectId: project.id }).find((i) => i.title === "Follow-up found on the way")!;
    expect(followUp).toMatchObject({ status: "backlog", body: `Seen while testing.\n\nFiled from ${item.key}'s coding session.` });
    expect(codeLink.store.session(project.id, result.sessionId)!.itemIds).toEqual([item.id]);
    const duplicate = await client.callTool({ name: "create_item", arguments: { title: "Already there" } });
    expect(duplicate.isError).toBe(true);
    expect(JSON.stringify(duplicate.content)).toContain(`${item.key} (${item.title}) already describes this`);
    const sideEdit = await client.callTool({ name: "update_item", arguments: { id: followUp.id, patch: { title: "x" } } });
    expect(sideEdit.isError).toBe(true);
    const uncheckedLink = await client.callTool({ name: "link_code", arguments: { prUrl: "https://github.com/acme/app/pull/9" } });
    expect(uncheckedLink.isError).toBe(true);
    expect(JSON.stringify(uncheckedLink.content)).toContain("scopeChecked: true");
    await client.close();

    // A hook posts to the event URL: the session's state follows.
    const post = async (payload: unknown) => {
      const res = await fetch(ctx.mcp.eventUrlFor(token)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      return res.status;
    };
    expect(await post({ hook_event_name: "SessionStart", session_id: "cli-abc" })).toBe(200);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "running", externalId: "cli-abc", mode: "terminal", herdrPane: null });
    // Run inside a herdr pane, the hook names it: the ticket says so, and the row leads back to that pane.
    const paned = await fetch(ctx.mcp.eventUrlFor(token)!, { method: "POST", headers: { "Content-Type": "application/json", "X-Tomrade-Herdr-Pane": "w2:p1" }, body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cli-abc" }) });
    expect(paned.status).toBe(200);
    expect(codeLink.sessionsOf(project.id, item.id)[0].herdrPane).toBe("w2:p1");
    // And the terminal app it runs in, for a window that cannot show it.
    await fetch(ctx.mcp.eventUrlFor(token)!, { method: "POST", headers: { "Content-Type": "application/json", "X-Tomrade-Terminal": "iTerm.app" }, body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cli-abc" }) });
    expect(codeLink.sessionsOf(project.id, item.id)[0].terminal).toBe("iTerm.app");
    // Windows Terminal says only its session id: the session takes it for Windows Terminal.
    await fetch(ctx.mcp.eventUrlFor(token)!, { method: "POST", headers: { "Content-Type": "application/json", "X-Tomrade-WT": "6a3f-wt" }, body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cli-abc" }) });
    expect(codeLink.sessionsOf(project.id, item.id)[0].terminal).toBe("WindowsTerminal");
    expect((await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!.rows.find((r) => r.label === "Session")).toMatchObject({ value: expect.stringContaining("in herdr"), command: "code-link.open-terminal" });
    await post({ hook_event_name: "Stop", session_id: "cli-abc" });
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("waiting");
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual(expect.arrayContaining([{ id: "waiting", label: "waiting", tone: "strong", title: "The coding session is waiting for you" }]));

    // Each tool call says what the agent is doing; what it says when it stops stays with the Code session.
    await post({ hook_event_name: "PreToolUse", session_id: "cli-abc", tool_name: "Bash", tool_input: { command: "flutter create ." } });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "running", activity: "Bash · flutter create ." });
    expect((await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!.rows.find((r) => r.label === "Session")).toMatchObject({ state: "live", value: expect.stringContaining("Bash · flutter create .") });
    await post({ hook_event_name: "PostToolUse", session_id: "cli-abc", tool_name: "Bash" });
    expect(codeLink.sessionsOf(project.id, item.id)[0].activity).toBeNull();
    await post({ hook_event_name: "Stop", session_id: "cli-abc", last_assistant_message: "Scaffold in place.\n\nNext: CI." });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "waiting", summary: "Scaffold in place." });
    expect(ctx.agent.store.threads(project.id)).toEqual([]);
    expect(ctx.agent.store.thread(project.id, result.threadId)).toMatchObject({ surface: "code" });
    expect(ctx.agent.store.messages(project.id, result.threadId)).toEqual([]);
    await post({ hook_event_name: "StopFailure", session_id: "cli-abc", error_type: "rate_limit", error_message: "retry after 20:00" });
    const limited = expect.stringMatching(/^usage limit — lifts at (tomorrow )?20:00$/);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ state: "error", summary: limited });
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual(expect.arrayContaining([{ id: "stuck", label: "stuck", tone: "strong", title: limited }]));
    // a terminal cannot be typed into: when the limit lifts the person is told, not the agent
    expect(ctx.agent.parked(project.id, result.threadId)).toMatchObject({ resume: false, known: true });
    // Tomrade restarts: the binding is gone from memory, the token is still in the session's folder, and comes back.
    codeLink.sessions.release(result.sessionId);
    expect(await post({ hook_event_name: "PostToolUse" })).toBe(404);
    expect(codeLink.rebindSessions(project.id)).toBe(1);
    expect(await post({ hook_event_name: "PostToolUse" })).toBe(200);
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("running");

    expect(await post({ hook_event_name: "SessionEnd" })).toBe(200);
    expect(codeLink.sessionsOf(project.id, item.id)[0].state).toBe("ended");
    expect((await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!.rows.find((r) => r.label === "Session")).toMatchObject({ value: expect.stringContaining("ended") });
    expect(await post({ hook_event_name: "SessionStart" })).toBe(404);

    // Continuing resumes the CLI session it learned about.
    const again = await codeLink.start(project.id, item.id, { mode: "terminal" });
    expect(again.ok && again.continued).toBe(true);
    expect(again.ok ? again.command : "").toContain("--resume cli-abc");
    if (!again.ok) return;

    // The launch script leaves its pid; a pid that no longer answers ends the session at the next sweep, hook or no hook.
    const script = fs.readFileSync(path.join(codeLink.sessionDir(again.sessionId), "run.command"), "utf8");
    expect(script).toContain("echo $$ >");
    fs.writeFileSync(path.join(codeLink.sessionDir(again.sessionId), "pid"), "99999\n");
    codeLink.sessions.sweep(project.id);
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ id: again.sessionId, state: "ended" });
    expect(ctx.agent.store.messages(project.id, result.threadId)).toEqual([]);

    // A prompt past any platform's command line is not handed over as an argument; its file stays to paste from.
    const long = ticket("Long brief");
    const huge = "x".repeat(2 * 1024 * 1024);
    const refused = await codeLink.start(project.id, long.id, { mode: "terminal", message: huge });
    expect(refused).toMatchObject({ ok: false, gate: "prompt", message: expect.stringContaining("too long for this computer's command line") });
    const saved = /saved in (\S+prompt\.md)/.exec(refused.ok ? "" : refused.message)?.[1];
    expect(fs.readFileSync(saved!, "utf8")).toContain(huge);
    // A template that reads the file takes it.
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none", claudeCommand: '"{bin}" --query-file "{prompt}"' } });
    expect(await codeLink.start(project.id, long.id, { mode: "terminal", message: huge })).toMatchObject({ ok: true, command: expect.stringMatching(/--query-file ".*prompt\.md"$/) });
  });

  it("starts Gemini CLI and OpenCode only in a terminal, each with its own session-only MCP config", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    for (const [id, title] of [["gemini", "Gemini CLI"], ["opencode", "OpenCode"]] as const) {
      await ctx.plugin({ name: `fake-${id}`, inject: ["agent"], apply: (c: Context) => void c.agent.engine({ ...fakeCodeEngine([]), id, title, author: `ai:${id}`, terminalOnly: true }) });
    }
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();

    // The person's own Gemini home, which the session's is made from.
    const ownHome = fs.mkdtempSync(path.join(root, "gemini-own-"));
    fs.mkdirSync(path.join(ownHome, ".gemini"));
    fs.writeFileSync(path.join(ownHome, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }));
    const savedHome = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = ownHome;
    const item = ticket("Gemini terminal work");
    expect(await codeLink.start(project.id, item.id, { mode: "run", engine: "gemini" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringMatching(/only in a terminal/) });
    const gemini = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "gemini", options: { model: "pro" } });
    if (savedHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = savedHome;
    expect(gemini.ok).toBe(true);
    if (!gemini.ok) return;
    expect(gemini.command).toMatch(/^GEMINI_CLI_HOME=".*gemini-home" "gemini" -m pro -i "\$\(cat ".*prompt\.md"\)"$/);
    const geminiSettings = JSON.parse(fs.readFileSync(path.join(codeLink.sessionDir(gemini.sessionId), "gemini-home", ".gemini", "settings.json"), "utf8"));
    const token = codeLink.sessions.token(gemini.sessionId)!;
    // The session's own server, and hooks that report the session to it.
    expect(geminiSettings).toEqual({ security: { auth: { selectedType: "gemini-api-key" } }, mcpServers: { tomrade: { httpUrl: ctx.mcp.urlFor(project.id), headers: { "X-Tomrade-Run": token } } }, hooks: geminiHooks(ctx.mcp.eventUrlFor(token)!) });
    // a terminal-only engine takes no turn inside Tomrade
    expect(() => ctx.agent.send(project.id, gemini.threadId, { kind: "text", text: "go on" })).toThrow(/only in a terminal/);

    const other = ticket("OpenCode terminal work");
    const opencode = await codeLink.start(project.id, other.id, { mode: "terminal", engine: "opencode", options: { model: "anthropic/claude-sonnet-5" } });
    expect(opencode.ok).toBe(true);
    if (!opencode.ok) return;
    expect(opencode.command).toMatch(/^OPENCODE_CONFIG=".*opencode\.json" "opencode" --model anthropic\/claude-sonnet-5 --prompt "\$\(cat ".*prompt\.md"\)"$/);
    const config = JSON.parse(fs.readFileSync(path.join(codeLink.sessionDir(opencode.sessionId), "opencode.json"), "utf8"));
    expect(config.mcp.tomrade).toEqual({ type: "remote", url: ctx.mcp.urlFor(project.id), enabled: true, headers: { "X-Tomrade-Run": codeLink.sessions.token(opencode.sessionId) } });
  });

  it("opens a terminal pi session whose extension carries the MCP server and reports like Claude's hooks", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    await ctx.plugin({ name: "fake-pi", inject: ["agent"], apply: (c: Context) => void c.agent.engine({ ...fakeCodeEngine([]), id: "pi", title: "Pi", author: "ai:pi" }) });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("Pi terminal work");
    const result = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "pi", options: { effort: "high" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toMatch(/^"pi" --thinking high -e ".*pi-extension\.ts" "\$\(cat ".*prompt\.md"\)"$/);
    // A token-bound session is told to claim too, after the line that names the ticket.
    const prompt = fs.readFileSync(path.join(codeLink.sessionDir(result.sessionId), "prompt.md"), "utf8");
    expect(prompt.split("\n")[0]).toContain(item.key);
    expect(prompt).toContain(`Before anything else, call the tomrade MCP tool claim_ticket with key "${item.key}"`);

    // Load the extension the way pi does, against a stand-in for pi's API; its reports reach the real event endpoint.
    const source = fs.readFileSync(path.join(codeLink.sessionDir(result.sessionId), "pi-extension.ts"), "utf8");
    const servers: Record<string, { url: string; headers: Record<string, string>; exposure: string }> = {};
    const on: Record<string, (event: unknown, ctx?: unknown) => Promise<unknown> | unknown> = {};
    (await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`)).default({
      registerMcpServer: (name: string, config: (typeof servers)[string]) => { servers[name] = config; },
      on: (event: string, handler: (typeof on)[string]) => { on[event] = handler; }
    });
    expect(servers.tomrade).toMatchObject({ url: ctx.mcp.urlFor(project.id), exposure: "direct" });
    expect(servers.tomrade.headers["X-Tomrade-Run"]).toBe(codeLink.sessions.token(result.sessionId));
    const session = () => codeLink.sessionsOf(project.id, item.id)[0];
    await on.session_start!({ type: "session_start", reason: "startup" }, { sessionManager: { getSessionId: () => "pi-abc" } });
    expect(session()).toMatchObject({ state: "running", externalId: "pi-abc", mode: "terminal" });
    // The sidebar's title follows what was asked, then what pi calls the conversation.
    await on.agent_start!({ prompt: "先跑测试" });
    await vi.waitFor(() => expect(session().title).toBe("先跑测试"));
    await on.session_start!({ type: "session_start", reason: "resume" }, { sessionManager: { getSessionId: () => "pi-abc", getSessionName: () => "Pi 的标题" } });
    await vi.waitFor(() => expect(session().title).toBe("Pi 的标题"));
    expect(await on.tool_call!({ toolName: "bash", input: { command: "flutter create ." } })).toBeUndefined();
    expect(session()).toMatchObject({ state: "running", activity: "Bash · flutter create ." });
    await on.tool_result!({ toolName: "bash", input: { command: "flutter create ." }, content: [{ type: "text", text: "ok" }], isError: false });
    expect(session().activity).toBeNull();
    on.agent_end!({ messages: [{ role: "assistant", content: [{ type: "text", text: "Scaffold in place.\n\nNext: CI." }], stopReason: "stop" }] });
    await vi.waitFor(() => expect(session()).toMatchObject({ state: "waiting", summary: "Scaffold in place." }), { timeout: 10_000 });
    await on.session_shutdown!({ type: "session_shutdown", reason: "quit" });
    expect(session().state).toBe("ended");

    // Continuing resumes the pi session it heard about.
    const again = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "pi" });
    expect(again.ok ? again.command : "").toContain("--session-id pi-abc");
  });

  it("starts WorkBuddy in a terminal with Claude's flags, and refuses an agent that runs only inside Tomrade", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    await ctx.plugin({ name: "fake-acp", inject: ["agent"], apply: (c: Context) => {
      c.agent.engine({ ...fakeCodeEngine([]), id: "workbuddy", title: "WorkBuddy", author: "ai:workbuddy" });
      c.agent.engine({ ...fakeCodeEngine([]), id: "inside", title: "Inside", author: "ai:inside", terminal: false });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("WorkBuddy terminal work");
    const result = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "workbuddy", options: { model: "hy3" } });
    expect(result.ok ? result.command : result).toMatch(/^"codebuddy" --model hy3 --mcp-config ".*mcp\.json" --settings ".*settings\.json" "\$\(cat ".*prompt\.md"\)"$/);

    const other = ticket("Inside terminal work");
    expect(await codeLink.start(project.id, other.id, { mode: "terminal", engine: "inside" }))
      .toEqual({ ok: false, gate: "engine", engine: "inside", message: "Inside runs only inside Tomrade — choose Run here, or set up another CLI agent under Settings → Code link" });
    const general = world.items.create({ projectId: project.id, boardId: world.board.id, title: "Inside general work", workType: "general", status: "todo", by: "human" });
    expect(await codeLink.start(project.id, general.id, { mode: "terminal", engine: "inside" })).toMatchObject({ ok: false, gate: "engine" });
  });

  it("runs DeepSeek Harness in a terminal as one headless run, with a session-only server, shown and reported, then resumed", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    // Found inside the desktop app, not on PATH.
    const bin = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
    await ctx.plugin({ name: "fake-dsh", inject: ["agent"], apply: (c: Context) => {
      c.agent.engine({ ...fakeCodeEngine([]), id: "dsh", title: "DeepSeek Harness", author: "ai:dsh", terminal: true,
        available: async () => ({ ok: true, cli: { name: "dsh", state: "ready", path: bin, attempts: [], searched: [], platform: "darwin", arch: "arm64", pathEnv: "" } }) });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("DeepSeek Harness terminal work");
    const started = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "dsh" });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const dir = codeLink.sessionDir(started.sessionId);
    expect(started.command).toBe(`"${bin}" --profile headless --patch "${path.join(dir, "dsh-patch.yml")}" --json - < "${path.join(dir, "prompt.md")}" | TOMRADE_PROMPT_FILE="${path.join(dir, "prompt.md")}" ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${path.join(dir, "dsh-report.mjs")}"`);
    // The folder it was found in goes on the terminal's PATH ahead of the person's own, for what it starts.
    expect(fs.readFileSync(path.join(dir, "run.command"), "utf8")).toContain(`export PATH='${path.dirname(bin)}':"$PATH"`);
    const patch = fs.readFileSync(path.join(dir, "dsh-patch.yml"), "utf8");
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toContain(`url: "${ctx.mcp.urlFor(project.id)}"`);
    expect(patch).toContain(`X-Tomrade-Run: "${codeLink.sessions.token(started.sessionId)}"`);

    // The run's --json events, as DeepSeek Harness 0.2.0-rc.2 writes them, through the generated script.
    const events = [
      { type: "session", sessionId: "session-abc", cwd: checkout },
      { type: "status", phase: "turn_start", turn: 1 },
      { type: "tool_call", callId: "c1", tool: "bash", input: { command: "echo hi" } },
      { type: "tool_result", callId: "c1", status: "completed", result: "hi\n" },
      { type: "text", text: "Done." },
      { type: "final", text: "Done." }
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    const { execFile } = await import("node:child_process");
    const shown = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [path.join(dir, "dsh-report.mjs")], (err, stdout) => (err ? reject(err) : resolve(stdout)));
      child.stdin!.end(events);
    });
    expect(shown).toContain("DeepSeek Harness session session-abc");
    expect(shown).toContain("> bash echo hi");
    expect(shown).toContain("Done.");
    const [session] = codeLink.sessionsOf(project.id, item.id);
    expect(session).toMatchObject({ agent: "dsh", externalId: "session-abc", state: "ended" });

    // Continue resumes that session.
    const again = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "dsh" });
    expect(again.ok ? again.command : again).toContain("--json --session-id session-abc -");
  });

  it("starts Antigravity CLI in a terminal once it is connected, tells it to claim first, and its claim joins the session Start made", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    let state: "connected" | "missing" = "missing";
    const view = () => ({ state, url: null, configuredUrl: null, file: null, manual: { connect: "", disconnect: "" } });
    await ctx.plugin({ name: "fake-agy", inject: ["agent"], apply: (c: Context) => {
      c.agent.engine({ ...fakeCodeEngine([]), id: "agy", title: "Antigravity CLI", author: "ai:agy", capabilities: ["code", "general"], terminalOnly: true, terminalViaLink: true, terminalClaims: true,
        mcpLink: { status: async () => view(), connect: async () => view(), disconnect: async () => view() } });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("Antigravity terminal work");
    expect(await codeLink.start(project.id, item.id, { mode: "terminal", engine: "agy" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringContaining("Connect it under Antigravity CLI in Settings") });

    state = "connected";
    const started = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "agy", options: { model: "gemini-3.6-flash" } });
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(started.command).toMatch(/^"agy" --model gemini-3\.6-flash -i "\$\(cat ".*prompt\.md"\)"$/);
    const prompt = fs.readFileSync(path.join(codeLink.sessionDir(started.sessionId), "prompt.md"), "utf8");
    expect(prompt.split("\n")[0]).toContain(item.key);
    expect(prompt).toContain(`Before anything else, call the tomrade MCP tool claim_ticket with key "${item.key}"`);

    // Its calls carry no token; the claim over its connection is its first act, and it lands on Start's session.
    const claimed = await ctx.tools.execute("claim_ticket", { key: item.key }, { by: "ai:mcp", projectId: project.id, connection: "agy-conn" }) as { tracking: { tracked: boolean; sessionId: string } };
    expect(claimed.tracking).toMatchObject({ tracked: true, sessionId: started.sessionId });
    expect(codeLink.sessionsOf(project.id, item.id).map((s) => s.id)).toEqual([started.sessionId]);
  });

  it("makes a terminal agent's own MCP link itself, so Start never sends the person to Settings first", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    let state: "connected" | "missing" = "missing";
    let connects = 0;
    const view = () => ({ state, url: null, configuredUrl: null, file: null, manual: { connect: "", disconnect: "" } });
    await ctx.plugin({ name: "fake-agy-auto", inject: ["agent"], apply: (c: Context) => {
      c.agent.engine({ ...fakeCodeEngine([]), id: "agy", title: "Antigravity CLI", author: "ai:agy", capabilities: ["code", "general"], terminalOnly: true, terminalViaLink: true, terminalClaims: true,
        mcpLink: { status: async () => view(), connect: async () => { connects++; state = "connected"; return view(); }, disconnect: async () => view() } });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    // Its link is written as soon as Tomrade's server and the engine are both up — nobody pressed Connect.
    await vi.waitFor(() => expect(connects).toBe(1));
    const started = await codeLink.start(project.id, ticket("Antigravity auto link").id, { mode: "terminal", engine: "agy" });
    expect(started.ok).toBe(true);
  });

  it("passes over an engine that can only chat when none is named, and says why when it is named", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    // Tomrade with no model: available, but only to chat; it comes before every CLI.
    const chatOnly: Engine = { ...fakeCodeEngine([]), id: "chat-only", title: "Tomrade", available: async () => ({ ok: true, capabilities: ["backlog"] }) };
    await ctx.plugin({ name: "chat-only", inject: ["agent"], apply: (c: Context) => void c.agent.engine(chatOnly) });
    await settle();
    const engines = vi.spyOn(agent, "codeEngines").mockImplementation(() => [chatOnly, ...agent.allEngines().filter((e) => e.id === "fake-code")]);
    try {
      const started = await codeLink.start(project.id, ticket("Run on whoever can").id, { mode: "run" });
      if (!started.ok) throw new Error(JSON.stringify(started));
      expect(agent.store.thread(project.id, started.threadId)?.engine).toBe("fake-code");
      await untilRunsSettle(agent);

      expect(await codeLink.start(project.id, ticket("Run on Tomrade").id, { mode: "run", engine: "chat-only" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringContaining("Tomrade: can only chat for now — connect a model") });
    } finally {
      engines.mockRestore();
    }
  });

  it("starts Cursor in a terminal once its own config names Tomrade, and tells it to claim first", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    let state: "connected" | "missing" = "missing";
    const view = () => ({ state, url: null, configuredUrl: null, file: null, manual: { connect: "", disconnect: "" } });
    await ctx.plugin({ name: "fake-cursor", inject: ["agent"], apply: (c: Context) => {
      c.agent.engine({ ...fakeCodeEngine([]), id: "cursor", title: "Cursor", author: "ai:cursor", capabilities: ["code", "general"], terminalOnly: true, terminalViaLink: true, terminalClaims: true,
        mcpLink: { status: async () => view(), connect: async () => view(), disconnect: async () => view() } });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("Cursor terminal work");
    expect(await codeLink.start(project.id, item.id, { mode: "terminal", engine: "cursor" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringContaining("Connect it under Cursor in Settings") });

    state = "connected";
    const started = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "cursor", options: { model: "gpt-5" } });
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(started.command).toMatch(/^"cursor-agent" --model gpt-5 "\$\(cat ".*prompt\.md"\)"$/);
    const prompt = fs.readFileSync(path.join(codeLink.sessionDir(started.sessionId), "prompt.md"), "utf8");
    expect(prompt.split("\n")[0]).toContain(item.key);
    expect(prompt).toContain(`Before anything else, call the tomrade MCP tool claim_ticket with key "${item.key}"`);
  });

  it("starts Hermes in a terminal once its own sessions reach Tomrade, and asks for that first", async () => {
    const world = await machine(codeRepo());
    const { codeLink, ctx, project, repo, checkout, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    let state: "connected" | "missing" = "missing";
    const view = () => ({ state, url: null, configuredUrl: null, file: null, manual: { connect: "", disconnect: "" } });
    await ctx.plugin({ name: "fake-hermes", inject: ["agent"], apply: (c: Context) => {
      c.agent.engine({ ...fakeCodeEngine([]), id: "hermes", title: "Hermes", author: "ai:hermes", terminal: true, terminalViaLink: true,
        mcpLink: { status: async () => view(), connect: async () => view(), disconnect: async () => view() } });
    } });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    const item = ticket("Hermes terminal work");
    expect(await codeLink.start(project.id, item.id, { mode: "terminal", engine: "hermes" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringContaining("Connect it under Hermes in Settings") });
    const general = world.items.create({ projectId: project.id, boardId: world.board.id, title: "Hermes general work", workType: "general", status: "todo", by: "human" });
    expect(await codeLink.start(project.id, general.id, { mode: "terminal", engine: "hermes" })).toMatchObject({ ok: false, gate: "engine", message: expect.stringContaining("Connect it under Hermes in Settings") });

    state = "connected";
    const started = await codeLink.start(project.id, item.id, { mode: "terminal", engine: "hermes", options: { model: "openrouter:some/model" } });
    expect(started.ok ? started.command : started).toMatch(/^"hermes" chat -m openrouter:some\/model --query-file ".*prompt\.md"$/);
  });

  it("keeps where a headless start was asked for on its brief", async () => {
    const world = await machine(codeRepo());
    const { codeLink, project, agent } = world;
    await world.ctx.repos.setCheckout(world.repo!.remote, world.checkout!);
    const item = world.ticket("Start it from chat");
    const source = { connection: "bot", tenant: "team", conversation: "chat", actor: "owner" };
    const result = await codeLink.start(project.id, item.id, { mode: "run", source });
    expect(result.ok && result.runId).toBeTruthy();
    if (!result.ok) return;
    await untilRunsSettle(agent);
    const row = world.ctx.db.for(project.id).prepare("SELECT source_json FROM plugin_agent_inputs WHERE run_id = ?").get(result.runId) as { source_json: string } | undefined;
    expect(JSON.parse(row!.source_json)).toEqual(source);
  });

  it("carries the knobs picked at Start onto the ticket's thread, where the turn and the panel read them", async () => {
    const world = await machine(codeRepo());
    const { codeLink, project, agent } = world;
    await world.ctx.repos.setCheckout(world.repo!.remote, world.checkout!);
    const item = world.ticket("Pick a model");
    const result = await codeLink.start(project.id, item.id, { mode: "run", options: { model: "opus", effort: "high" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runId).toBeTruthy();
    await untilRunsSettle(agent);
    expect(agent.store.thread(project.id, result.threadId)?.options).toEqual({ model: "opus", effort: "high" });
    expect(world.turns.at(-1)?.options).toEqual({ model: "opus", effort: "high" });
    // Continue without knobs keeps them; an explicit empty set clears them and the engine's settings apply again.
    const again = await codeLink.start(project.id, item.id, { mode: "run" });
    await untilRunsSettle(agent);
    expect(again.ok && again.continued).toBe(true);
    expect(world.turns.at(-1)?.options).toEqual({ model: "opus", effort: "high" });
    await codeLink.start(project.id, item.id, { mode: "run", options: {} });
    await untilRunsSettle(agent);
    expect(agent.store.thread(project.id, result.threadId)?.options).toBeNull();
    // The turn sees no overrides as an empty object, which is what an engine's options schema takes.
    expect(world.turns.at(-1)?.options).toEqual({});
  });
});

describe("remembering the start configuration", () => {
  it("remembers what a start ran with and hands it back after a restart", async () => {
    const where = path.join(root, `code-link-defaults-${n++}.json`);
    const world = await machine(codeRepo(), { defaultsPath: where });
    const { codeLink, ctx, project, repo, checkout, agent, ticket } = world;
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    expect(codeLink.startDefaults()).toBeNull();
    let told = 0;
    ctx.on("codeLink/start-defaults", () => void told++);

    const first = ticket("Pick a model");
    expect(await codeLink.start(project.id, first.id, { mode: "run", options: { model: "opus", effort: "high" } })).toMatchObject({ ok: true });
    await untilRunsSettle(agent);
    expect(codeLink.startDefaults()).toEqual({ mode: "run", engine: "fake-code", options: { model: "opus", effort: "high" } });
    // so that every open one-click Start names it at once
    expect(told).toBe(1);

    // A General ticket carries its method along with the surface and the agent.
    const general = world.items.create({ projectId: project.id, boardId: world.board.id, title: "Prepare the workshop", workType: "general", status: "todo", by: "human" });
    expect(await codeLink.start(project.id, general.id, { mode: "run", playbook: "task.assist" })).toMatchObject({ ok: true });
    await untilRunsSettle(agent);
    expect(codeLink.startDefaults()).toEqual({ mode: "run", engine: "fake-code", playbook: "task.assist" });

    // Starting again on a machine that just booted reads the file: the memory is not in-process state.
    const restarted = await machine(codeRepo(), { defaultsPath: where });
    expect(restarted.codeLink.startDefaults()).toEqual({ mode: "run", engine: "fake-code", playbook: "task.assist" });

    // A gate the user had to clear is not a configuration that ran, so it is not remembered.
    const fresh = await machine(null, { defaultsPath: where });
    const gated = fresh.ticket("No repository yet");
    expect(await fresh.codeLink.start(fresh.project.id, gated.id, { mode: "terminal", engine: "other" })).toMatchObject({ ok: false, gate: "workstream" });
    expect(fresh.codeLink.startDefaults()).toEqual({ mode: "run", engine: "fake-code", playbook: "task.assist" });
  });

  it("hands back only what still fits: an agent or a knob the person has since removed is dropped", async () => {
    const where = path.join(root, `code-link-defaults-${n++}.json`);
    // Written by a version that had an engine and an option this machine does not have now.
    fs.writeFileSync(where, JSON.stringify({ mode: "terminal", engine: "vanished-agent", options: { model: "gone", effort: "high" }, permissionMode: "acceptEdits", updatedAt: Date.now() }));
    const world = await machine(codeRepo(), { defaultsPath: where });
    const { codeLink } = world;
    // The memory still loads, so the dialog can keep what it recognises and its own default covers the rest.
    expect(codeLink.startDefaults()).toEqual({ mode: "terminal", engine: "vanished-agent", options: { model: "gone", effort: "high" }, permissionMode: "acceptEdits" });
    // Nothing usable at all reads as no memory, and a start still runs rather than failing on it.
    fs.writeFileSync(where, JSON.stringify({ mode: "run", updatedAt: Date.now() }));
    expect(codeLink.startDefaults()).toBeNull();
    const item = world.ticket("Still starts");
    await world.ctx.repos.setCheckout(world.repo!.remote, world.checkout!);
    expect(await codeLink.start(world.project.id, item.id, { mode: "run" })).toMatchObject({ ok: true });
    await untilRunsSettle(world.agent);
  });
});

describe("starting a General ticket", () => {
  it("runs it here without a repository, then in a terminal over MCP, following it as a session either way", async () => {
    const world = await machine(null);
    const { ctx, codeLink, project, board, agent } = world;
    const item = world.items.create({ projectId: project.id, boardId: board.id, title: "Prepare the workshop", body: "A checklist", workType: "general", status: "todo", by: "human" });

    const run = await codeLink.start(project.id, item.id, { mode: "run", playbook: "task.assist", options: { model: "opus" } });
    expect(run).toMatchObject({ ok: true, continued: false, mode: "run", branch: "", worktree: null, launched: true });
    if (!run.ok) return;
    expect(run.runId).toBeTruthy();
    await untilRunsSettle(agent);
    expect(world.turns.at(-1)).toMatchObject({ purpose: "general", options: { model: "opus" }, execution: { playbook: { id: "task.assist" } } });
    expect(world.turns.at(-1)?.cwd).toBe(run.cwd);
    expect(ctx.items.get(project.id, item.id)).toMatchObject({ status: "doing", playbookId: "task.assist" });
    expect(codeLink.sessionsOf(project.id, item.id)).toMatchObject([{ id: run.sessionId, mode: "headless", repoId: "", branch: "", threadId: run.threadId, agent: "fake-code", state: "idle" }]);
    expect((await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")?.rows.find((r) => r.label === "Session")).toMatchObject({ value: expect.stringContaining("run by Tomrade") });

    // The terminal path binds the same thread and delivery; the CLI gets the whole brief in its prompt file.
    ctx.settings.set({ ...ctx.settings.get(), codeLink: { terminal: "none" } });
    expect(await codeLink.start(project.id, item.id, { mode: "terminal" })).toMatchObject({ ok: false, gate: "mcp" });
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    await settle();
    // A method whose capability no plugin provides is refused before anything is created.
    await expect(codeLink.start(project.id, item.id, { mode: "terminal", playbook: "document.write" })).rejects.toThrow("files.write");
    const dispose = agent.capability("files.write");
    const opened = await codeLink.start(project.id, item.id, { mode: "terminal", playbook: "document.write" });
    expect(opened).toMatchObject({ ok: true, continued: true, mode: "terminal", threadId: run.threadId, launched: false });
    if (!opened.ok) return;
    // The headless run taught the thread the CLI's session id; the terminal continues it.
    expect(opened.command).toMatch(/^"claude" --mcp-config ".*mcp\.json" --settings ".*settings\.json" --resume fake-session-1 "\$\(cat ".*prompt\.md"\)"$/);
    const prompt = fs.readFileSync(path.join(codeLink.sessionDir(opened.sessionId), "prompt.md"), "utf8");
    expect(prompt).toContain(`Continue ${item.key}: Prepare the workshop`);
    expect(prompt).toContain("You are delivering");
    expect(prompt).toContain("Selected playbook document.write");
    expect(prompt).toContain(`Working directory: ${opened.cwd}`);
    // A General ticket started in Code Link answers in the language the person reads Tomrade in.
    expect(prompt).toContain("the person reads Tomrade in English");
    expect(agent.store.thread(project.id, run.threadId)).toMatchObject({ surface: "code", execution: { playbook: { id: "document.write" } } });
    expect(ctx.items.get(project.id, item.id)?.playbookId).toBe("document.write");
    const sessions = codeLink.sessionsOf(project.id, item.id);
    expect(sessions.find((s) => s.id === opened.sessionId)).toMatchObject({ mode: "terminal", state: "running", threadId: run.threadId });
    dispose();
  });
});

it("lets the assistant offer Start as a card instead of doing the work itself", async () => {
  const { ctx, project, agent, ticket } = await machine(null);
  const item = ticket("Fix the login form");
  const results: unknown[] = [];
  ctx.agent.engine({
    id: "offering",
    title: "Offering",
    author: "ai:test",
    available: async () => ({ ok: true }),
    async turn(_input, io) {
      if (_input.input.kind === "text" && _input.input.text === "merge it") {
        await io.tools.execute("offer_start", { key: item.key, task: "  PR #9 conflicts with main: merge origin/main, resolve, test, push, merge  " });
        return { stop: "end" };
      }
      for (const key of [item.key, "TOM-999"]) results.push(await io.tools.execute("offer_start", { key }).catch((err: Error) => err.message));
      return { stop: "end" };
    }
  });
  try {
    // Every engine in a conversation reaches it over its run-bound session; an outside client does not.
    expect(ctx.tools.served("run").map((t) => t.name)).toContain("offer_start");
    expect(ctx.tools.served().map((t) => t.name)).not.toContain("offer_start");
    const thread = agent.newThread(project.id, "offering");
    const run = agent.send(project.id, thread.id, { kind: "text", text: "fix the login form" });
    await expect.poll(() => agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(results).toEqual([expect.objectContaining({ offered: item.key }), expect.stringContaining("no ticket TOM-999")]);
    const cards = agent.thread(project.id, thread.id).messages.flatMap((m) => (m.block.type === "card" ? [m.block] : []));
    expect(cards).toEqual([expect.objectContaining({ schema: "start", data: { itemId: item.id, key: item.key, title: "Fix the login form" } })]);
    expect(ctx.items.get(project.id, item.id)?.status).toBe("todo");
    // Offered again later in the same conversation, the card comes again, where the person is reading now.
    const again = agent.send(project.id, thread.id, { kind: "text", text: "give me the start button" });
    await expect.poll(() => agent.store.run(project.id, again.runId)?.status).toBe("done");
    const after = agent.thread(project.id, thread.id).messages.filter((m) => m.block.type === "card");
    expect(after).toHaveLength(2);
    expect(after.at(-1)).toMatchObject({ runId: again.runId, block: { schema: "start", data: { itemId: item.id } } });
    // A merge refused for a conflict is offered with what to do first; the card carries it for the Start to hand on.
    const merge = agent.send(project.id, thread.id, { kind: "text", text: "merge it" });
    await expect.poll(() => agent.store.run(project.id, merge.runId)?.status).toBe("done");
    const offered = agent.thread(project.id, thread.id).messages.filter((m) => m.block.type === "card").at(-1);
    expect(offered).toMatchObject({ runId: merge.runId, block: { data: { itemId: item.id, task: "PR #9 conflicts with main: merge origin/main, resolve, test, push, merge" } } });
  } finally {
    await ctx.fiber.dispose();
  }
});

describe("starting tickets from a conversation", () => {
  /** A conversation engine that can code: asked in chat, it starts tickets; on a ticket, it commits like the fake coding agent. */
  function chatty(id: string, say: (text: string, io: Parameters<Engine["turn"]>[1]) => Promise<unknown>, outcomes: unknown[]): Engine {
    return {
      id,
      title: id,
      author: `ai:${id}`,
      capabilities: ["backlog", "code", "general"],
      available: async () => ({ ok: true }),
      async turn(input, io) {
        if (input.cwd && input.purpose === "code") {
          // Sent back for a conflict, it brings the branch up to date and hands over again, as the brief says.
          if (input.input.kind === "text" && /no longer merges/.test(input.input.text)) {
            git(["merge", "-q", "-X", "ours", "main"], input.cwd);
            await io.tools.execute("link_code", { scopeChecked: true });
            return { stop: "end" };
          }
          fs.writeFileSync(path.join(input.cwd, `${input.ticket?.key ?? "TOM-0"}.ts`), "export {};\n");
          git(["add", "-A"], input.cwd);
          git(["commit", "-q", "-m", `${input.ticket?.key ?? "TOM-0"}: work`], input.cwd);
        } else if (input.input.kind === "text") outcomes.push(await say(input.input.text, io).catch((err: Error) => err.message));
        return { stop: "end" };
      }
    };
  }

  it("starts every ticket named with the conversation's own engine, offers each delivery's merge there under the ask policy, and merges on the person's word", { timeout: 30_000 }, async () => {
    const folder = localRepo();
    const world = await machine(null);
    const { codeLink, ctx, agent, project, board, ticket } = world;
    const { repo } = await ctx.repos.addFromFolder(project.id, folder);
    world.boards.update(project.id, board.id, { repoId: repo.id });
    codeLink.setRepoPolicy(project.id, repo.id, { mergePolicy: "ask" });
    expect(codeLink.repoStates(project.id).find((s) => s.repoId === repo.id)).toMatchObject({ mergePolicy: "ask", agentMerge: false });
    const a = ticket("First thing");
    const b = ticket("Second thing");
    const c = ticket("Third thing");
    const outcomes: unknown[] = [];
    agent.engine(
      chatty(
        "chatty",
        (text, io) =>
          text.startsWith("merge") ? io.tools.execute("merge_ticket", { key: a.key })
          : text.startsWith("resolve") ? io.tools.execute("resolve_merge", { key: b.key })
          : text.startsWith("auto") ? io.tools.execute("start_ticket", { keys: [c.key], autoMerge: true })
          : io.tools.execute("start_ticket", { keys: [a.key, b.key, "TOM-999"] }),
        outcomes
      )
    );
    expect(ctx.tools.served("run").map((t) => t.name)).toEqual(expect.arrayContaining(["start_ticket", "merge_ticket"]));
    expect(ctx.tools.served().map((t) => t.name)).not.toContain("start_ticket");

    const thread = agent.newThread(project.id, "chatty");
    const run = agent.send(project.id, thread.id, { kind: "text", text: `do ${a.key} and ${b.key}` });
    await expect.poll(() => agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(outcomes[0]).toMatchObject({
      started: [
        { key: a.key, engine: "chatty", continued: false },
        { key: b.key, engine: "chatty", continued: false }
      ],
      problems: ["no ticket TOM-999 in this project"]
    });
    await untilRunsSettle(agent);
    // Each ticket runs in a session of its own that remembers which conversation asked.
    const sessions = codeLink.store.sessions(project.id).filter((s) => s.requestedBy === thread.id);
    expect(sessions.map((s) => s.itemIds[0]).sort()).toEqual([a.id, b.id].sort());
    expect(sessions.map((s) => s.mode)).toEqual(["headless", "headless"]);
    expect(ctx.items.get(project.id, a.id)!.status).toBe("doing");
    expect(ctx.items.get(project.id, b.id)!.status).toBe("doing");
    const started = agent.store.cards(project.id, thread.id).find((c) => c.schema === "start-batch");
    expect(started?.data).toMatchObject({ tickets: [{ key: a.key }, { key: b.key }], results: [{ key: a.key, ok: true, engine: "chatty" }, { key: b.key, ok: true }] });
    expect(agent.store.cards(project.id, thread.id).filter((c) => c.schema === "merge")).toEqual([]);

    // a's session hands its branch over: Verifying, and the conversation that asked gets the merge to decide.
    const sessionA = sessions.find((s) => s.itemIds.includes(a.id))!;
    await sessionContext.run({ projectId: project.id, sessionId: sessionA.id }, () => ctx.tools.execute("link_code", { scopeChecked: true }, { by: "ai:chatty", projectId: project.id }));
    expect(ctx.items.get(project.id, a.id)!.status).toBe("verifying");
    const offered = agent.store.cards(project.id, thread.id).find((c) => c.schema === "merge");
    expect(offered).toMatchObject({ id: `merge-${a.id}-1`, data: { itemId: a.id, key: a.key, state: "offered", prUrl: null, base: "main", branch: sessionA.branch } });
    // The session's own conversation gets the same card, so the merge is found from either side.
    expect(agent.store.cards(project.id, sessionA.threadId!).find((c) => c.schema === "merge")).toMatchObject({ id: `merge-${a.id}-1`, data: { key: a.key, state: "offered" } });
    expect(agent.thread(project.id, thread.id).messages.filter((m) => m.block.type === "card" && m.block.schema === "merge")).toHaveLength(1);
    const before = git(["rev-parse", "main"], folder);

    // "merge it" in the conversation: the tool merges, the card says so, the ticket is done.
    const merge = agent.send(project.id, thread.id, { kind: "text", text: "merge it" });
    await expect.poll(() => agent.store.run(project.id, merge.runId)?.status).toBe("done");
    expect(outcomes[1]).toMatchObject({ key: a.key, merged: true });
    expect(git(["rev-parse", "main"], folder)).not.toBe(before);
    expect(ctx.items.get(project.id, a.id)!.status).toBe("done");
    expect(agent.store.cards(project.id, thread.id).find((c) => c.id === `merge-${a.id}-1`)?.data).toMatchObject({ state: "merged", message: expect.stringContaining("Merged") });
    expect(agent.store.cards(project.id, sessionA.threadId!).find((c) => c.id === `merge-${a.id}-1`)?.data).toMatchObject({ state: "merged" });
    // Still the one card: an update, not a second message.
    expect(agent.thread(project.id, thread.id).messages.filter((m) => m.block.type === "card" && m.block.schema === "merge")).toHaveLength(1);

    // b is handed over too, and merged from the card's button (the IPC path); a conflict is reported on the card, not hidden.
    const sessionB = sessions.find((s) => s.itemIds.includes(b.id))!;
    await sessionContext.run({ projectId: project.id, sessionId: sessionB.id }, () => ctx.tools.execute("link_code", { scopeChecked: true }, { by: "ai:chatty", projectId: project.id }));
    expect(agent.store.cards(project.id, thread.id).find((c) => c.id === `merge-${b.id}-1`)?.data).toMatchObject({ key: b.key, state: "offered" });
    fs.writeFileSync(path.join(folder, `${b.key}.ts`), "export const clash = 1;\n");
    git(["add", "-A"], folder);
    git(["commit", "-q", "-m", "clash on main"], folder);
    expect(await codeLink.merge(project.id, b.id)).toMatchObject({ merged: false, cause: "conflict", message: expect.stringContaining("conflicts with main") });
    expect(agent.store.cards(project.id, thread.id).find((c) => c.id === `merge-${b.id}-1`)?.data).toMatchObject({ state: "refused", cause: "conflict", message: expect.stringContaining("conflicts with main") });
    expect(ctx.items.get(project.id, b.id)!.status).toBe("verifying");

    // "resolve it" in the conversation: the session is sent back, brings the branch up to date, hands over, and the merge is offered again.
    const resolve = agent.send(project.id, thread.id, { kind: "text", text: "resolve it" });
    await expect.poll(() => agent.store.run(project.id, resolve.runId)?.status).toBe("done");
    expect(outcomes.at(-1)).toMatchObject({ key: b.key, started: true, engine: "chatty" });
    await untilRunsSettle(agent);
    expect(ctx.items.get(project.id, b.id)!.status).toBe("verifying");
    const again = agent.store.cards(project.id, thread.id).find((c) => c.id === `merge-${b.id}-1`)?.data;
    expect(again).toMatchObject({ state: "offered" });
    expect(await codeLink.merge(project.id, b.id)).toMatchObject({ merged: true });
    expect(ctx.items.get(project.id, b.id)!.status).toBe("done");
    expect(agent.thread(project.id, thread.id).messages.filter((m) => m.block.type === "card" && m.block.schema === "merge")).toHaveLength(2);

    // Asked up front to merge once done: no question, the card reports the merge.
    const auto = agent.send(project.id, thread.id, { kind: "text", text: `auto ${c.key}` });
    await expect.poll(() => agent.store.run(project.id, auto.runId)?.status).toBe("done");
    expect(outcomes.at(-1)).toMatchObject({ started: [{ key: c.key }] });
    await untilRunsSettle(agent);
    expect(codeLink.sessionsOf(project.id, c.id)[0]).toMatchObject({ autoMerge: true });
    const sessionC = codeLink.sessionsOf(project.id, c.id)[0]!;
    await sessionContext.run({ projectId: project.id, sessionId: sessionC.id }, () => ctx.tools.execute("link_code", { scopeChecked: true }, { by: "ai:chatty", projectId: project.id }));
    await expect.poll(() => ctx.items.get(project.id, c.id)!.status).toBe("done");
    expect(agent.store.cards(project.id, thread.id).find((c2) => c2.id === `merge-${c.id}-1`)?.data).toMatchObject({ state: "merged" });
  });

  it("asks on a card before starting a ticket the assistant just filed, and starts it from that card with the settled configuration", { timeout: 30_000 }, async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const filed = ticket("Sparks follow the pointer");
    const outcomes: unknown[] = [];
    agent.engine(chatty("asker", (_text, io) => io.tools.execute("start_ticket", { keys: [filed.key], confirm: true }), outcomes));
    const thread = agent.newThread(project.id, "asker");
    const run = agent.send(project.id, thread.id, { kind: "text", text: "add sparks that follow the pointer" });
    await expect.poll(() => agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(outcomes[0]).toMatchObject({ started: [], note: expect.stringContaining("asks the user whether to start") });
    expect(codeLink.sessionsOf(project.id, filed.id)).toEqual([]);
    expect(ctx.items.get(project.id, filed.id)!.status).toBe("todo");
    const card = agent.store.cards(project.id, thread.id).find((c) => c.schema === "start-batch")!;
    expect(card.data).toMatchObject({ tickets: [{ key: filed.key }], config: { engine: "asker" } });
    expect(card.data).not.toHaveProperty("reason");
    expect(card.data).not.toHaveProperty("results");
    // The person says yes on the card: it runs with the conversation's own engine.
    const config = (card.data as { config: { engine: string } }).config;
    const results = await codeLink.startTickets(project.id, { itemIds: [filed.id], requestedBy: thread.id, ...config, cardId: card.id });
    expect(results).toEqual([expect.objectContaining({ key: filed.key, ok: true, engine: "asker" })]);
    await untilRunsSettle(agent);
    expect(agent.store.cards(project.id, thread.id).find((c) => c.id === card.id)?.data).toMatchObject({ config: { engine: "asker" }, results: [{ key: filed.key, ok: true, threadId: expect.any(String) }] });
    expect(ctx.items.get(project.id, filed.id)!.status).toBe("doing");
  });

  it("asks the person to pick the agent on a card when the conversation's engine cannot code, starts from that card, and remembers the pick", { timeout: 30_000 }, async () => {
    const { codeLink, ctx, agent, project, repo, checkout, ticket, turns } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const item = ticket("Fix the login form");
    const outcomes: unknown[] = [];
    agent.engine({
      id: "talker",
      title: "Talker",
      author: "ai:talker",
      available: async () => ({ ok: true }),
      async turn(_input, io) {
        outcomes.push(await io.tools.execute("start_ticket", { keys: [item.key], task: "do it carefully" }).catch((err: Error) => err.message));
        return { stop: "end" };
      }
    });
    const thread = agent.newThread(project.id, "talker");
    const run = agent.send(project.id, thread.id, { kind: "text", text: "fix the login form" });
    await expect.poll(() => agent.store.run(project.id, run.runId)?.status).toBe("done");
    expect(outcomes[0]).toMatchObject({ started: [], note: expect.stringContaining("pick the agent") });
    expect(codeLink.sessionsOf(project.id, item.id)).toEqual([]);
    expect(ctx.items.get(project.id, item.id)!.status).toBe("todo");
    const card = agent.store.cards(project.id, thread.id).find((c) => c.schema === "start-batch")!;
    expect(card.data).toMatchObject({ tickets: [{ itemId: item.id, key: item.key }], task: "do it carefully", reason: expect.stringContaining("not a code-capable engine") });
    expect((card.data as { results?: unknown }).results).toBeUndefined();

    // The person picks the fake coding agent on the card.
    const results = await codeLink.startTickets(project.id, { itemIds: [item.id], requestedBy: thread.id, engine: "fake-code", task: "do it carefully", cardId: card.id });
    expect(results).toEqual([expect.objectContaining({ itemId: item.id, key: item.key, ok: true, engine: "fake-code", continued: false })]);
    await untilRunsSettle(agent);
    expect(agent.store.cards(project.id, thread.id).find((c) => c.id === card.id)?.data).toMatchObject({ tickets: [{ key: item.key }], task: "do it carefully", results: [{ key: item.key, ok: true, engine: "fake-code" }] });
    expect(codeLink.sessionsOf(project.id, item.id)).toEqual([expect.objectContaining({ mode: "headless", agent: "fake-code", requestedBy: thread.id })]);
    const brief = turns.find((t) => t.purpose === "code")!;
    expect(brief.input.kind === "text" && brief.input.text).toContain("do it carefully");

    // Remembered: the next conversation that cannot code starts with it straight away, no card to pick on.
    expect(codeLink.startDefaults()).toMatchObject({ mode: "run", engine: "fake-code" });
    const other = ticket("Another thing");
    agent.engine({
      id: "talker-2",
      title: "Talker 2",
      author: "ai:talker-2",
      available: async () => ({ ok: true }),
      async turn(_input, io) {
        outcomes.push(await io.tools.execute("start_ticket", { keys: [other.key] }).catch((err: Error) => err.message));
        return { stop: "end" };
      }
    });
    const second = agent.newThread(project.id, "talker-2");
    const again = agent.send(project.id, second.id, { kind: "text", text: "do the other thing" });
    await expect.poll(() => agent.store.run(project.id, again.runId)?.status).toBe("done");
    expect(outcomes[1]).toMatchObject({ started: [{ key: other.key, engine: "fake-code" }] });
    await untilRunsSettle(agent);
    expect(codeLink.sessionsOf(project.id, other.id)).toEqual([expect.objectContaining({ agent: "fake-code", requestedBy: second.id })]);
  });

  it("hands a ticket's conversation to a terminal cell, keeps a second process off its session, and takes it back once the CLI exited", { timeout: 60_000 }, async () => {
    const { codeLink, ctx, project, repo, checkout, ticket, turns, agent } = await machine(codeRepo());
    await ctx.repos.setCheckout(repo!.remote, checkout!);
    const { Mcp } = await import("@tomradex/mcp");
    await ctx.plugin(Mcp, { port: 0 });
    const fake = new FakeHerdr();
    await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket });
    await settle();
    const item = ticket("Hand off to a cell");
    const started = await codeLink.start(project.id, item.id, { mode: "run" });
    expect(started).toMatchObject({ ok: true, mode: "run" });
    const threadId = started.ok ? started.threadId! : "";
    await until(() => agent.store.run(project.id, started.ok ? started.runId! : "")?.status === "done");
    expect(codeLink.handoffOf(project.id, threadId)).toEqual({ where: "here", toTerminal: { ok: true }, terminal: null });

    // a Start that is refused (the checkout went away) leaves it here, and the ticket still tracked on a headless session
    fs.renameSync(checkout!, `${checkout}-away`);
    expect(await codeLink.toTerminal(project.id, threadId)).toMatchObject({ ok: false });
    fs.renameSync(`${checkout}-away`, checkout!);
    expect(codeLink.sessionsOf(project.id, item.id).filter((s) => s.mode === "headless" && s.state !== "ended")).toEqual([expect.objectContaining({ threadId, state: "idle" })]);
    expect(agent.store.thread(project.id, threadId)).toMatchObject({ surface: "assistant" });

    // A running ticket transfers with one click too, keeping its worktree and branch.
    const running = agent.send(project.id, threadId, { kind: "text", text: "hold for transfer" });
    await until(() => { const input = turns.at(-1)?.input; return input?.kind === "text" && input.text === "hold for transfer"; });
    // to the terminal: Start's continue, in the thread's worktree, resuming the session the headless run left; the headless session ends quietly
    const moved = await codeLink.toTerminal(project.id, threadId);
    expect(moved).toMatchObject({ ok: true, launched: true, pane: "w1:p1" });
    expect(agent.store.run(project.id, running.runId)?.status).toBe("cancelled");
    const sessions = codeLink.sessionsOf(project.id, item.id);
    expect(sessions.find((s) => s.mode === "headless")).toMatchObject({ state: "ended" });
    const terminal = sessions.find((s) => s.mode === "terminal")!;
    expect(terminal).toMatchObject({ state: "running", threadId, externalId: "fake-session-1", herdrPane: "w1:p1", itemIds: [item.id] });
    expect(fake.of("workspace.create")).toEqual([{ cwd: started.ok ? started.cwd : "", label: project.name, focus: false }]);
    expect(fs.readFileSync(path.join(codeLink.sessionDir(terminal.id), "run.command"), "utf8")).toContain("--resume fake-session-1");
    expect(agent.store.thread(project.id, threadId)).toMatchObject({ surface: "code" });
    expect(codeLink.handoffOf(project.id, threadId)).toMatchObject({ where: "terminal", terminal: { sessionId: terminal.id, live: true, pane: "w1:p1" } });
    // one process on the session: neither the panel nor a Start runs the thread here meanwhile
    expect(() => agent.send(project.id, threadId, { kind: "text", text: "more" })).toThrow("This conversation goes on with Fake coding agent in a terminal (pane w1:p1); bring it back to the conversation first.");
    expect(await codeLink.start(project.id, item.id, { mode: "run" })).toMatchObject({ ok: false, gate: "pane", pane: "w1:p1" });
    expect(agent.store.thread(project.id, threadId)).toMatchObject({ surface: "code" });
    expect(await codeLink.backToPanel(project.id, threadId)).toMatchObject({ ok: false });

    // the CLI exited: the conversation comes back, and the ticket's tracking goes on in a headless session again
    codeLink.sessions.event(project.id, terminal.id, { hook_event_name: "SessionStart", session_id: "fake-session-1", cwd: started.ok ? started.cwd : "" });
    codeLink.sessions.event(project.id, terminal.id, { hook_event_name: "SessionEnd" });
    expect(await codeLink.backToPanel(project.id, threadId)).toMatchObject({ ok: true, sessionId: terminal.id });
    expect(agent.store.thread(project.id, threadId)).toMatchObject({ surface: "assistant" });
    const idle = codeLink.sessionsOf(project.id, item.id).find((s) => s.mode === "headless" && s.state === "idle");
    expect(idle).toMatchObject({ threadId, branch: terminal.branch, repoId: repo!.id, delivery: terminal.delivery, externalId: "fake-session-1" });
    expect(codeLink.handoffOf(project.id, threadId)).toEqual({ where: "here", toTerminal: { ok: true }, terminal: null });
    const next = agent.send(project.id, threadId, { kind: "text", text: "and now" });
    await until(() => agent.store.run(project.id, next.runId)?.status === "done");
    expect(turns.at(-1)).toMatchObject({ threadId, cwd: started.ok ? started.cwd : "" });
    // the run was tracked on the ticket's session, as before the hand-off
    expect(codeLink.store.session(project.id, idle!.id)).toMatchObject({ state: "idle", externalId: "fake-session-1" });
    fake.close();
  });
});
