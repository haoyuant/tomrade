/**
 * An agent's review over the real code link and the real Agent. The engines are stand-ins that keep what they were told
 * and under which mode, and do what a test scripts for them; git is not asked: the tip of a branch is what the test says.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { Context } from "cordis";
import { Agent, type Engine, type TurnIO, type TurnInput } from "@tomradex/agent";
import { ChangeReview, MAX_ROUNDS, type ReviewDraft } from "@tomradex/change-review";
import { CodeLink } from "@tomradex/code-link";
import { Contributions } from "@tomradex/contributions";
import GitHubAccount from "@tomradex/github";
import { Repos } from "@tomradex/repos";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { disposeFresh, fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-agent-review-"));
afterAll(async () => {
  await disposeFresh();
  fs.rmSync(root, { recursive: true, force: true });
});

interface Told {
  engine: string;
  threadId: string;
  text: string;
  mode: string | undefined;
  purpose: string;
  ticket: string | undefined;
}

type Script = (input: TurnInput, io: TurnIO) => void | Promise<void>;

let n = 0;
async function machine(opts: { engines?: string[]; prefs?: { autoReview?: boolean; autoHandBack?: boolean }; status?: "doing" | "verifying" } = {}) {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  fs.writeFileSync(path.join(hubDir, "settings.json"), JSON.stringify({ language: "en", ...(opts.prefs ? { changeReview: opts.prefs } : {}) }));
  const told: Told[] = [];
  const scripts = new Map<string, Script>();
  const engine = (id: string, over: Partial<Engine> = {}): Engine => ({
    id,
    title: id[0]!.toUpperCase() + id.slice(1),
    author: `ai:${id}`,
    capabilities: ["backlog", "code", "general"],
    permissionModes: { default: "acceptEdits", choices: [{ value: id === "writer" ? "plan" : "read-only", label: "Read" }, { value: "acceptEdits", label: "Edits" }] },
    available: async () => ({ ok: true }),
    async turn(input, io) {
      if (input.input.kind === "text") told.push({ engine: id, threadId: input.threadId, text: input.input.text, mode: input.permissionMode, purpose: input.purpose, ticket: input.ticket?.key });
      await scripts.get(id)?.(input, io);
      return { stop: "end" };
    },
    ...over
  });
  const all: Record<string, Engine> = {
    writer: engine("writer"),
    checker: engine("checker"),
    blunt: engine("blunt", { permissionModes: { default: "acceptEdits", choices: [{ value: "acceptEdits", label: "Edits" }] } }),
    away: engine("away", { available: async () => ({ ok: false, reason: "not signed in" }) }),
    paned: engine("paned", { terminal: { mode: "only" } })
  };
  const enginePlugin = {
    name: "review-engines",
    inject: ["agent"],
    apply: (ctx: Context) => {
      for (const id of opts.engines ?? ["writer", "checker"]) ctx.agent.engine(all[id]!);
    }
  };
  const bag = await fresh({
    hubDir,
    plugins: [
      Tools,
      [Settings, { path: path.join(hubDir, "settings.json") }],
      GitHubAccount,
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      [Repos, { gitBinary: "git" }],
      Contributions,
      Agent,
      enginePlugin,
      [CodeLink, { scanMs: 0, gitBinary: "git", defaultsPath: path.join(hubDir, "code-link.json") }],
      // Looks are asked for by the tests themselves.
      [ChangeReview, { autoDelayMs: 3_600_000 }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  const ctx = bag.ctx as Context;
  const projectId = bag.project.id;
  const repo = ctx.repos.create({ projectId, remote: "https://github.com/o/r" });
  const item = bag.items.create({ projectId, boardId: bag.board.id, title: "Round the totals", body: "## Acceptance\n- totals round half up", status: opts.status ?? "doing", workType: "coding", by: "human" });
  const link = ctx.codeLink.store.upsertLink(projectId, { itemId: item.id, repoId: repo.id, branch: "al-1/ticket" }, { source: "mcp", headSha: "c1" });
  // What git would say the branch's tip is; a test moves it.
  const tip = { sha: "c1" as string | null };
  (ctx.codeLink as unknown as { changes: unknown }).changes = async () => (tip.sha ? { head: tip.sha } : null);
  const moveTo = (sha: string) => {
    tip.sha = sha;
    ctx.codeLink.store.upsertLink(projectId, { itemId: item.id, repoId: repo.id, branch: link.branch }, { source: "mcp", headSha: sha });
  };
  /** The conversation that works the ticket in the background, with what it was told before any review. */
  const working = (agent = "writer") => {
    const thread = ctx.agent.newThread(projectId, agent, null, { itemId: item.id });
    const session = ctx.codeLink.store.createSession(projectId, { repoId: repo.id, delivery: link.delivery, branch: link.branch, itemIds: [item.id], mode: "headless", agent, threadId: thread.id, device: ctx.hub.deviceId });
    ctx.codeLink.store.patchSession(projectId, session.id, { state: "ended" });
    return { thread, session };
  };
  const draft = (over: Partial<ReviewDraft> = {}): ReviewDraft => ({ linkId: link.id, path: "src/a.ts", side: "new", line: 3, endLine: 3, quote: "const a = 1;", body: "Rounds down.", ...over });
  /** The reviewing engine leaves `count` findings each time it is asked to review. */
  const finds = (id: string, count: number) =>
    scripts.set(id, (input, io) => {
      if (input.input.kind !== "text" || !input.input.text.startsWith("<review-request")) return;
      if (count) ctx.changeReview.submitFindings(projectId, item.id, Array.from({ length: count }, (_, i) => ({ ...draft({ line: i + 1, endLine: i + 1 }), severity: "warning" as const })), { by: `ai:${id}`, run: { id: io.run.id, threadId: input.threadId } });
    });
  const setPrefs = (prefs: { autoReview?: boolean; autoHandBack?: boolean }) => ctx.settings.set({ ...ctx.settings.get(), changeReview: prefs });
  const over = (id: string) => until(() => ctx.changeReview.reviews(projectId, item.id).find((r) => r.id === id)?.state !== "running");
  return { ...bag, ctx, s: ctx.changeReview, projectId, repo, item, link, told, scripts, moveTo, tip, working, draft, finds, setPrefs, over };
}

