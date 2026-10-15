/**
 * Against a real repository, because the point is that git is the truth: a
 * branch named after a ticket moves it to doing, a merge to done, and a ticket
 * that claims more than the code shows is flagged for a person — never moved
 * back by the scanner itself.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodeLink } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import { Repos } from "@tomradex/repos";
import GitHubAccount from "@tomradex/github";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { fresh, settle } from "@tomradex/testkit";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-link-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
/** A bare remote with one commit on main, and a developer's checkout of it. */
function codeRepo(opts: { manifest?: boolean; empty?: boolean } = {}): { remote: string; checkout: string } {
  const remote = path.join(root, `remote-${n++}.git`);
  fs.mkdirSync(remote, { recursive: true });
  git(["init", "--bare", "-b", "main", "."], remote);
  const checkout = path.join(root, `checkout-${n++}`);
  fs.mkdirSync(checkout, { recursive: true });
  git(["init", "-q", "-b", "main"], checkout);
  git(["remote", "add", "origin", remote], checkout);
  git(["config", "user.email", "dev@localhost"], checkout);
  git(["config", "user.name", "Dev"], checkout);
  if (opts.empty) return { remote, checkout };
  fs.writeFileSync(path.join(checkout, "README.md"), "# app\n");
  if (opts.manifest !== false) fs.writeFileSync(path.join(checkout, "package.json"), '{ "name": "app" }\n');
  git(["add", "-A"], checkout);
  git(["commit", "-q", "-m", "initial"], checkout);
  git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], checkout);
  return { remote, checkout };
}

function commitOn(checkout: string, branch: string, file: string, message: string): string {
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], checkout);
  if (current !== branch) {
    const exists = execFileSync("git", ["branch", "--list", branch], { cwd: checkout, encoding: "utf8" }).trim();
    // A new branch always starts from main, whatever the last test step left checked out.
    git(exists ? ["checkout", "-q", branch] : ["checkout", "-q", "-b", branch, "main"], checkout);
  }
  fs.writeFileSync(path.join(checkout, file), `${message}\n`);
  git(["add", "-A"], checkout);
  git(["commit", "-q", "-m", message], checkout);
  return git(["rev-parse", "HEAD"], checkout);
}

async function until(check: () => boolean, timeout = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function machine(repo: { remote: string; checkout: string }) {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({
    hubDir,
    plugins: [[Settings, { path: path.join(hubDir, "settings.json") }], GitHubAccount, [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }], Repos, Contributions, [CodeLink, { scanMs: 0 }]]
  });
  await settle();
  await bag.ctx.storage.ready;
  const row = bag.ctx.repos.create({ projectId: bag.project.id, remote: repo.remote });
  bag.boards.update(bag.project.id, bag.board.id, { repoId: row.id });
  await bag.ctx.repos.setCheckout(repo.remote, repo.checkout);
  await settle();
  await bag.ctx.codeLink.scan(bag.project.id);
  const ticket = (title: string, status?: "backlog" | "todo" | "doing" | "verifying" | "done" | "cancelled") =>
    bag.items.create({ projectId: bag.project.id, boardId: bag.board.id, title, status, by: "human" });
  return { ...bag, codeLink: bag.ctx.codeLink, repo: row, checkout: repo.checkout, ticket };
}

