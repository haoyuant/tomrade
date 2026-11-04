/**
 * A night shift over the real code link: git, worktrees, Start and merge are
 * Tomrade's own, and only the agents are stand-ins. Session mode runs a fake
 * engine; terminal mode runs in FakeHerdr's panes and reports over the hooks.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { Agent, type Engine } from "@tomradex/agent";
import { CodeLink, sessionContext } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import GitHubAccount from "@tomradex/github";
import { Herdr } from "@tomradex/herdr";
import { Mcp } from "@tomradex/mcp";
import { NightShifts } from "@tomradex/night-shift";
import { Repos } from "@tomradex/repos";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { disposeFresh, FakeHerdr, fresh, herdrUnsupported, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-night-real-"));
// The contexts first: Windows will not delete the database files they still hold.
afterAll(async () => {
  await disposeFresh();
  fs.rmSync(root, { recursive: true, force: true });
});
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
/** A repository with no remote: the branch is the delivery, and Tomrade merges it here. */
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

const work = (cwd: string, key: string) => {
  fs.writeFileSync(path.join(cwd, `${key}.ts`), "export {};\n");
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", `${key}: work`], cwd);
};

/** Two tickets editing one file: the second to land conflicts with the first. */
const workOnShared = (cwd: string, key: string) => {
  fs.writeFileSync(path.join(cwd, "shared.ts"), `export const by = "${key}";\n`);
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", `${key}: the shared file`], cwd);
};
const resolveConflict = (cwd: string) => git(["merge", "-q", "-X", "ours", "-m", "merge main", "main"], cwd);

/** Does the ticket and hands it over, as a coding agent's brief tells it to. */
const deliveringEngine = (): Engine => ({
  id: "fake-code",
  title: "Fake coding agent",
  author: "ai:fake-code",
  capabilities: ["backlog", "code", "general"],
  available: async () => ({ ok: true }),
  async turn(input, io) {
    if (input.cwd && input.purpose === "code" && input.ticket) {
      const asked = input.input.kind === "text" ? input.input.text : "";
      if (asked.includes("no longer merges")) resolveConflict(input.cwd);
      else if (input.ticket.title.startsWith("Shared")) workOnShared(input.cwd, input.ticket.key);
      else work(input.cwd, input.ticket.key);
      if (asked.includes("report_finding") && input.ticket.title.startsWith("Finds")) await io.tools.execute("report_finding", { from: input.ticket.key, title: "The save button is dead", body: "src/save.ts never fires" });
      await io.tools.execute("link_code", { scopeChecked: true });
    }
    return { stop: "end", resume: "fake-session" };
  }
});

/** Commits something, then stops on what `stop` says, as an agent does when its quota goes mid-ticket. */
const stoppingEngine = (id: string, stop: Awaited<ReturnType<Engine["turn"]>>): Engine => ({
  id,
  title: id,
  author: `ai:${id}`,
  capabilities: ["backlog", "code", "general"],
  permissionModes: { default: "ask", choices: [{ value: "ask", label: "Ask" }, { value: "full", label: "Full" }] },
  available: async () => ({ ok: true }),
  async turn(input) {
    if (input.cwd) work(input.cwd, `${input.ticket?.key}-${id}`);
    return stop;
  }
});