async function until(check: () => boolean, timeout = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("names who can review: another engine than the one working the ticket, ready, with a mode that changes nothing", async () => {
  const t = await machine({ engines: ["writer", "checker", "blunt", "away", "paned"] });
  t.working("writer");
  const choices = await t.s.reviewers(t.projectId, t.item.id);
  expect(choices.author).toBe("writer");
  expect(choices.pick).toBe("checker");
  expect(choices.engines).toEqual([
    { id: "writer", title: "Writer", ok: true },
    { id: "checker", title: "Checker", ok: true },
    { id: "blunt", title: "Blunt", ok: false, why: "it has no read-only mode" },
    { id: "away", title: "Away", ok: false, why: "not signed in" },
    { id: "paned", title: "Paned", ok: false, why: "it runs only in a terminal" }
  ]);
  await t.ctx.fiber.dispose();

  const alone = await machine({ engines: ["writer", "blunt"] });
  alone.working("writer");
  expect((await alone.s.reviewers(alone.projectId, alone.item.id)).pick).toBe("writer");
  await alone.ctx.fiber.dispose();
});

it("reviews in a conversation of its own: read-only, told the ticket and nothing its author said, its findings unsent on the diff", async () => {
  const t = await machine();
  const { thread } = t.working("writer");
  t.ctx.agent.send(t.projectId, thread.id, { kind: "text", text: "my secret plan" });
  await until(() => t.told.length === 1);
  t.finds("checker", 2);

  const started = await t.s.review(t.projectId, t.item.id);
  expect(started).toMatchObject({ itemId: t.item.id, engine: "checker", engineTitle: "Checker", same: false, askedBy: "person", state: "running", findings: null, stale: false, heads: { [t.link.id]: { head: "c1", seen: "c1" } } });
  await t.over(started.id);

  const asked = t.told.find((told) => told.engine === "checker")!;
  // a conversation that implements nothing, under the engine's own read-only mode
  expect(asked).toMatchObject({ mode: "read-only", purpose: "backlog", ticket: undefined });
  expect(asked.threadId).not.toBe(thread.id);
  expect(t.ctx.agent.store.thread(t.projectId, asked.threadId)).toMatchObject({ itemId: null, title: `Review of ${t.item.key}`, permissionMode: "read-only" });
  // the ticket as its author was told it, the tools to read and report with, and none of the author's conversation
  expect(asked.text).toContain(`Ticket ${t.item.key}: Round the totals`);
  expect(asked.text).toContain("totals round half up");
  expect(asked.text).toContain("read_review_changes");
  expect(asked.text).toContain("submit_review_findings");
  expect(asked.text).not.toContain("my secret plan");
  expect(t.ctx.agent.store.messages(t.projectId, asked.threadId).some((m) => JSON.stringify(m).includes("my secret plan"))).toBe(false);

  const done = t.s.reviews(t.projectId, t.item.id);
  expect(done).toHaveLength(1);
  expect(done[0]).toMatchObject({ id: started.id, state: "done", findings: 2, handedAt: null, held: false, stale: false });
  const comments = t.s.comments(t.projectId, t.item.id);
  expect(comments).toHaveLength(2);
  expect(comments.every((c) => c.sentAt === null && c.finding?.reviewId === started.id && c.finding.reviewer === "ai:checker" && !c.stale)).toBe(true);
  // nothing reached the session working the ticket
  expect(t.told.filter((told) => told.engine === "writer")).toHaveLength(1);
  await t.ctx.fiber.dispose();
});

it("gives back the review already going instead of starting a second", async () => {
  const t = await machine();
  t.working("writer");
  let release = () => {};
  t.scripts.set("checker", () => new Promise<void>((resolve) => (release = resolve)));
  const first = await t.s.review(t.projectId, t.item.id);
  await until(() => t.told.length === 1);
  const again = await t.s.review(t.projectId, t.item.id, { engine: "writer" });
  expect(again.id).toBe(first.id);
  expect(t.told).toHaveLength(1);
  release();
  await t.over(first.id);
  await t.ctx.fiber.dispose();
});

it("reviews with the engine that wrote the change when no other is ready, and says so", async () => {
  const t = await machine({ engines: ["writer", "blunt"] });
  t.working("writer");
  const review = await t.s.review(t.projectId, t.item.id);
  expect(review).toMatchObject({ engine: "writer", same: true });
  await t.over(review.id);
  expect(t.told.at(-1)).toMatchObject({ engine: "writer", mode: "plan", purpose: "backlog" });
  await t.ctx.fiber.dispose();
});

it("starts no review without changes to read, or with an engine that cannot change nothing", async () => {
  const t = await machine({ engines: ["writer", "blunt"] });
  await expect(t.s.review(t.projectId, t.item.id, { engine: "blunt" })).rejects.toThrow("Blunt cannot review here: it has no read-only mode");
  t.tip.sha = null;
  await expect(t.s.review(t.projectId, t.item.id)).rejects.toThrow(`${t.item.key} has no changes here to review.`);
  expect(t.s.reviews(t.projectId, t.item.id)).toEqual([]);
  expect(t.told).toEqual([]);
  await t.ctx.fiber.dispose();

  const none = await machine({ engines: ["blunt"] });
  await expect(none.s.review(none.projectId, none.item.id)).rejects.toThrow("No coding agent here can review: Blunt: it has no read-only mode");
  await none.ctx.fiber.dispose();
});

it("takes no findings on a ticket from the session that works it", async () => {
  const t = await machine();
  const { thread } = t.working("writer");
  const finding = { ...t.draft(), severity: "error" as const };
  expect(() => t.s.submitFindings(t.projectId, t.item.id, [finding], { by: "ai:writer", run: { id: "r1", threadId: thread.id } })).toThrow(`This session works on ${t.item.key}, so it cannot review its own changes.`);
  expect(t.s.comments(t.projectId, t.item.id)).toEqual([]);
  // any other conversation may: a person asked it to
  const other = t.ctx.agent.newThread(t.projectId, "checker");
  expect(t.s.submitFindings(t.projectId, t.item.id, [finding], { by: "ai:checker", run: { id: "r2", threadId: other.id } })).toHaveLength(1);
  await t.ctx.fiber.dispose();
});

it("records a review that found nothing, and tells nobody", async () => {
  const t = await machine({ prefs: { autoHandBack: true } });
  t.working("writer");
  const review = await t.s.review(t.projectId, t.item.id);
  await t.over(review.id);
  expect(t.s.reviews(t.projectId, t.item.id)[0]).toMatchObject({ state: "done", findings: 0, handedAt: null, held: false });
  expect(t.told.filter((told) => told.engine === "writer")).toEqual([]);
  expect(t.s.notices()).toEqual([]);
  await t.ctx.fiber.dispose();
});

it("shows a review and its findings as of older code once the branch has moved", async () => {
  const t = await machine();
  t.working("writer");
  t.finds("checker", 1);
  // git is a commit ahead of what Tomrade last saw: the review reads the newer one
  t.tip.sha = "c2";
  const review = await t.s.review(t.projectId, t.item.id);
  await t.over(review.id);
  expect(t.s.reviews(t.projectId, t.item.id)[0]).toMatchObject({ heads: { [t.link.id]: { head: "c2", seen: "c1" } }, stale: false });
  // Tomrade catches up to the commit that was read
  t.moveTo("c2");
  expect(t.s.reviews(t.projectId, t.item.id)[0]!.stale).toBe(false);
  expect(t.s.comments(t.projectId, t.item.id)[0]!.stale).toBeUndefined();
  // a commit after the review
  t.moveTo("c3");
  expect(t.s.reviews(t.projectId, t.item.id)[0]!.stale).toBe(true);
  expect(t.s.comments(t.projectId, t.item.id)[0]!.stale).toBe(true);
  // a person's own comment never ages this way
  t.s.add(t.projectId, t.item.id, t.draft({ body: "Mine." }));
  expect(t.s.comments(t.projectId, t.item.id).map((c) => c.stale)).toEqual([true, undefined]);
  await t.ctx.fiber.dispose();
});

it("hands findings to the conversation working the ticket only where that is turned on, and never the person's own drafts", async () => {
  const t = await machine();
  t.working("writer");
  t.finds("checker", 1);
  const mine = t.s.add(t.projectId, t.item.id, t.draft({ body: "A draft of mine." }));
  const quiet = await t.s.review(t.projectId, t.item.id);
  await t.over(quiet.id);
  expect(t.told.filter((told) => told.engine === "writer")).toEqual([]);

  t.setPrefs({ autoHandBack: true });
  const loud = await t.s.review(t.projectId, t.item.id);
  await t.over(loud.id);
  await until(() => t.told.some((told) => told.engine === "writer"));
  const passed = t.told.filter((told) => told.engine === "writer");
  expect(passed).toHaveLength(1);
  expect(passed[0]!.text).toContain("found by a reviewing agent (warning)");
  expect(passed[0]!.text).not.toContain("A draft of mine.");
  await until(() => t.s.reviews(t.projectId, t.item.id)[0]!.handedAt !== null);
  const comments = t.s.comments(t.projectId, t.item.id);
  expect(comments.find((c) => c.id === mine.id)!.sentAt).toBeNull();
  // the second review's finding went; the first's, made while this was off, still waits on the person
  expect(comments.filter((c) => c.finding?.reviewId === loud.id).every((c) => c.sentAt !== null)).toBe(true);
  expect(comments.filter((c) => c.finding?.reviewId === quiet.id).every((c) => c.sentAt === null)).toBe(true);
  await t.ctx.fiber.dispose();
});

it("stops handing findings on after three rounds, and then they wait on the person", async () => {
  const t = await machine({ prefs: { autoHandBack: true } });
  t.working("writer");
  t.finds("checker", 1);
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const review = await t.s.review(t.projectId, t.item.id);
    await t.over(review.id);
    await until(() => t.s.reviews(t.projectId, t.item.id)[0]!.handedAt !== null);
    await until(() => t.told.filter((told) => told.engine === "writer").length === round);
  }
  expect(t.s.notices()).toEqual([]);

  const fourth = await t.s.review(t.projectId, t.item.id);
  await t.over(fourth.id);
  await until(() => t.s.reviews(t.projectId, t.item.id)[0]!.held);
  expect(t.s.reviews(t.projectId, t.item.id)[0]).toMatchObject({ id: fourth.id, findings: 1, handedAt: null, held: true });
  expect(t.told.filter((told) => told.engine === "writer")).toHaveLength(MAX_ROUNDS);
  expect(t.s.notices()).toEqual([{ key: fourth.id, projectId: t.projectId, itemId: t.item.id, threadId: fourth.threadId, agent: "checker", text: `The review of ${t.item.key} left 1 findings after 3 rounds with the agent. They wait for you.` }]);

  // the person sends them: nothing waits any more
  await t.s.send(t.projectId, t.item.id);
  expect(t.s.notices()).toEqual([]);
  expect(t.s.reviews(t.projectId, t.item.id)[0]!.held).toBe(false);
  await t.ctx.fiber.dispose();
});