describe("code link", () => {
  it("honors a human completion policy in any linked repository", async () => {
    const { codeLink, ctx, project, checkout, ticket, items } = await machine(codeRepo());
    try {
      const second = codeRepo();
      const repo = ctx.repos.create({ projectId: project.id, remote: second.remote });
      await ctx.repos.setCheckout(second.remote, second.checkout);
      const item = ticket("Coordinate two repositories", "todo");
      const branch = `tom-${item.keyNum}/coordinated`;
      for (const cwd of [checkout, second.checkout]) {
        commitOn(cwd, branch, "change.ts", `${item.key}: coordinated change`);
        git(["push", "-q", "origin", branch], cwd);
      }
      await codeLink.scan(project.id);
      codeLink.setRepoPolicy(project.id, repo.id, { autoDone: false });
      expect(codeLink.completionPolicy(project.id, items.get(project.id, item.id)!)).toBe("human");
      for (const cwd of [checkout, second.checkout]) {
        git(["checkout", "-q", "main"], cwd);
        git(["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch], cwd);
        git(["push", "-q", "origin", "main"], cwd);
      }
      await codeLink.scan(project.id);
      expect(items.get(project.id, item.id)?.status).not.toBe("done");
      codeLink.setRepoPolicy(project.id, repo.id, { autoDone: true });
      await codeLink.scan(project.id);
      expect(items.get(project.id, item.id)?.status).toBe("done");
    } finally { await ctx.fiber.dispose(); }
  });
  it("lets a person accept mixed output over unmerged links", async () => {
    const { codeLink, ctx, items, project, checkout, ticket } = await machine(codeRepo());
    try {
      const item = ticket("Ship code and guide", "todo");
      const branches = [`tom-${item.keyNum}/first`, `tom-${item.keyNum}/second`];
      for (const [index, branch] of branches.entries()) {
        commitOn(checkout, branch, `change-${index}.ts`, `${item.key}: change ${index}`);
        git(["push", "-q", "origin", branch], checkout);
      }
      await codeLink.scan(project.id);
      items.files({ async getVersion(_project, ref) { return ref; }, async describe() { return []; } });
      const updated = await items.addResource(project.id, item.id, { name: "Guide", role: "output", file: { fileId: "guide", versionId: "v1" } }, "human");
      items.submitDelivery(project.id, item.id, { report: "Code and guide", artifactIds: updated.evidence.resources.map(r => r.id) }, "human");
      const current = items.get(project.id, item.id)!;
      const accepted = items.reviewDelivery(project.id, item.id, { submissionId: current.evidence.submissions.at(-1)!.id, decision: "accepted" }, current.version);
      expect(accepted.status).toBe("done");
      expect(accepted.evidence.reviews.at(-1)?.decision).toBe("accepted");
    } finally { await ctx.fiber.dispose(); }
  });
  it("keeps a sync from finishing a submitted coding delivery before its links merge", async () => {
    const { codeLink, ctx, items, project, checkout, ticket } = await machine(codeRepo());
    try {
      const item = ticket("Ship code", "todo");
      commitOn(checkout, `tom-${item.keyNum}/first`, "change.ts", `${item.key}: change`);
      git(["push", "-q", "origin", `tom-${item.keyNum}/first`], checkout);
      await codeLink.scan(project.id);
      items.submitDelivery(project.id, item.id, { report: "Code", artifactIds: [] }, "ai:test");
      expect(() => items.update(project.id, item.id, { status: "done" }, "sync:git")).toThrow("Merge all code links");
    } finally { await ctx.fiber.dispose(); }
  });
  it("settles mixed-delivery links once the branch is deleted after merge and the other branch's ticket commits landed", async () => {
    const { codeLink, ctx, items, project, checkout, ticket } = await machine(codeRepo());
    try {
      const item = ticket("Ship code and guide", "todo");
      const named = `tom-${item.keyNum}/first`;
      commitOn(checkout, "side/work", "wip.ts", `${item.key}: wip`);
      git(["checkout", "-q", "-b", named, "side/work"], checkout);
      commitOn(checkout, named, "finish.ts", `${item.key}: finish`);
      commitOn(checkout, "side/work", "other.ts", "TOM-999: unrelated");
      git(["push", "-q", "origin", named, "side/work"], checkout);
      await codeLink.scan(project.id);
      expect(codeLink.links(project.id, item.id).map(l => l.branch).sort()).toEqual([named, "side/work"].sort());
      items.files({ async getVersion(_project, ref) { return ref; }, async describe() { return []; } });
      const updated = await items.addResource(project.id, item.id, { name: "Guide", role: "output", file: { fileId: "guide", versionId: "v1" } }, "human");
      items.submitDelivery(project.id, item.id, { report: "Code and guide", artifactIds: updated.evidence.resources.map(r => r.id) }, "human");
      expect(codeLink.links(project.id, item.id).some(l => !!l.mergedSha)).toBe(false);
      git(["checkout", "-q", "main"], checkout);
      git(["merge", "-q", "--no-ff", "-m", `Merge ${named}`, named], checkout);
      git(["push", "-q", "origin", "main", `:${named}`], checkout);
      git(["branch", "-q", "-D", named], checkout);
      await codeLink.scan(project.id);
      expect(codeLink.links(project.id, item.id).every(l => !!l.mergedSha)).toBe(true);
    } finally { await ctx.fiber.dispose(); }
  });
  it("finishes on merge when a branch renamed away with nothing on it was linked beside the real one", async () => {
    const { codeLink, ctx, items, project, checkout, ticket } = await machine(codeRepo());
    try {
      const item = ticket("Ship it", "todo");
      // first named wrongly, seen by a scan before a single commit, then renamed
      const stray = `someone/tom-${item.keyNum}`;
      git(["branch", stray, "main"], checkout);
      await codeLink.scan(project.id);
      expect(codeLink.links(project.id, item.id)).toEqual([expect.objectContaining({ branch: stray, ahead: 0, source: "scan" })]);
      git(["branch", "-q", "-D", stray], checkout);

      const real = `tom-${item.keyNum}/ship`;
      commitOn(checkout, real, "ship.ts", `${item.key}: ship`);
      git(["push", "-q", "origin", real], checkout);
      await codeLink.scan(project.id);
      expect(items.get(project.id, item.id)?.status).toBe("doing");

      // merged, and the branch deleted with it, as GitHub does
      git(["checkout", "-q", "main"], checkout);
      git(["merge", "-q", "--no-ff", "-m", `Merge ${real}`, real], checkout);
      git(["push", "-q", "origin", "main", `:${real}`], checkout);
      git(["branch", "-q", "-D", real], checkout);
      await codeLink.scan(project.id);
      expect(codeLink.links(project.id, item.id)).toEqual([expect.objectContaining({ branch: real, mergedSha: expect.any(String) })]);
      expect(items.get(project.id, item.id)?.status).toBe("done");
    } finally { await ctx.fiber.dispose(); }
  });
  it("still waits on a branch that had work of its own and never merged, even once it is gone", async () => {
    const { codeLink, ctx, items, project, checkout, ticket } = await machine(codeRepo());
    try {
      const item = ticket("Ship it", "todo");
      const real = `tom-${item.keyNum}/ship`;
      const other = `tom-${item.keyNum}/extra`;
      commitOn(checkout, real, "ship.ts", `${item.key}: ship`);
      commitOn(checkout, other, "extra.ts", `${item.key}: extra`);
      git(["push", "-q", "origin", real, other], checkout);
      await codeLink.scan(project.id);
      git(["checkout", "-q", "main"], checkout);
      git(["merge", "-q", "--no-ff", "-m", `Merge ${real}`, real], checkout);
      git(["push", "-q", "origin", "main", `:${real}`, `:${other}`], checkout);
      git(["branch", "-q", "-D", real, other], checkout);
      await codeLink.scan(project.id);
      expect(codeLink.links(project.id, item.id).map((l) => l.branch).sort()).toEqual([other, real].sort());
      expect(items.get(project.id, item.id)?.status).not.toBe("done");
    } finally { await ctx.fiber.dispose(); }
  });
  it("links a branch named after a ticket and moves the ticket to doing, then done on merge", async () => {
    const { codeLink, ctx, items, project, repo, checkout, ticket } = await machine(codeRepo());
    const item = ticket("Push notifications", "todo");
    const branch = `tom-${item.keyNum}/push`;
    const sha = commitOn(checkout, branch, "push.ts", `TOM-${item.keyNum}: push`);
    git(["push", "-q", "origin", branch], checkout);

    const first = await codeLink.scan(project.id);
    expect(first).toMatchObject({ repos: 1, scanned: 1, offline: 0, links: 1, changed: 1, proposals: 0 });
    const [link] = codeLink.links(project.id, item.id);
    expect(link).toMatchObject({ repoId: repo.id, branch, headSha: sha, ahead: 1, behind: 0, mergedSha: null, source: "scan" });
    expect(items.get(project.id, item.id)!.status).toBe("doing");
    expect(items.get(project.id, item.id)!.updatedBy).toBe("sync:git");
    expect(items.query({ projectId: project.id, filter: [{ field: "provenance", op: "in", values: ["sync"] }] }).map((i) => i.id)).toEqual([item.id]);
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual([{ id: "branch", label: "branch", tone: "neutral", title: branch }]);
    const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!;
    expect(section.rows.map((r) => r.label)).toEqual(["Branch", "Last commit"]);
    expect(section.rows[0].value).toContain(branch);

    // The repository is a project with a manifest and no CLAUDE.md yet.
    expect(codeLink.repoState(project.id, repo.id)).toMatchObject({ readiness: "scaffolded", remote: "ok", remoteDetail: null, remoteAt: expect.any(Number), hasBrief: false, manifests: ["package.json"] });

    git(["checkout", "-q", "main"], checkout);
    git(["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch], checkout);
    git(["push", "-q", "origin", "main"], checkout);
    const second = await codeLink.scan(project.id);
    expect(second.changed).toBe(1);
    expect(items.get(project.id, item.id)!.status).toBe("done");
    expect(codeLink.links(project.id, item.id)[0].mergedSha).toBeTruthy();
    expect((await ctx.contributions.badgesFor(project.id))[item.id]).toEqual([{ id: "merged", label: "merged", tone: "faint" }]);

    // Nothing left to say: a third scan is quiet.
    expect((await codeLink.scan(project.id)).changed).toBe(0);
  });

  it("discovers work started outside Tomrade from ticket keys in commits on an arbitrary branch", async () => {
    const { codeLink, items, project, repo, checkout, ticket } = await machine(codeRepo());
    const first = ticket("Manual work", "todo");
    const second = ticket("Paired work", "backlog");
    const branch = "feature/from-another-agent";
    commitOn(checkout, branch, "manual.ts", `${first.key}: started outside Tomrade\n\nAlso covers ${second.key}`);

    const summary = await codeLink.scan(project.id);

    expect(summary.changed).toBe(2);
    expect(items.get(project.id, first.id)!.status).toBe("doing");
    expect(items.get(project.id, second.id)!.status).toBe("doing");
    expect(codeLink.links(project.id, first.id)[0]).toMatchObject({ repoId: repo.id, branch, source: "scan", ahead: 1 });
    expect(codeLink.links(project.id, second.id)[0]).toMatchObject({ repoId: repo.id, branch, source: "scan", ahead: 1 });
  });

  it("does not mark a ticket done while its active session is on an uncommitted branch", async () => {
    const { codeLink, ctx, items, project, repo, checkout, ticket } = await machine(codeRepo());
    const item = ticket("Still working", "doing");
    const branch = `tom-${item.keyNum}/still-working`;
    git(["branch", branch, "main"], checkout);
    codeLink.store.createSession(project.id, {
      repoId: repo.id,
      branch,
      itemIds: [item.id],
      mode: "terminal",
      agent: "claude-code",
      threadId: null,
      device: "test"
    });

    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)!.status).toBe("doing");
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ branch, ahead: 0, behind: 0, mergedSha: null });
  });

  it("keeps a fresh branch unmerged after the default branch moves past it", async () => {
    const { codeLink, items, project, checkout, ticket } = await machine(codeRepo());
    const item = ticket("Fresh branch", "doing");
    const branch = `tom-${item.keyNum}/fresh`;
    git(["branch", branch, "main"], checkout);
    // A repository that also holds the project gets Tomrade's own data commit as soon as the ticket moves.
    commitOn(checkout, "main", "items.jsonl", "tomrade: write — 1 items");
    git(["push", "-q", "origin", "main"], checkout);

    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)!.status).toBe("doing");
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ branch, ahead: 0, behind: 1, mergedSha: null });
    expect(codeLink.deliveries(project.id, item.id).map((d) => [d.sequence, d.state])).toEqual([[1, "active"]]);

    commitOn(checkout, branch, "work.ts", `${item.key}: the work`);
    git(["checkout", "-q", "main"], checkout);
    git(["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch], checkout);
    git(["push", "-q", "origin", "main"], checkout);
    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)!.status).toBe("done");
  });

  it("reads a fast-forward merge from a head it saw ahead of the default branch", async () => {
    const { codeLink, items, project, checkout, ticket } = await machine(codeRepo());
    const item = ticket("Fast-forwarded", "doing");
    const branch = `tom-${item.keyNum}/ff`;
    commitOn(checkout, branch, "work.ts", "work without a key");
    await codeLink.scan(project.id);
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ branch, ahead: 1, mergedSha: null });

    git(["checkout", "-q", "main"], checkout);
    git(["merge", "-q", "--ff-only", branch], checkout);
    git(["push", "-q", "origin", "main"], checkout);
    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)!.status).toBe("done");
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ ahead: 0, behind: 0, mergedSha: expect.any(String) });
  });

  it("finishes a merged ticket while its terminal session is still active", async () => {
    const { codeLink, ctx, items, project, repo, checkout, ticket } = await machine(codeRepo());
    const item = ticket("Merge message while working", "verifying");
    const branch = `tom-${item.keyNum}/merge-message`;
    commitOn(checkout, branch, "work.ts", "work in progress");
    git(["checkout", "-q", "main"], checkout);
    git(["merge", "-q", "--squash", branch], checkout);
    git(["commit", "-q", "-m", `TOM-${item.keyNum}: squash merge`], checkout);
    git(["branch", "-q", "-D", branch], checkout);
    git(["push", "-q", "origin", "main"], checkout);
    codeLink.store.upsertLink(
      project.id,
      { itemId: item.id, repoId: repo.id, branch },
      { prNumber: 1, prUrl: "https://github.com/example/app/pull/1", prState: "open", source: "mcp" }
    );
    const session = codeLink.store.createSession(project.id, {
      repoId: repo.id,
      branch,
      itemIds: [item.id],
      mode: "terminal",
      agent: "claude-code",
      threadId: null,
      device: "test"
    });

    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)!.status).toBe("done");
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ mergedSha: expect.any(String), prState: "merged" });
    expect(ctx.items.get(project.id, item.id)!.updatedBy).toBe("sync:git");
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ id: session.id, state: "running" });

    // The process lifecycle is independent from delivery: ending it later is
    // still recorded, but it is not what makes the ticket Done.
    codeLink.sessions.event(project.id, session.id, { hook_event_name: "SessionEnd" });
    expect(codeLink.sessionsOf(project.id, item.id)[0]).toMatchObject({ id: session.id, state: "ended" });
    expect(items.get(project.id, item.id)!.status).toBe("done");
    expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ mergedSha: expect.any(String), prState: "merged" });
  });

  it("starts a new delivery when a done ticket is reopened, without old merge evidence completing it", async () => {
    const { codeLink, items, project, repo, checkout, ticket } = await machine(codeRepo());
    const item = ticket("Ship, then revise", "todo");
    const firstBranch = `tom-${item.keyNum}/ship`;
    commitOn(checkout, firstBranch, "ship.ts", `${item.key}: ship`);
    git(["checkout", "-q", "main"], checkout);
    git(["merge", "-q", "--no-ff", "-m", `Merge ${firstBranch}`, firstBranch], checkout);
    git(["push", "-q", "origin", "main"], checkout);

    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)!.status).toBe("done");
    expect(codeLink.deliveries(project.id, item.id).map((delivery) => [delivery.sequence, delivery.state])).toEqual([[1, "completed"]]);

    items.update(project.id, item.id, { status: "todo" }, "human");
    expect(codeLink.deliveries(project.id, item.id).map((delivery) => [delivery.sequence, delivery.state])).toEqual([
      [1, "completed"],
      [2, "active"]
    ]);
    const secondBranch = `tom-${item.keyNum}/revise-2`;
    // Losing the incremental scan cursor must not replay delivery 1 into 2.
    codeLink.store.upsertRepoState(project.id, repo.id, { scannedSha: null });
    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)!.status).toBe("todo");
    commitOn(checkout, secondBranch, "revise.ts", `${item.key}: revise`);
    git(["push", "-q", "origin", secondBranch], checkout);

    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)!.status).toBe("doing");
    expect(codeLink.links(project.id, item.id).map((link) => [link.branch, link.delivery])).toEqual([
      [firstBranch, 1],
      [secondBranch, 2]
    ]);

    git(["checkout", "-q", "main"], checkout);
    git(["merge", "-q", "--no-ff", "-m", `Merge ${secondBranch}`, secondBranch], checkout);
    git(["push", "-q", "origin", "main"], checkout);
    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)!.status).toBe("done");
    expect(codeLink.links(project.id, item.id).filter((link) => link.mergedSha).map((link) => link.delivery)).toEqual([1, 2]);
    expect(codeLink.deliveries(project.id, item.id).map((delivery) => [delivery.sequence, delivery.state])).toEqual([
      [1, "completed"],
      [2, "completed"]
    ]);
  });

  it("reads a squash merge from the default branch's message when the branch is already gone", async () => {
    const { codeLink, items, project, checkout, ticket } = await machine(codeRepo());
    const item = ticket("Squashed", "doing");
    const branch = `tom-${item.keyNum}/squash`;
    commitOn(checkout, branch, "a.ts", "work in progress");
    git(["checkout", "-q", "main"], checkout);
    git(["merge", "-q", "--squash", branch], checkout);
    git(["commit", "-q", "-m", `TOM-${item.keyNum}: squash merge`], checkout);
    git(["branch", "-q", "-D", branch], checkout);
    git(["push", "-q", "origin", "main"], checkout);

    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)!.status).toBe("done");
    const [link] = codeLink.links(project.id, item.id);
    expect(link.branch).toBe("");
    expect(link.mergedSha).toBe(git(["rev-parse", "HEAD"], checkout));
  });

  it.each(["done", "cancelled"] as const)("does not open another delivery when a %s ticket's branch is recreated from main", async (status) => {
    const { codeLink, ctx, items, project, checkout, ticket } = await machine(codeRepo());
    try {
      const item = ticket("Closed work", "todo");
      const branch = `tom-${item.keyNum}/work`;
      const originalSha = commitOn(checkout, branch, "work.ts", `${item.key}: work`);
      await codeLink.scan(project.id);
      if (status === "done") {
        git(["checkout", "-q", "main"], checkout);
        git(["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch], checkout);
        git(["push", "-q", "origin", "main"], checkout);
        await codeLink.scan(project.id);
      } else {
        items.update(project.id, item.id, { status }, "human");
      }
      const history = codeLink.links(project.id, item.id);
      const mainSha = commitOn(checkout, "main", "unrelated.ts", "Unrelated main change");
      git(["push", "-q", "origin", "main"], checkout);
      git(["branch", "-f", branch, "main"], checkout);
      expect(mainSha).not.toBe(originalSha);

      await codeLink.scan(project.id);
      await codeLink.scan(project.id);

      expect(items.get(project.id, item.id)!.status).toBe(status);
      expect(codeLink.deliveries(project.id, item.id).map(d => [d.sequence, d.state])).toEqual([[1, status === "done" ? "completed" : "cancelled"]]);
      expect(codeLink.links(project.id, item.id)).toEqual(history);
    } finally { await ctx.fiber.dispose(); }
  });

  it.each(["done", "cancelled"] as const)("ignores a newly discovered branch on a %s ticket without a delivery", async (status) => {
    const { codeLink, ctx, project, checkout, ticket } = await machine(codeRepo());
    try {
      const item = ticket("Already closed", status);
      commitOn(checkout, `tom-${item.keyNum}/work`, "work.ts", `${item.key}: unexpected work`);
      await codeLink.scan(project.id);
      expect(codeLink.links(project.id, item.id)).toEqual([]);
      expect(codeLink.deliveries(project.id, item.id)).toEqual([]);
    } finally { await ctx.fiber.dispose(); }
  });

  it.each(["done", "cancelled"] as const)("cancels an accidental scan-only delivery on a %s ticket and withdraws its proposals", async (status) => {
    const { codeLink, ctx, items, project, repo, checkout, ticket } = await machine(codeRepo());
    try {
      const item = ticket("Accidental delivery", status);
      codeLink.store.ensureActiveDelivery(project.id, item.id);
      codeLink.store.finishActiveDelivery(project.id, item.id, status === "done" ? "completed" : "cancelled");
      commitOn(checkout, "main", "unrelated.ts", "Unrelated main change");
      git(["push", "-q", "origin", "main"], checkout);
      const branch = `tom-${item.keyNum}/work`;
      git(["branch", branch, "main"], checkout);
      const accidental = codeLink.store.upsertLink(project.id, { itemId: item.id, repoId: repo.id, branch }, { source: "scan", headSha: git(["rev-parse", "main"], checkout), ahead: 0 });
      codeLink.store.addProposal(project.id, { itemId: item.id, delivery: accidental.delivery, linkId: accidental.id, kind: "flag", fromStatus: status, toStatus: null, reason: "Accidental scan", evidenceSha: accidental.headSha });

      await codeLink.scan(project.id);
      await codeLink.scan(project.id);

      expect(codeLink.deliveries(project.id, item.id)).toEqual([expect.objectContaining({ sequence: 1, state: status === "done" ? "completed" : "cancelled" }), expect.objectContaining({ sequence: 2, state: "cancelled", completedAt: expect.any(Number) })]);
      expect(codeLink.store.activeDelivery(project.id, item.id)).toBeNull();
      expect(codeLink.links(project.id, item.id)).toHaveLength(1);
      expect(codeLink.proposals(project.id, item.id)).toEqual([]);
      expect(codeLink.store.proposals(project.id, item.id, "any")[0].state).toBe("stale");
      const section = (await ctx.contributions.sectionsFor(project.id, item.id)).find(s => s.id === "code")!;
      expect(section.rows.find(row => row.label === "Delivery")?.value).toBe("#2 · cancelled");
      expect(items.get(project.id, item.id)!.status).toBe(status);

      items.update(project.id, item.id, { status: "todo" }, "human");
      commitOn(checkout, branch, "revision.ts", `${item.key}: reopened work`);
      await codeLink.scan(project.id);
      expect(codeLink.store.activeDelivery(project.id, item.id)?.sequence).toBe(3);
      expect(codeLink.links(project.id, item.id).at(-1)?.delivery).toBe(3);
    } finally { await ctx.fiber.dispose(); }
  });

  it("keeps closed tickets' deliveries with real evidence or an explicit link", async () => {
    const { codeLink, ctx, db, project, repo, ticket } = await machine(codeRepo());
    try {
      const patches = [
        { source: "manual" as const }, { source: "start" as const }, { source: "mcp" as const },
        { ahead: 1 }, { mergedSha: "merged" }, { prNumber: 191 }, { prUrl: "https://github.com/example/repo/pull/191" }, { prState: "open" as const }, { threadId: "thread" }
      ];
      const protectedItems = patches.map(patch => {
        const item = ticket("Has evidence", "cancelled");
        codeLink.store.upsertLink(project.id, { itemId: item.id, repoId: repo.id, branch: `missing-${item.keyNum}` }, patch);
        return item;
      });
      for (const evidence of ["session", "output", "submission"] as const) {
        const item = ticket(`Has ${evidence}`, "cancelled");
        codeLink.store.upsertLink(project.id, { itemId: item.id, repoId: repo.id, branch: `missing-${item.keyNum}` }, {});
        const active = codeLink.store.activeDelivery(project.id, item.id)!;
        if (evidence === "session") {
          const session = codeLink.store.createSession(project.id, { repoId: repo.id, branch: "missing", delivery: active.sequence, itemIds: [item.id], mode: "headless", agent: "codex", threadId: null, device: "test" });
          codeLink.store.patchSession(project.id, session.id, { state: "ended", endedAt: Date.now() });
        } else {
          const history = evidence === "output"
            ? { ...item.evidence, resources: [{ id: "output", name: "Guide", role: "output", deliveryId: active.id, file: { fileId: "guide", versionId: "v1" }, createdBy: "human", createdAt: 1 }] }
            : { ...item.evidence, submissions: [{ id: "submission", deliveryId: active.id, report: "Review me", artifactIds: [], submittedBy: "human", submittedAt: 1 }] };
          db.prepare("UPDATE items SET evidence_json = ? WHERE id = ?").run(JSON.stringify(history), item.id);
        }
        protectedItems.push(item);
      }
      await codeLink.scan(project.id);
      for (const item of protectedItems) expect(codeLink.store.activeDelivery(project.id, item.id)?.state).toBe("active");
    } finally { await ctx.fiber.dispose(); }
  });

  it.each(["todo", "doing"] as const)("opens a new delivery when completed work is reopened to %s", async (status) => {
    const { codeLink, ctx, items, project, checkout, ticket } = await machine(codeRepo());
    try {
      const item = ticket("Reopen work", "done");
      codeLink.store.ensureActiveDelivery(project.id, item.id);
      codeLink.store.finishActiveDelivery(project.id, item.id, "completed");
      const branch = `tom-${item.keyNum}/work`;
      git(["branch", branch, "main"], checkout);
      await codeLink.scan(project.id);
      items.update(project.id, item.id, { status }, "human");
      await codeLink.scan(project.id);
      expect(codeLink.deliveries(project.id, item.id).map(d => [d.sequence, d.state])).toEqual([[1, "completed"], [2, "active"]]);
      expect(codeLink.links(project.id, item.id)[0]).toMatchObject({ branch, delivery: 2 });
      expect(items.get(project.id, item.id)!.status).toBe(status);
    } finally { await ctx.fiber.dispose(); }
  });

  it.each([false, true])("waits for every linked repository before repairing a scan-only delivery (new commits: %s)", async (newCommits) => {
    const { codeLink, ctx, project, repo, checkout, ticket } = await machine(codeRepo());
    try {
      const second = codeRepo();
      const secondRepo = ctx.repos.create({ projectId: project.id, remote: second.remote });
      await ctx.repos.setCheckout(second.remote, second.checkout);
      const item = ticket("Cross-repository scan", "done");
      const branch = `tom-${item.keyNum}/work`;
      for (const [cwd, repoId] of [[checkout, repo.id], [second.checkout, secondRepo.id]]) {
        git(["branch", branch, "main"], cwd);
        codeLink.store.upsertLink(project.id, { itemId: item.id, repoId, branch }, { headSha: git(["rev-parse", "main"], cwd), source: "scan", ahead: 0 });
      }
      if (newCommits) commitOn(second.checkout, branch, "work.ts", `${item.key}: actual work`);

      await codeLink.scan(project.id);

      expect(codeLink.deliveries(project.id, item.id)[0].state).toBe(newCommits ? "active" : "cancelled");
      if (newCommits) expect(codeLink.links(project.id, item.id).find(link => link.repoId === secondRepo.id)?.ahead).toBe(1);
    } finally { await ctx.fiber.dispose(); }
  });

  it("flags a ticket that says done while its branch is unmerged, and lets a person settle it", async () => {
    const { codeLink, ctx, items, project, checkout, ticket } = await machine(codeRepo());
    const item = ticket("Claimed done", "doing");
    const branch = `tom-${item.keyNum}/early`;
    commitOn(checkout, branch, "b.ts", `TOM-${item.keyNum}`);
    await codeLink.scan(project.id);
    items.update(project.id, item.id, { status: "done" }, "human");

    const summary = await codeLink.scan(project.id);
    expect(summary.changed).toBe(0);
    expect(summary.proposals).toBe(2);
    expect(items.get(project.id, item.id)!.status).toBe("done");
    const open = codeLink.proposals(project.id, item.id);
    expect(open.map((p) => [p.kind, p.toStatus])).toEqual([
      ["flag", null],
      ["propose", "verifying"]
    ]);
    expect((await ctx.contributions.badgesFor(project.id))[item.id][0]).toMatchObject({ id: "mismatch", tone: "strong" });
    expect((await ctx.contributions.sectionsFor(project.id, item.id)).find((s) => s.id === "code")!.text).toContain("done, but the branch is not merged");

    // Asked again, nothing new is raised.
    expect((await codeLink.scan(project.id)).proposals).toBe(0);

    const proposal = open.find((p) => p.kind === "propose")!;
    codeLink.resolve(project.id, proposal.id, true);
    const after = items.get(project.id, item.id)!;
    expect(after.status).toBe("verifying");
    expect(after.updatedBy).toBe("human");
    // The flag no longer applies once the status matches the code.
    await codeLink.scan(project.id);
    expect(codeLink.proposals(project.id, item.id)).toEqual([]);
  });

  it("rejected once, the same proposal is not raised again for the same evidence", async () => {
    const { codeLink, items, project, checkout, ticket } = await machine(codeRepo());
    const item = ticket("Locked", "todo");
    items.update(project.id, item.id, { humanLocked: true }, "human");
    const branch = `tom-${item.keyNum}/locked`;
    commitOn(checkout, branch, "c.ts", "c");

    await codeLink.scan(project.id);
    expect(items.get(project.id, item.id)!.status).toBe("todo");
    const [proposal] = codeLink.proposals(project.id, item.id);
    expect(proposal).toMatchObject({ kind: "propose", toStatus: "doing" });
    codeLink.resolve(project.id, proposal.id, false);
    await codeLink.scan(project.id);
    expect(codeLink.proposals(project.id, item.id)).toEqual([]);

    // New evidence — another commit — asks again.
    commitOn(checkout, branch, "d.ts", "d");
    await codeLink.scan(project.id);
    expect(codeLink.proposals(project.id, item.id)).toHaveLength(1);
  });

  it("lists branches that name a ticket the project does not have, and accepts a branch linked by hand", async () => {
    const { codeLink, ctx, project, repo, checkout, ticket } = await machine(codeRepo());
    commitOn(checkout, "tom-999/orphan", "o.ts", "o");
    const item = ticket("Odd name", "todo");
    commitOn(checkout, "hotfix/odd", "h.ts", "h");

    await codeLink.scan(project.id);
    expect(codeLink.unlinked(project.id)).toMatchObject([{ repoId: repo.id, branch: "tom-999/orphan", keyNum: 999 }]);
    expect((await ctx.contributions.statusItems({ projectId: project.id })).find((s) => s.id === "code-link")!.text).toMatch(/1 unlinked/);
    expect(codeLink.links(project.id, item.id)).toEqual([]);

    codeLink.linkBranch(project.id, item.id, repo.id, "hotfix/odd");
    await codeLink.scan(project.id);
    const [link] = codeLink.links(project.id, item.id);
    expect(link).toMatchObject({ branch: "hotfix/odd", source: "manual", ahead: 1 });
    expect(ctx.items.get(project.id, item.id)!.status).toBe("doing");
  });

  it("calls a repository with no commits empty, and one without a manifest too", async () => {
    const empty = await machine(codeRepo({ empty: true }));
    await empty.codeLink.scan(empty.project.id);
    expect(empty.codeLink.repoState(empty.project.id, empty.repo.id)).toMatchObject({ readiness: "empty", manifests: [] });

    const bare = await machine(codeRepo({ manifest: false }));
    await bare.codeLink.scan(bare.project.id);
    expect(bare.codeLink.repoState(bare.project.id, bare.repo.id)).toMatchObject({ readiness: "empty", hasBrief: false });
  });

  it("calls a repository with code in it scaffolded, recognised build file or not", async () => {
    const commit = (checkout: string, files: Record<string, string>) => {
      for (const [file, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
        fs.writeFileSync(path.join(checkout, file), body);
      }
      git(["add", "-A"], checkout);
      git(["commit", "-q", "-m", "more"], checkout);
      git(["push", "-q", "origin", "HEAD:refs/heads/main"], checkout);
    };
    const notes = codeRepo({ manifest: false });
    commit(notes.checkout, { "docs/plan.md": "# plan\n", LICENSE: "MIT\n", ".github/workflows/ci.yml": "on: push\n" });
    const onlyNotes = await machine(notes);
    await onlyNotes.codeLink.scan(onlyNotes.project.id);
    expect(onlyNotes.codeLink.repoState(onlyNotes.project.id, onlyNotes.repo.id)).toMatchObject({ readiness: "empty" });

    const script = codeRepo({ manifest: false });
    commit(script.checkout, { "main.py": "print('hi')\n", "goods.db": "" });
    const loose = await machine(script);
    await loose.codeLink.scan(loose.project.id);
    expect(loose.codeLink.repoState(loose.project.id, loose.repo.id)).toMatchObject({ readiness: "scaffolded", manifests: [], summary: "2 files, no manifest · no CLAUDE.md" });

    const dotnet = codeRepo({ manifest: false });
    commit(dotnet.checkout, { "src/Goods/Goods.csproj": "<Project />\n" });
    const solution = await machine(dotnet);
    await solution.codeLink.scan(solution.project.id);
    expect(solution.codeLink.repoState(solution.project.id, solution.repo.id)).toMatchObject({ readiness: "scaffolded", manifests: ["src/Goods/Goods.csproj"] });
  });

  it("skips a repository this machine has no checkout of, and says so", async () => {
    const { codeLink, ctx, project } = await machine(codeRepo());
    const other = ctx.repos.create({ projectId: project.id, remote: "git@github.com:acme/elsewhere.git" });
    const summary = await codeLink.scan(project.id);
    expect(summary.skipped).toEqual([{ repoId: other.id, reason: "no checkout on this machine" }]);
    expect(codeLink.repoState(project.id, other.id)!.readiness).toBe("unknown");
  });
});