async function machine(engines: Engine[] = []) {
  const checkout = localRepo();
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const enginePlugin = { name: "fake-code-engine", inject: ["agent"], apply: (ctx: Context) => { for (const engine of [deliveringEngine(), ...engines]) ctx.agent.engine(engine); } };
  const bag = await fresh({
    hubDir,
    plugins: [
      Tools,
      [Settings, { path: path.join(hubDir, "settings.json") }], GitHubAccount,
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      [Repos, { gitBinary: "git" }],
      Contributions,
      Agent,
      enginePlugin,
      [CodeLink, { scanMs: 0, gitBinary: "git", defaultsPath: path.join(hubDir, "code-link.json") }],
      [NightShifts, { tickMs: 3_600_000, settleMs: 3_600_000 }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  bag.ctx.agent.store.setBrief(bag.project.id, "Test project: the brief is written.");
  const repo = bag.ctx.repos.create({ projectId: bag.project.id, remote: checkout });
  bag.boards.update(bag.project.id, bag.board.id, { repoId: repo.id });
  await bag.ctx.repos.setCheckout(repo.remote, checkout);
  bag.ctx.codeLink.pulls = async () => null;
  const ticket = (title: string) => bag.items.create({ projectId: bag.project.id, boardId: bag.board.id, title, workType: "coding", status: "todo", by: "human" });
  const status = (id: string) => bag.items.get(bag.project.id, id)!.status;
  return { ...bag, ticket, status, s: bag.ctx.nightShift, checkout };
}

async function until(check: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it("in background sessions: a chain delivers, merges and starts its dependant, and the code lands", { timeout: 60_000 }, async () => {
  const t = await machine();
  const down = t.ticket("Second");
  const up = t.ticket("First");
  t.items.update(t.project.id, up.id, { blocks: [down.id] }, "human");
  t.s.start(t.project.id, { itemIds: [up.id, down.id], mode: "run", engine: "fake-code", autoMerge: true });
  await until(async () => {
    await t.s.tick(Date.now() + 120_000);
    return t.s.current(t.project.id) === null;
  }, 40_000);
  expect(t.s.list(t.project.id, 1)[0]).toMatchObject({ status: "ended", halt: null, counts: { done: 2, failed: 0 }, settings: { mode: "run" } });
  expect([t.status(up.id), t.status(down.id)]).toEqual(["done", "done"]);
  expect(git(["log", "--format=%s", "main"], t.checkout)).toContain(up.key);
  expect(git(["log", "--format=%s", "main"], t.checkout)).toContain(down.key);
  await t.ctx.fiber.dispose();
});

it("in background sessions: an agent told of report_finding can call it, and with no model what it found stays in the backlog", { timeout: 60_000 }, async () => {
  const t = await machine();
  const finder = t.ticket("Finds a problem");
  t.s.start(t.project.id, { itemIds: [finder.id], mode: "run", engine: "fake-code", autoMerge: true });
  await until(async () => {
    await t.s.tick(Date.now() + 120_000);
    return t.s.current(t.project.id) === null;
  }, 40_000);
  const shift = t.s.list(t.project.id, 1)[0]!;
  expect(shift).toMatchObject({ counts: { done: 1, failed: 0 }, found: [{ title: "The save button is dead", fromKey: finder.key, duplicate: false }] });
  expect(shift.tickets).toHaveLength(1);
  expect(t.status(shift.found[0]!.itemId)).toBe("backlog");
  expect(t.status(finder.id)).toBe("done");
  await t.ctx.fiber.dispose();
});

it("in background sessions: two tickets on one file both land, the second after its agent resolves the conflict", { timeout: 60_000 }, async () => {
  const t = await machine();
  const first = t.ticket("Shared one");
  const second = t.ticket("Shared two");
  t.s.start(t.project.id, { itemIds: [first.id, second.id], mode: "run", engine: "fake-code", autoMerge: true, concurrency: 2 });
  await until(async () => {
    await t.s.tick(Date.now() + 120_000);
    return t.s.current(t.project.id) === null;
  }, 40_000);
  const shift = t.s.list(t.project.id, 1)[0]!;
  expect(shift).toMatchObject({ halt: null, failStreak: 0, counts: { done: 2 } });
  expect(shift.tickets.filter((ticket) => ticket.conflictRetried)).toHaveLength(1);
  expect([t.status(first.id), t.status(second.id)]).toEqual(["done", "done"]);
  const log = git(["log", "--format=%s", "main"], t.checkout);
  expect(log).toContain(first.key);
  expect(log).toContain(second.key);
  await t.ctx.fiber.dispose();
});

it.skipIf(herdrUnsupported)("in terminal panes: a conflict goes back to the agent in its own pane, not to a background session", { timeout: 60_000 }, async () => {
  const t = await machine();
  const { ctx, project } = t;
  await ctx.plugin(Mcp, { port: 0 });
  const fake = new FakeHerdr();
  await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket });
  await settle();
  vi.spyOn(ctx.herdr, "installed").mockResolvedValue("0.9.5");
  await until(async () => (await ctx.codeLink.herdrStatus()) === "running");

  const first = t.ticket("Shared one");
  const second = t.ticket("Shared two");
  t.s.start(project.id, { itemIds: [first.id, second.id], mode: "terminal", engine: "fake-code", concurrency: 2, autoMerge: true });
  await t.s.tick();
  await until(() => t.s.current(project.id)?.tickets.every((ticket) => ticket.threadId !== null) === true);
  const later = Date.now() + 120_000;
  const sessionOf = (itemId: string) => ctx.codeLink.store.sessions(project.id, { itemId })[0]!;
  const hand = async (itemId: string, key: string) => {
    const session = sessionOf(itemId);
    await sessionContext.run({ projectId: project.id, sessionId: session.id }, () => ctx.tools.execute("link_code", { key, scopeChecked: true }, { by: "ai:fake-code", projectId: project.id }));
    const token = ctx.codeLink.sessions.token(session.id)!;
    await fetch(ctx.mcp.eventUrlFor(token)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hook_event_name: "Stop", session_id: `cli-${key}` }) });
  };
  workOnShared(ctx.codeLink.worktreeOf(project.id, first.id)!, first.key);
  await hand(first.id, first.key);
  await until(async () => {
    await t.s.tick(later);
    return t.status(first.id) === "done";
  });

  const folder = ctx.codeLink.worktreeOf(project.id, second.id)!;
  workOnShared(folder, second.key);
  const pane = sessionOf(second.id).herdrPane!;
  await hand(second.id, second.key);
  await until(async () => {
    await t.s.tick(later);
    return fake.of("agent.prompt").length === 1;
  });
  expect(fake.of("agent.prompt")).toEqual([expect.objectContaining({ target: pane })]);
  expect(fs.readFileSync(path.join(ctx.codeLink.sessionDir(sessionOf(second.id).id), "prompt.md"), "utf8")).toContain("no longer merges");
  expect(ctx.codeLink.store.sessions(project.id, { itemId: second.id }).filter((s) => s.mode === "headless")).toEqual([]);
  expect(t.status(second.id)).toBe("doing");

  resolveConflict(folder);
  await hand(second.id, second.key);
  await until(async () => {
    await t.s.tick(later);
    return t.status(second.id) === "done";
  });
  expect(git(["log", "--format=%s", "main"], t.checkout)).toContain(second.key);
  await t.ctx.fiber.dispose();
});

