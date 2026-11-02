import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Agent, type EngineRecord } from "@tomradex/agent";
import { CodeLink } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import GitHubAccount from "@tomradex/github";
import { FakeLlm } from "@tomradex/llm";
import { Mcp } from "@tomradex/mcp";
import { Repos } from "@tomradex/repos";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { Takeover, buildEntries, issueNumbers, organize, ticketBody, type BranchFact, type Facts, type SessionFact, type TakeoverEntry } from "@tomradex/takeover";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { TAKEOVER_WORDS } from "../src/words.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-takeover-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const w = TAKEOVER_WORDS("en");
const noFacts: Facts = { branches: [], worktrees: [], issues: [], sessions: [] };

let n = 0;
function commit(checkout: string, file: string, subject: string) {
  fs.writeFileSync(path.join(checkout, file), `${subject}\n`);
  git(["add", "-A"], checkout);
  git(["commit", "-q", "-m", subject], checkout);
}

function codeRepo() {
  const dir = path.join(root, `repo-${n++}`);
  const remote = path.join(dir, "remote.git");
  const checkout = path.join(dir, "checkout");
  fs.mkdirSync(remote, { recursive: true });
  fs.mkdirSync(checkout);
  git(["init", "--bare", "-q", "-b", "main", "."], remote);
  git(["init", "-q", "-b", "main"], checkout);
  git(["remote", "add", "origin", remote], checkout);
  git(["config", "user.email", "dev@localhost"], checkout);
  git(["config", "user.name", "Dev"], checkout);
  commit(checkout, "package.json", "initial");
  git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], checkout);
  return { remote, checkout };
}

async function machine(codeLink: Record<string, unknown> = {}) {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const repo = codeRepo();
  const bag = await fresh({
    hubDir,
    plugins: [Tools, [Settings, { path: path.join(hubDir, "settings.json") }], GitHubAccount, [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }], Repos, Contributions, Agent, [Mcp, { port: 0 }], [CodeLink, { scanMs: 0, ...codeLink }], Takeover]
  });
  await settle();
  await bag.ctx.storage.ready;
  const row = bag.ctx.repos.create({ projectId: bag.project.id, remote: repo.remote });
  bag.boards.update(bag.project.id, bag.board.id, { repoId: row.id });
  await bag.ctx.repos.setCheckout(repo.remote, repo.checkout);
  bag.ctx.codeLink.pulls = async () => null;
  onTestFinished(() => bag.ctx.fiber.dispose());
  return { ...bag, checkout: repo.checkout, repo: row, takeover: bag.ctx.takeover };
}

function branches(checkout: string, names: string[]) {
  for (const name of names) {
    git(["checkout", "-q", "-b", name, "main"], checkout);
    commit(checkout, `${name.replace(/\W/g, "-")}.ts`, `work on ${name}`);
  }
  git(["checkout", "-q", "main"], checkout);
}

const branch = (name: string, subjects: string[] = []): BranchFact => ({ repoId: "r", repoName: "app", branch: name, keyNum: null, sha: name, committedAt: 0, ahead: 1, behind: 0, base: "origin/main", subjects, parent: null });
const session = (file: string, branchName: string | null = null): SessionFact => ({ agent: "claude-code", agentTitle: "Claude Code", repoId: "r", repoName: "app", file, at: 0, branch: branchName, title: "Fix the login page", lastSaid: "keep going", excerpt: "person: keep going" });

function recorder(checkout: string, file: string): EngineRecord & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    find: () => null,
    roots: () => ["/records"],
    sessions: () => (reads.push("sessions"), [{ file, at: Date.now() - 3_600_000, cwd: fs.realpathSync(checkout), branch: null }]),
    read: (f) => (reads.push(f), { lines: [{ who: "person", text: "Fix the login page" }, { who: "agent", text: "Half of it is done" }], cut: false })
  };
}

const engineWith = (record: EngineRecord) => ({ id: "claude-code", title: "Claude Code", author: "ai:claude-code", available: async () => ({ ok: true }), turn: async () => ({ stop: "end" as const }), local: { record } });