it("holds findings for the person when no conversation works the ticket", async () => {
  const t = await machine({ prefs: { autoHandBack: true } });
  // nobody works the ticket here, so the first ready engine reviews
  t.finds("writer", 2);
  const review = await t.s.review(t.projectId, t.item.id);
  await t.over(review.id);
  await until(() => t.s.reviews(t.projectId, t.item.id)[0]!.held);
  expect(t.s.notices().map((notice) => notice.text)).toEqual([`The review of ${t.item.key} left 2 findings, and no session working the ticket could be told. They wait for you.`]);
  expect(t.s.comments(t.projectId, t.item.id).every((c) => c.sentAt === null)).toBe(true);
  t.s.release(t.projectId, t.item.id);
  expect(t.s.notices()).toEqual([]);
  await t.ctx.fiber.dispose();
});

it("reviews a delivered ticket by itself only where that is turned on, once per commit", async () => {
  const t = await machine({ status: "verifying" });
  await t.s.look(t.projectId);
  expect(t.s.reviews(t.projectId, t.item.id)).toEqual([]);

  t.setPrefs({ autoReview: true });
  await t.s.look(t.projectId);
  const [first] = t.s.reviews(t.projectId, t.item.id);
  expect(first).toMatchObject({ askedBy: "auto", engine: "writer" });
  await t.over(first!.id);
  // the same commit again: nothing
  await t.s.look(t.projectId);
  await t.s.look(t.projectId);
  expect(t.s.reviews(t.projectId, t.item.id)).toHaveLength(1);

  // while an agent is at the ticket, its next commit is not reviewed yet
  const { session } = t.working("writer");
  t.ctx.codeLink.store.patchSession(t.projectId, session.id, { state: "running" });
  t.moveTo("c2");
  await t.s.look(t.projectId);
  expect(t.s.reviews(t.projectId, t.item.id)).toHaveLength(1);
  t.ctx.codeLink.store.patchSession(t.projectId, session.id, { state: "ended" });
  await t.s.look(t.projectId);
  const reviews = t.s.reviews(t.projectId, t.item.id);
  expect(reviews).toHaveLength(2);
  expect(reviews[0]).toMatchObject({ askedBy: "auto", engine: "checker", heads: { [t.link.id]: { head: "c2", seen: "c2" } } });
  await t.over(reviews[0]!.id);
  await t.ctx.fiber.dispose();
});