it.skipIf(herdrUnsupported)("in terminal panes: each ticket gets a pane, and a usage limit is waited out and the agent told to go on", { timeout: 60_000 }, async () => {
  const t = await machine();
  const { ctx, project } = t;
  await ctx.plugin(Mcp, { port: 0 });
  const fake = new FakeHerdr();
  await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket });
  await settle();
  vi.spyOn(ctx.herdr, "installed").mockResolvedValue("0.9.5");
  await until(async () => (await ctx.codeLink.herdrStatus()) === "running");

  const first = t.ticket("First");
  const second = t.ticket("Second");
  t.s.start(project.id, { itemIds: [first.id, second.id], mode: "terminal", engine: "fake-code", concurrency: 1, autoMerge: true });
  await t.s.tick();
  await until(() => t.s.current(project.id)?.tickets[0]?.threadId != null);
  const sessionOf = (itemId: string) => ctx.codeLink.store.sessions(project.id, { itemId })[0]!;
  const session = sessionOf(first.id);
  expect(session).toMatchObject({ mode: "terminal", herdrPane: "w1:p1" });
  expect(t.status(second.id)).toBe("todo");

  const hook = async (sessionId: string, body: Record<string, unknown>) => {
    const token = ctx.codeLink.sessions.token(sessionId)!;
    await fetch(ctx.mcp.eventUrlFor(token)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  };
  await hook(session.id, { hook_event_name: "StopFailure", session_id: "cli-1", error: "rate_limit", error_details: "usage limit reached" });
  const later = Date.now() + 16 * 60_000;
  await until(() => sessionOf(first.id).state === "error");
  await t.s.tick(Date.now() + 1000);
  await until(() => t.s.current(project.id)?.tickets[0]?.state === "limited");
  expect(fake.of("agent.prompt")).toEqual([]);

  await until(async () => {
    await t.s.tick(later);
    return fake.of("agent.prompt").some((s) => JSON.stringify(s).includes("continue this ticket"));
  });
  expect(t.s.current(project.id)?.tickets[0]).toMatchObject({ resumes: 1 });

  // the agent goes on, delivers and stops its turn: the shift merges and moves on
  const held = sessionOf(first.id);
  const worktree = ctx.codeLink.store.sessions(project.id, { itemId: first.id })[0]!;
  const folder = ctx.codeLink.worktreeOf(project.id, first.id)!;
  expect(worktree.id).toBe(held.id);
  work(folder, first.key);
  await sessionContext.run({ projectId: project.id, sessionId: held.id }, () => ctx.tools.execute("link_code", { key: first.key, scopeChecked: true }, { by: "ai:fake-code", projectId: project.id }));
  await hook(held.id, { hook_event_name: "Stop", session_id: "cli-1" });
  await until(async () => {
    await t.s.tick(later);
    return t.status(second.id) === "doing";
  });
  expect(t.status(first.id)).toBe("done");
  expect(sessionOf(second.id)).toMatchObject({ mode: "terminal" });
  expect(sessionOf(second.id).herdrPane).not.toBe("w1:p1");
  await t.ctx.fiber.dispose();
});

