/**
 * Start by a project's role, over the real Agent, code link and a real repository: stand-in engines keep what they
 * were told and under which permission mode.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { Context } from "cordis";
import { Agent, type Engine, type TurnInput } from "@tomradex/agent";
import { CodeLink, type StartResult } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import GitHubAccount from "@tomradex/github";
import { Repos } from "@tomradex/repos";
import { IMPLEMENTER, REVIEWER, Roles } from "@tomradex/roles";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { disposeFresh, fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-start-role-"));
afterAll(async () => {
  await disposeFresh();
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
let template: { remote: string; checkout: string } | null = null;
function codeRepo(): { remote: string; checkout: string } {
  if (!template) {
    const remote = path.join(root, "template-remote.git");
    fs.mkdirSync(remote, { recursive: true });
    git(["init", "--bare", "-b", "main", "."], remote);
    const checkout = path.join(root, "template-checkout");
    fs.mkdirSync(checkout, { recursive: true });
    git(["init", "-q", "-b", "main"], checkout);
    git(["remote", "add", "origin", remote], checkout);
    git(["config", "user.email", "dev@localhost"], checkout);
    git(["config", "user.name", "Dev"], checkout);
    fs.writeFileSync(path.join(checkout, "README.md"), "# app\n");
    fs.writeFileSync(path.join(checkout, "package.json"), '{ "name": "app" }\n');
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "initial"], checkout);
    git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], checkout);
    template = { remote, checkout };
  }
  const remote = path.join(root, `remote-${n++}.git`);
  const checkout = path.join(root, `checkout-${n++}`);
  fs.cpSync(template.remote, remote, { recursive: true });
  fs.cpSync(template.checkout, checkout, { recursive: true });
  git(["remote", "set-url", "origin", remote], checkout);
  return { remote, checkout };
}

async function machine(opts: { roles?: boolean; down?: string[] } = {}) {
  const repo = codeRepo();
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const turns: (TurnInput & { engine: string })[] = [];
  const down = new Set(opts.down ?? []);
  const engine = (id: string, modes: string[]): Engine => ({
    id, title: id[0]!.toUpperCase() + id.slice(1), author: `ai:${id}`, capabilities: ["backlog", "code", "general"],
    ...(modes.length ? { permissionModes: { default: modes.at(-1)!, choices: modes.map((value) => ({ value, label: value })) } } : {}),
    available: async () => (down.has(id) ? { ok: false, reason: "not signed in" } : { ok: true }),
    async turn(input) {
      turns.push({ ...input, engine: id });
      return { stop: "end" };
    }
  });
  const engines = { name: "role-engines", inject: ["agent"], apply: (ctx: Context) => { ctx.agent.engine(engine("alpha", ["plan", "default", "acceptEdits", "bypassPermissions"])); ctx.agent.engine(engine("beta", ["read-only", "workspace", "full-access"])); ctx.agent.engine(engine("gamma", ["bypassPermissions"])); } };
  const bag = await fresh({
    hubDir,
    plugins: [
      Tools,
      [Settings, { path: path.join(hubDir, "settings.json") }], GitHubAccount,
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      [Repos, { gitBinary: "git" }],
      Contributions,
      Agent,
      engines,
      ...(opts.roles === false ? [] : [Roles]),
      [CodeLink, { scanMs: 0, gitBinary: "git", defaultsPath: path.join(hubDir, "code-link.json") }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  const ctx = bag.ctx as Context;
  ctx.agent.store.setBrief(bag.project.id, "Test project: the brief is written.");
  const row = ctx.repos.create({ projectId: bag.project.id, remote: repo.remote });
  bag.boards.update(bag.project.id, bag.board.id, { repoId: row.id });
  await ctx.repos.setCheckout(repo.remote, repo.checkout);
  ctx.codeLink.pulls = async () => null;
  const ticket = (title: string) => bag.items.create({ projectId: bag.project.id, boardId: bag.board.id, title, workType: "coding", status: "todo", by: "human" });
  const projectId = bag.project.id;
  const started = async (result: StartResult) => {
    if (!result.ok) throw new Error(`start refused: ${result.message}`);
    const before = turns.length;
    const waited = Date.now();
    while (turns.length === before && !turns.some((turn) => turn.threadId === result.threadId)) {
      if (Date.now() - waited > 8000) throw new Error("the run never started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const turn = turns.find((t) => t.threadId === result.threadId)!;
    return { result, turn, text: turn.input.kind === "text" ? turn.input.text : "", session: ctx.codeLink.sessionsOf(projectId).find((s) => s.id === result.sessionId)! };
  };
  return { ...bag, ctx, projectId, codeLink: ctx.codeLink, turns, ticket, started, down };
}

it("starts as it always did when no role says anything", async () => {
  const t = await machine();
  const { result, turn, text, session } = await t.started(await t.codeLink.start(t.projectId, t.ticket("Plain").id, { mode: "run" }));
  expect(result).toMatchObject({ ok: true, engine: "alpha" });
  // the engine's own default mode, no role's words, no role on the session
  expect(turn.permissionMode).toBe("bypassPermissions");
  expect(text).not.toContain("<role ");
  expect(session.role).toBeNull();
  expect(t.codeLink.startDefaults()).toMatchObject({ mode: "run", engine: "alpha" });
  await t.ctx.fiber.dispose();

  const bare = await machine({ roles: false });
  expect(await bare.codeLink.start(bare.projectId, bare.ticket("No plugin").id, { mode: "run", role: "anything" })).toMatchObject({ ok: true, engine: "alpha" });
  await bare.ctx.fiber.dispose();
});

it("tries a role's agents in the role's order, holds the run within its limit, and tells its agent the role's instructions", async () => {
  const t = await machine({ down: ["beta"] });
  const role = t.ctx.roles.save(t.projectId, { title: "Careful", engines: ["beta", "gamma", "alpha"], permission: "edits", instructions: "Measure before and after." });
  // beta is not ready and gamma has no mode within the limit: gamma is the one picked, and refused for its modes
  const refused = await t.codeLink.start(t.projectId, t.ticket("Limited").id, { mode: "run", role: role.id });
  expect(refused).toMatchObject({ ok: false, gate: "engine", engine: "gamma", message: "Gamma has no permission mode within the limit of the role Careful (edits) — pick another agent, or change the role" });

  t.ctx.roles.save(t.projectId, { id: role.id, title: "Careful", engines: ["beta", "alpha"] });
  const { result, turn, text, session } = await t.started(await t.codeLink.start(t.projectId, t.ticket("Ordered").id, { mode: "run", role: role.id }));
  expect(result).toMatchObject({ ok: true, engine: "alpha" });
  expect(turn.permissionMode).toBe("acceptEdits");
  expect(text).toContain('<role name="Careful">');
  expect(text).toContain("Measure before and after.");
  expect(session.role).toBe(role.id);
  // what a role chose is not remembered as the person's own habit
  expect(t.codeLink.startDefaults()).toBeNull();

  t.down.delete("beta");
  const next = await t.started(await t.codeLink.start(t.projectId, t.ticket("Preferred").id, { mode: "run", role: role.id }));
  expect(next.result).toMatchObject({ engine: "beta" });
  expect(next.turn.permissionMode).toBe("workspace");
  await t.ctx.fiber.dispose();
});

it("refuses a Start whose role names no agent that can start here, and hands it to no other", async () => {
  const t = await machine({ down: ["beta"] });
  const role = t.ctx.roles.save(t.projectId, { title: "Elsewhere", engines: ["beta", "delta"] });
  const item = t.ticket("Nobody");
  const refused = await t.codeLink.start(t.projectId, item.id, { mode: "run", role: role.id });
  expect(refused.ok).toBe(false);
  expect(refused).toMatchObject({ gate: "engine" });
  expect((refused as { message: string }).message).toContain("None of the agents of the role Elsewhere can start here");
  expect((refused as { message: string }).message).toContain("not signed in");
  expect(t.turns).toEqual([]);
  expect(t.codeLink.sessionsOf(t.projectId, item.id)).toEqual([]);
  await t.ctx.fiber.dispose();
});

it("puts what the person names at this Start before the role", async () => {
  const t = await machine();
  const role = t.ctx.roles.save(t.projectId, { title: "Narrow", engines: ["beta"], permission: "read" });
  const { result, turn, session } = await t.started(await t.codeLink.start(t.projectId, t.ticket("Mine").id, { mode: "run", role: role.id, engine: "alpha", permissionMode: "default" }));
  expect(result).toMatchObject({ engine: "alpha" });
  expect(turn.permissionMode).toBe("default");
  expect(session.role).toBe(role.id);
  await t.ctx.fiber.dispose();
});

it("works as the implementer the project has changed, and never as a reviewing role", async () => {
  const t = await machine();
  t.ctx.roles.save(t.projectId, { id: IMPLEMENTER, title: "Implementer", engines: ["beta"], permission: "edits", instructions: "Small commits." });
  const plain = await t.started(await t.codeLink.start(t.projectId, t.ticket("Default role").id, { mode: "run" }));
  expect(plain.result).toMatchObject({ engine: "beta" });
  expect(plain.turn.permissionMode).toBe("workspace");
  expect(plain.text).toContain("Small commits.");
  // nobody named the role: the session says none
  expect(plain.session.role).toBeNull();
  // a role that reviews is not one to work a ticket as: the implementer stands in
  const other = await t.started(await t.codeLink.start(t.projectId, t.ticket("Wrong stage").id, { mode: "run", role: REVIEWER }));
  expect(other.result).toMatchObject({ engine: "beta" });
  expect(other.session.role).toBeNull();
  await t.ctx.fiber.dispose();
});