describe("taking over a repository", () => {
  it("drafts every unmerged branch with where it came from, writing no ticket", async () => {
    const { takeover, project, checkout, items } = await machine();
    branches(checkout, ["feature/a", "feature/b", "fix/c", "fix/d", "spike/e", "spike/f"]);

    const draft = await takeover.scan(project.id, { sessions: false, model: null });

    expect(draft.model).toBeNull();
    expect(draft.entries.map((e) => e.branch).sort()).toEqual(["feature/a", "feature/b", "fix/c", "fix/d", "spike/e", "spike/f"]);
    for (const entry of draft.entries) expect(entry.sources[0]).toMatchObject({ kind: "branch", ref: entry.branch, detail: expect.stringContaining("ahead of origin/main by 1") });
    expect(items.list({ projectId: project.id })).toEqual([]);
  });

  it("writes what was ticked, links its branch and keeps its source; what was not ticked stays out", async () => {
    const { ctx, takeover, project, checkout, items } = await machine();
    branches(checkout, ["feature/a", "feature/b", "fix/c", "fix/d", "spike/e"]);
    const draft = await takeover.scan(project.id, { sessions: false, model: null });
    const ticked = draft.entries.find((e) => e.branch === "fix/c")!;

    const applied = takeover.apply(project.id, draft.id, [ticked.id]);

    expect(applied.created).toHaveLength(1);
    const tickets = items.list({ projectId: project.id });
    expect(tickets.map((i) => i.title)).toEqual(["work on fix/c"]);
    expect(tickets[0]!.body).toContain("`fix/c`");
    expect(ctx.codeLink.links(project.id, tickets[0]!.id)).toMatchObject([{ branch: "fix/c" }]);
    expect(() => takeover.apply(project.id, draft.id, [ticked.id])).toThrow("out of date");
  });

  it("leaves out a branch a ticket already holds", async () => {
    const { takeover, project, checkout, items, board } = await machine();
    const ticket = items.create({ projectId: project.id, boardId: board.id, title: "Held", status: "todo", by: "human" });
    branches(checkout, [`${ticket.key.toLowerCase()}/held`, "feature/loose"]);
    const draft = await takeover.scan(project.id, { sessions: false, model: null });
    expect(draft.entries.map((e) => e.branch)).toEqual(["feature/loose"]);
  });

  it("reads open GitHub issues, says so when it cannot, and leaves out what the backlog already took", async () => {
    const { ctx, takeover, project, checkout, repo } = await machine({ fetch: false });
    git(["remote", "set-url", "origin", "https://github.com/o/app.git"], checkout);
    ctx.repos.update(project.id, repo.id, { remote: "https://github.com/o/app.git" });
    await ctx.repos.setCheckout("https://github.com/o/app.git", checkout);

    const token = vi.spyOn(ctx.github, "readToken").mockResolvedValue(null);
    const signedOut = await takeover.scan(project.id, { sessions: false, model: null });
    expect(signedOut.notes).toContain(w("noGithub"));

    token.mockResolvedValue("token");
    const request = vi.spyOn(ctx.github.issues, "request").mockResolvedValue([
      { number: 4, title: "Login fails", body: "It times out", html_url: "https://github.com/o/app/issues/4", user: { login: "ann" }, labels: [], state: "open", created_at: "2026-10-01T00:00:00Z" },
      { number: 5, title: "A pull request", body: "", html_url: "https://github.com/o/app/pull/5", user: null, labels: [], state: "open", created_at: "2026-10-01T00:00:00Z", pull_request: {} }
    ] as never);
    const draft = await takeover.scan(project.id, { sessions: false, model: null });
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    expect(draft.entries).toMatchObject([{ id: "issue:o/app#4", title: "Login fails", sources: [{ kind: "issue", url: "https://github.com/o/app/issues/4" }] }]);

    takeover.apply(project.id, draft.id, [draft.entries[0]!.id]);
    expect((await takeover.scan(project.id, { sessions: false, model: null })).entries).toEqual([]);
  });

  it("keeps a stack's order: a branch built on another depends on it, in the draft and on the tickets", async () => {
    const { takeover, project, checkout, items } = await machine();
    git(["checkout", "-q", "-b", "stack/base", "main"], checkout);
    commit(checkout, "base.ts", "base");
    git(["checkout", "-q", "-b", "stack/top"], checkout);
    commit(checkout, "top.ts", "top");
    git(["checkout", "-q", "main"], checkout);

    const draft = await takeover.scan(project.id, { sessions: false, model: null });
    const base = draft.entries.find((e) => e.branch === "stack/base")!;
    const top = draft.entries.find((e) => e.branch === "stack/top")!;
    expect(top.dependsOn).toEqual([base.id]);

    takeover.apply(project.id, draft.id, [base.id, top.id]);
    const byBranch = new Map(items.list({ projectId: project.id }).map((i) => [i.title, i]));
    expect(byBranch.get("base")!.blocks).toEqual([byBranch.get("top")!.id]);
  });

  it("reads no agent's record unless told it may, and the rest of the scan goes on", async () => {
    const { ctx, takeover, project, checkout } = await machine();
    branches(checkout, ["feature/a"]);
    const record = recorder(checkout, "/records/s1.jsonl");
    ctx.agent.engine(engineWith(record));

    const declined = await takeover.scan(project.id, { sessions: false, model: null });
    expect(record.reads).toEqual([]);
    expect(declined.entries.map((e) => e.branch)).toEqual(["feature/a"]);
    expect(declined.notes).toContain(w("sessionsDeclined"));

    const agreed = await takeover.scan(project.id, { sessions: true, model: null });
    expect(record.reads).toEqual(["sessions", "/records/s1.jsonl"]);
    expect(agreed.entries.find((e) => e.id === "session:/records/s1.jsonl")).toMatchObject({ title: "Fix the login page", sources: [{ kind: "session", ref: "/records/s1.jsonl" }] });
    expect(await takeover.offer(project.id)).toMatchObject({ sessions: [{ title: "Claude Code", folders: ["/records"] }] });
  });

  it("does not offer a session again once a ticket came from it", async () => {
    const { ctx, takeover, project, checkout } = await machine();
    ctx.agent.engine(engineWith(recorder(checkout, "/records/s1.jsonl")));
    const first = await takeover.scan(project.id, { sessions: true, model: null });
    takeover.apply(project.id, first.id, first.entries.map((e) => e.id));
    const again = await takeover.scan(project.id, { sessions: true, model: null });
    expect(again.entries).toEqual([]);
  });

  it("sends nothing to the model unless it is the one the person agreed to", async () => {
    const { ctx, takeover, project, checkout } = await machine();
    branches(checkout, ["feature/a"]);
    const respond = vi.fn(() => ({ entries: [] }));
    const llm = new FakeLlm(respond);
    ctx.provide("llm", Object.assign(llm, { worker: async () => ({ ok: true, title: "Model A" }) }));
    await settle();

    expect((await takeover.offer(project.id)).model).toBe("Model A");
    expect((await takeover.scan(project.id, { sessions: false, model: null })).model).toBeNull();
    expect(respond).not.toHaveBeenCalled();
    const swapped = await takeover.scan(project.id, { sessions: false, model: "Model B" });
    expect(respond).not.toHaveBeenCalled();
    expect(swapped.notes.join()).toContain("Model B");
    expect((await takeover.scan(project.id, { sessions: false, model: "Model A" })).model).toBe("Model A");
    expect(respond).toHaveBeenCalled();
  });

  it("still lists the facts when the model fails", async () => {
    const { ctx, takeover, project, checkout } = await machine();
    branches(checkout, ["feature/a"]);
    const llm = new FakeLlm(() => {
      throw new Error("model down");
    });
    ctx.provide("llm", Object.assign(llm, { worker: async () => ({ ok: true, title: "Model A" }) }));
    await settle();
    const draft = await takeover.scan(project.id, { sessions: false, model: "Model A" });
    expect(draft.model).toBeNull();
    expect(draft.entries.map((e) => e.branch)).toEqual(["feature/a"]);
    expect(draft.notes.join()).toContain("model down");
  });

  it("lists an idle worktree's unfinished changes and leaves a recent one alone", async () => {
    const { takeover, project, checkout } = await machine();
    const idle = path.join(path.dirname(checkout), "idle");
    const busy = path.join(path.dirname(checkout), "busy");
    git(["worktree", "add", "-q", "--detach", idle, "main"], checkout);
    git(["worktree", "add", "-q", "--detach", busy, "main"], checkout);
    for (const dir of [idle, busy]) fs.writeFileSync(path.join(dir, "wip.ts"), "wip\n");
    const old = new Date(Date.now() - 3 * 86_400_000);
    fs.utimesSync(path.join(idle, "wip.ts"), old, old);
    git(["-c", "user.email=d@l", "-c", "user.name=D", "commit", "-q", "--allow-empty", "-m", "old", "--date", old.toISOString()], idle);
    execFileSync("git", ["-c", "user.email=d@l", "-c", "user.name=D", "commit", "-q", "--amend", "--no-edit", "--allow-empty"], { cwd: idle, env: { ...process.env, GIT_COMMITTER_DATE: old.toISOString() } });

    const draft = await takeover.scan(project.id, { sessions: false, model: null });
    expect(draft.entries.map((e) => e.id)).toEqual([`worktree:${fs.realpathSync(idle)}`]);
    expect(draft.entries[0]!.sources[0]).toMatchObject({ kind: "worktree", detail: expect.stringContaining("uncommitted files: 1") });
  });
});