it("in background sessions: an empty account hands the ticket to the next agent, on the same branch and with its commits", { timeout: 60_000 }, async () => {
  const t = await machine([stoppingEngine("broke", { stop: "error", error: "Credit balance is too low" })]);
  const a = t.ticket("First");
  t.s.start(t.project.id, { itemIds: [a.id], mode: "run", engine: "broke", permissionMode: "full", autoMerge: true });
  await until(async () => {
    await t.s.tick(Date.now() + 120_000);
    return t.s.current(t.project.id) === null;
  }, 40_000);
  const shift = t.s.list(t.project.id, 1)[0]!;
  expect(shift).toMatchObject({ counts: { done: 1, failed: 0 }, failStreak: 0 });
  expect(shift.tickets[0]!.switches).toMatchObject([{ from: "broke", to: "fake-code", cause: "balance" }]);
  expect(shift.tickets[0]!.note).toContain("broke");
  expect(shift.steps.find((step) => step.kind === "switched")).toMatchObject({ key: a.key, why: { kind: "switched", from: "broke", to: "fake-code" } });
  const log = git(["log", "--format=%s", "main"], t.checkout);
  expect(log).toContain(`${a.key}-broke`);
  expect(log).toContain(`${a.key}: work`);
  const thread = t.ctx.agent.store.thread(t.project.id, shift.tickets[0]!.threadId!)!;
  expect(thread).toMatchObject({ engine: "fake-code", permissionMode: null, options: null });
  const sessions = t.ctx.codeLink.store.sessions(t.project.id, { itemId: a.id });
  expect(sessions.map((s) => s.agent)).toEqual(["fake-code", "broke"]);
  expect(await t.ctx.codeLink.nextEngine(["broke", "fake-code"], { capability: "code", terminal: false })).toBeNull();
  await t.ctx.fiber.dispose();
});

it("in background sessions: a question left open on the stopped thread does not hold the switch back", { timeout: 60_000 }, async () => {
  const t = await machine([stoppingEngine("broke", { stop: "error", error: "Credit balance is too low" })]);
  const question = { id: "q", text: "Move on?", options: ["Yes", "No"] };
  t.ctx.on("agent/run-ended", (run, thread) => {
    if (run.engine === "broke") t.ctx.agent.store.setPending(thread.projectId, thread.id, { kind: "ask", workflow: null, step: null, state: null, question, accepts: "options", waiveRule: null, waiveOn: [] });
  });
  const a = t.ticket("First");
  t.s.start(t.project.id, { itemIds: [a.id], mode: "run", engine: "broke", autoMerge: true });
  await until(async () => {
    await t.s.tick(Date.now() + 120_000);
    return t.s.current(t.project.id) === null;
  }, 40_000);
  expect(t.s.list(t.project.id, 1)[0]).toMatchObject({ counts: { done: 1 } });
  await t.ctx.fiber.dispose();
});

