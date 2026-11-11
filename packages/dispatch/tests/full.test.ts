/**
 * One whole dispatch between two machines, over the real things: the account's queue in PostgreSQL, the project
 * reaching the second machine by its folder, and on that machine Tomrade's own code link — git, a clone, a
 * worktree, Start. Only the agent is a stand-in: it does the ticket and hands it over, as a brief tells it to.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Context } from "cordis";
import { Agent, type Engine } from "@tomradex/agent";
import { CodeLink } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import GitHubAccount from "@tomradex/github";
import { Repos } from "@tomradex/repos";
import { Tools } from "@tomradex/tools";
import { account, cleanup, machine, share, until, type Account } from "./world.js";

let acct: Account;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-dispatch-full-"));
beforeAll(async () => { acct = await account(); }, 60_000);
afterAll(async () => {
  await cleanup();
  await acct.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

/** The repository both machines know by its address; only the second will ever have a checkout of it. */
function origin(): string {
  const folder = path.join(root, "origin");
  fs.mkdirSync(folder);
  git(["init", "-q", "-b", "main"], folder);
  git(["config", "user.email", "dev@localhost"], folder);
  git(["config", "user.name", "Dev"], folder);
  fs.writeFileSync(path.join(folder, "package.json"), '{ "name": "app" }\n');
  git(["add", "-A"], folder);
  git(["commit", "-q", "-m", "initial"], folder);
  return folder;
}

/** Does the ticket and hands it over. */
const scripted = (seen: { cwd: string; key: string; mode: string | undefined }[]): Engine => ({
  id: "scripted",
  title: "Scripted agent",
  author: "ai:scripted",
  capabilities: ["backlog", "code", "general"],
  permissionModes: { default: "full-access", choices: [{ value: "full-access", label: "Full access" }, { value: "workspace", label: "Workspace" }, { value: "read-only", label: "Read only" }] },
  available: async () => ({ ok: true }),
  async turn(input, io) {
    if (input.cwd && input.purpose === "code" && input.ticket) {
      seen.push({ cwd: input.cwd, key: input.ticket.key, mode: input.permissionMode });
      git(["config", "user.email", "agent@localhost"], input.cwd);
      git(["config", "user.name", "Agent"], input.cwd);
      fs.writeFileSync(path.join(input.cwd, `${input.ticket.key}.ts`), "export {};\n");
      git(["add", "-A"], input.cwd);
      git(["commit", "-q", "-m", `${input.ticket.key}: work`], input.cwd);
      await io.tools.execute("link_code", { scopeChecked: true });
    }
    return { stop: "end", resume: "scripted-session" };
  }
});

it("a ticket written on one machine is sent to the other, which clones the repository, starts its own agent on it and reports it done", { timeout: 120_000 }, async () => {
  const remote = origin();
  const bus = new Set<{ device: string; ctx: Context }>();

  // The machine that plans: it knows the repository by its address and has no checkout, no agent, no code link.
  const a = await machine(acct, "mac-a", { bus, fakes: false, plugins: [Tools, GitHubAccount, [Repos, { gitBinary: "git" }]] });
  const repo = a.ctx.repos.create({ projectId: a.project.id, remote });
  a.boards.update(a.project.id, a.board.id, { repoId: repo.id });
  const ticket = a.items.create({ projectId: a.project.id, boardId: a.board.id, title: "Faster on Windows", status: "todo", workType: "coding", by: "human" });

  // The machine that works: the real code link and a scripted agent. It accepts work, up to editing files.
  const seen: { cwd: string; key: string; mode: string | undefined }[] = [];
  const b = await machine(acct, "win-b", {
    bus, fakes: false,
    plugins: [
      Tools, GitHubAccount, [Repos, { gitBinary: "git" }], Contributions, Agent,
      { name: "scripted-engine", inject: ["agent"], apply: (ctx: Context) => { ctx.agent.engine(scripted(seen)); } }
    ],
    prepare: async (m) => {
      await m.ctx.plugin(CodeLink, { scanMs: 0, gitBinary: "git", defaultsPath: path.join(m.dir, "code-link.json") });
      await share(a, m, a.project.id);
      m.ctx.agent.store.setBrief(a.project.id, "Test project: the brief is written.");
      m.ctx.codeLink.pulls = async () => null;
    }
  });
  b.accept();
  expect(b.ctx.repos.checkout(remote).checkout).toBeNull();
  expect(b.items.getByKey(a.project.id, ticket.key)).toMatchObject({ title: "Faster on Windows", status: "todo" });

  // Sent: nothing more is done by hand. The signal reaches the other machine, and its word comes back the same way.
  const sent = await a.queue.send({ projectId: a.project.id, itemId: ticket.id, to: "win-b" });
  await until(() => a.queue.list().find((d) => d.id === sent.id)?.state === "done", 90_000);

  expect(a.queue.list().find((d) => d.id === sent.id)).toMatchObject({ state: "done", claimedBy: "win-b", reason: null });
  // The work happened on the second machine, in a clone it made in its own folder for cloned code.
  const checkout = b.ctx.repos.checkout(remote).checkout!;
  expect(checkout.startsWith(path.join(b.dir, "hub", "repos"))).toBe(true);
  expect(seen).toHaveLength(1);
  // Under its own limit, not the engine's default.
  expect(seen[0]).toMatchObject({ key: ticket.key, mode: "workspace" });
  const branches = git(["branch", "--format=%(refname:short)"], checkout).split("\n");
  const branch = branches.find((name) => name.toLowerCase().includes(ticket.key.toLowerCase()))!;
  expect(branch).toBeTruthy();
  expect(git(["log", "--format=%s", branch], checkout)).toContain(`${ticket.key}: work`);
  // It is in the taking machine's record, with who asked.
  expect(b.s.recent()).toMatchObject([{ from: "mac-a", key: ticket.key, accepted: true, permissionMode: "workspace" }]);
  // The first machine started nothing and holds no checkout.
  expect(a.ctx.repos.checkout(remote).checkout).toBeNull();
});