describe("the draft", () => {
  it("gathers one piece of work under its branch: the worktree, the issue it closes and the session on it", () => {
    const entries = buildEntries(
      {
        branches: [branch("gh-12-login", ["Fix login"])],
        worktrees: [{ repoId: "r", repoName: "app", dir: "/wt/one", branch: "gh-12-login", dirty: 2, ahead: 1, touchedAt: 0 }],
        issues: [
          { repoId: "r", repoName: "app", ref: "o/app#12", number: 12, url: "https://github.com/o/app/issues/12", title: "Login fails", body: "", reporter: "ann" },
          { repoId: "r", repoName: "app", ref: "o/app#13", number: 13, url: "https://github.com/o/app/issues/13", title: "Dark mode", body: "please", reporter: null }
        ],
        sessions: [session("/s/on-branch.jsonl", "gh-12-login"), session("/s/alone.jsonl")]
      },
      w
    );
    expect(entries.map((e) => e.id)).toEqual(["branch:r:gh-12-login", "issue:o/app#13", "session:/s/alone.jsonl"]);
    expect(entries[0]!.sources.map((s) => s.kind)).toEqual(["branch", "worktree", "issue", "session"]);
  });

  it("finds an issue a commit names", () => {
    expect([...issueNumbers(branch("topic", ["Fix #7 and #9"]))]).toEqual([7, 9]);
  });

  it("drops a dependency on a branch the draft does not list", () => {
    expect(buildEntries({ ...noFacts, branches: [{ ...branch("a"), parent: "gone" }] }, w)[0]!.dependsOn).toEqual([]);
  });

  it("says where a ticket came from in its body, with the issue's link", () => {
    const entry: TakeoverEntry = { id: "x", title: "T", summary: "What is left", sources: [{ kind: "issue", label: "Issue", repoName: "app", ref: "o/app#1", url: "https://x/1", detail: "" }], dependsOn: [], similar: null, covered: false, repoId: null, branch: null };
    expect(ticketBody(entry, w)).toBe("What is left\n\n## Where this came from\n\n- Issue [o/app#1](https://x/1) (app)");
  });

  it("takes the model's words, its dependencies and its verdict on sessions, and only those", async () => {
    const facts: Facts = { ...noFacts, branches: [branch("a"), branch("b")], sessions: [session("/s/done.jsonl")] };
    const entries = buildEntries(facts, w);
    let prompt = "";
    const llm = new FakeLlm((_system, user) => {
      prompt = user;
      return {
        entries: [
          { label: "E1", title: "Better A", summary: "Left: tests", finished: true, dependsOn: ["E2", "E9"] },
          { label: "E2", dependsOn: [] },
          { label: "E3", finished: true, dependsOn: [] }
        ]
      };
    });
    const out = await organize(llm, entries, facts, "en");
    expect(prompt).toContain("person: keep going");
    expect(out.dropped).toBe(1);
    expect(out.entries.map((e) => e.title)).toEqual(["Better A", "b"]);
    expect(out.entries[0]).toMatchObject({ summary: "Left: tests", dependsOn: ["branch:r:b"] });
    expect(out.entries[1]!.dependsOn).toEqual([]);
  });

  it("refuses a model's dependency that would make a cycle", async () => {
    const facts: Facts = { ...noFacts, branches: [branch("a"), branch("b")] };
    const llm = new FakeLlm(() => ({ entries: [{ label: "E1", dependsOn: ["E2"] }, { label: "E2", dependsOn: ["E1"] }] }));
    const out = await organize(llm, buildEntries(facts, w), facts, "en");
    expect(out.entries.flatMap((e) => e.dependsOn)).toHaveLength(1);
  });
});