it("in background sessions: with every agent out of balance the ticket stops for the person, after one try at each", { timeout: 60_000 }, async () => {
  const t = await machine([stoppingEngine("broke", { stop: "error", error: "Credit balance is too low" }), stoppingEngine("broke-too", { stop: "error", error: "insufficient balance" })]);
  vi.spyOn(t.ctx.codeLink, "nextEngine").mockImplementation(async (except) => ["broke", "broke-too"].find((id) => !except.includes(id)) ?? null);
  const a = t.ticket("First");
  t.s.start(t.project.id, { itemIds: [a.id], mode: "run", engine: "broke" });
  await until(async () => {
    await t.s.tick(Date.now() + 120_000);
    return t.s.current(t.project.id) === null;
  }, 40_000);
  const shift = t.s.list(t.project.id, 1)[0]!;
  expect(shift.tickets[0]).toMatchObject({ state: "needs-you", why: { kind: "no-engine", engine: "broke-too" } });
  expect(shift.tickets[0]!.switches).toHaveLength(1);
  expect(shift.steps.map((step) => step.kind)).toEqual(["started", "switched", "needs-you"]);
  await t.ctx.fiber.dispose();
});

it.skipIf(herdrUnsupported)("in terminal panes: a limit closes the agent's pane and a new session takes the ticket up, told where it stood", { timeout: 60_000 }, async () => {
  const t = await machine([stoppingEngine("spare", { stop: "end" })]);
  const { ctx, project } = t;
  await ctx.plugin(Mcp, { port: 0 });
  const fake = new FakeHerdr();
  await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket });
  await settle();
  vi.spyOn(ctx.herdr, "installed").mockResolvedValue("0.9.5");
  await until(async () => (await ctx.codeLink.herdrStatus()) === "running");

  const a = t.ticket("First");
  t.s.start(project.id, { itemIds: [a.id], mode: "terminal", engine: "fake-code", concurrency: 1 });
  await t.s.tick();
  await until(() => t.s.current(project.id)?.tickets[0]?.threadId != null);
  const sessionOf = () => ctx.codeLink.store.sessions(project.id, { itemId: a.id })[0]!;
  const first = sessionOf();
  const folder = ctx.codeLink.worktreeOf(project.id, a.id)!;
  work(folder, a.key);
  const hook = async (body: Record<string, unknown>) => {
    await fetch(ctx.mcp.eventUrlFor(ctx.codeLink.sessions.token(first.id)!)!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  };
  await sessionContext.run({ projectId: project.id, sessionId: first.id }, () => ctx.tools.execute("note_progress", { key: a.key, text: "half the tests pass" }, { by: "ai:fake-code", projectId: project.id }));
  await t.s.tick(Date.now() + 1000);
  await hook({ hook_event_name: "StopFailure", session_id: "cli-1", error: "rate_limit", error_details: "usage limit reached" });
  await until(() => sessionOf().state === "error");
  await until(async () => {
    await t.s.tick(Date.now() + 1000);
    return sessionOf().id !== first.id;
  });

  expect(ctx.codeLink.store.session(project.id, first.id)).toMatchObject({ state: "ended" });
  const second = sessionOf();
  expect(second).toMatchObject({ mode: "terminal", agent: "spare" });
  expect(second.herdrPane).not.toBe(first.herdrPane);
  expect(ctx.codeLink.worktreeOf(project.id, a.id)).toBe(folder);
  expect(git(["log", "--format=%s"], folder)).toContain(`${a.key}: work`);
  const told = fs.readFileSync(path.join(ctx.codeLink.sessionDir(second.id), "prompt.md"), "utf8");
  expect(told).toContain("Fake coding agent stopped on this ticket");
  expect(told).toContain("half the tests pass");
  expect(told).toContain("git log");
  expect(ctx.agent.parked(project.id, second.threadId!)).toBeNull();
  await t.ctx.fiber.dispose();
});

it("set to wait, a limit keeps the ticket on its agent though another could take it", { timeout: 60_000 }, async () => {
  const t = await machine([stoppingEngine("limited", { stop: "error", error: "usage limit reached" })]);
  const a = t.ticket("First");
  t.s.start(t.project.id, { itemIds: [a.id], mode: "run", engine: "limited", whenLimited: "wait" });
  await until(async () => {
    await t.s.tick();
    return t.s.current(t.project.id)?.tickets[0]?.state === "limited";
  });
  await t.s.tick();
  await settle();
  const ticket = t.s.current(t.project.id)!.tickets[0]!;
  expect(ticket.switches).toBeUndefined();
  expect(t.ctx.agent.store.thread(t.project.id, ticket.threadId!)).toMatchObject({ engine: "limited" });
  // the run's settings answered already, so its thread asks nobody
  expect(t.ctx.agent.store.pending(t.project.id, ticket.threadId!)).toBeNull();
  await t.ctx.fiber.dispose();
});