it("reviews no ticket by itself that is not delivered", async () => {
  const t = await machine({ status: "doing", prefs: { autoReview: true } });
  await t.s.look(t.projectId);
  expect(t.s.reviews(t.projectId, t.item.id)).toEqual([]);
  expect(t.told).toEqual([]);
  await t.ctx.fiber.dispose();
});

it("starts no session after three rounds: the change then waits on the person", async () => {
  const t = await machine({ status: "verifying", prefs: { autoReview: true, autoHandBack: true } });
  t.working("writer");
  t.finds("checker", 1);
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    await t.s.look(t.projectId);
    await until(() => t.s.reviews(t.projectId, t.item.id).length === round);
    await t.over(t.s.reviews(t.projectId, t.item.id)[0]!.id);
    await until(() => t.s.reviews(t.projectId, t.item.id)[0]!.handedAt !== null);
    await until(() => t.told.filter((told) => told.engine === "writer").length === round);
    t.moveTo(`fix-${round}`);
  }
  const asked = t.told.length;
  await t.s.look(t.projectId);
  await t.s.look(t.projectId);
  expect(t.s.reviews(t.projectId, t.item.id)).toHaveLength(MAX_ROUNDS);
  expect(t.told).toHaveLength(asked);
  expect(t.s.notices().map((notice) => notice.text)).toEqual([`${t.item.key}: the reviewer and the agent have gone 3 rounds. Its changes wait for you.`]);
  await t.ctx.fiber.dispose();
});

it("ends a review the app closed under, and reviews that commit no second time by itself", async () => {
  const t = await machine({ status: "verifying", prefs: { autoReview: true } });
  const thread = t.ctx.agent.newThread(t.projectId, "checker", null, { title: "Review" });
  t.dbFor(t.projectId)
    .prepare("INSERT INTO plugin_changereview_reviews (id, project_id, item_id, delivery, engine, same, thread_id, heads, asked_by, started_at) VALUES ('left', ?, ?, ?, 'checker', 0, ?, ?, 'auto', 1)")
    .run(t.projectId, t.item.id, t.link.delivery, thread.id, JSON.stringify({ [t.link.id]: { head: "c1", seen: "c1" } }));
  expect(t.s.reviews(t.projectId, t.item.id)[0]!.state).toBe("running");
  t.ctx.emit("db/opened", t.projectId);
  expect(t.s.reviews(t.projectId, t.item.id)[0]).toMatchObject({ state: "failed", findings: 0, error: "Tomrade closed before the review ended." });
  await t.s.look(t.projectId);
  expect(t.s.reviews(t.projectId, t.item.id)).toHaveLength(1);
  expect(t.told).toEqual([]);
  await t.ctx.fiber.dispose();
});
