/**
 * Comments over the real code link and the real Agent: a ticket's links and sessions are code link's own rows, the
 * conversation's agent is a stand-in engine that keeps what it was told, and the terminal is a stand-in backend that
 * keeps what was typed into its panes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { Service, type Context } from "cordis";
import { Agent, type Engine } from "@tomradex/agent";
import { ChangeReview, type ReviewComment, type ReviewDraft } from "@tomradex/change-review";
import { CodeLink } from "@tomradex/code-link";
import type { TerminalInput } from "@tomradex/contracts";
import { Contributions } from "@tomradex/contributions";
import GitHubAccount from "@tomradex/github";
import { Repos } from "@tomradex/repos";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { disposeFresh, fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-change-review-"));
afterAll(async () => {
  await disposeFresh();
  fs.rmSync(root, { recursive: true, force: true });
});

const PANE = "w1:p1";

/** A terminal backend with one pane, which keeps what is typed into it. */
class FakeTerminals extends Service {
  static provide = "terminals";
  readonly kind = "builtin" as const;
  typed: TerminalInput[] = [];
  takes = true;
  constructor(ctx: Context) {
    super(ctx, "terminals");
  }
  async bridge() {
    return { state: "ready" as const };
  }
  async installed() {
    return "1.0.0";
  }
  async serverGone() {
    return false;
  }
  async revive() {
    return "running" as const;
  }
  async launch() {
    return null;
  }
  async terminal(): Promise<never> {
    throw new Error("no streams here");
  }
  async closePane() {
    return true;
  }
  async paneAlive() {
    return true;
  }
  async panes() {
    return [{ paneId: PANE, agent: null, agentSession: null, status: "unknown" as const, title: null }];
  }
  async processes() {
    return [];
  }
  async prompt() {
    return false;
  }
  async sendInput(paneId: string, input: TerminalInput) {
    if (paneId !== PANE || !this.takes) return false;
    this.typed.push(input);
    return true;
  }
  async readTail() {
    return "";
  }
  onScroll() {
    return () => {};
  }
  async scrollTo() {
    return false;
  }
  onPane() {
    return () => {};
  }
  watch() {
    return () => {};
  }
  watching() {
    return [];
  }
}

let n = 0;
async function machine(opts: { terminals?: boolean; locale?: string } = {}) {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  fs.writeFileSync(path.join(hubDir, "settings.json"), JSON.stringify({ language: opts.locale ?? "en" }));
  const told: string[] = [];
  let refuse: string | null = null;
  const engine: Engine = {
    id: "listener",
    title: "Listener",
    author: "ai:listener",
    capabilities: ["backlog", "code", "general"],
    available: async () => ({ ok: true }),
    async turn(input) {
      if (input.input.kind === "text") told.push(input.input.text);
      return { stop: "end" };
    }
  };
  const enginePlugin = {
    name: "listener-engine",
    inject: ["agent"],
    apply: (ctx: Context) => {
      ctx.agent.engine(engine);
      ctx.on("agent/before-send", () => refuse ?? undefined);
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
      ...(opts.terminals === false ? [] : [FakeTerminals]),
      [CodeLink, { scanMs: 0, gitBinary: "git", defaultsPath: path.join(hubDir, "code-link.json") }],
      ChangeReview
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  const ctx = bag.ctx as Context;
  const projectId = bag.project.id;
  const repo = ctx.repos.create({ projectId, remote: "https://github.com/o/r" });
  const item = bag.items.create({ projectId, boardId: bag.board.id, title: "Ticket", status: "doing", workType: "coding", by: "human" });
  const link = ctx.codeLink.store.upsertLink(projectId, { itemId: item.id, repoId: repo.id, branch: "al-1/ticket" }, { source: "mcp" });
  const session = (mode: "headless" | "terminal", over: { threadId?: string | null; pane?: string | null; device?: string } = {}) => {
    const made = ctx.codeLink.store.createSession(projectId, { repoId: repo.id, delivery: link.delivery, branch: link.branch, itemIds: [item.id], mode, agent: "listener", threadId: over.threadId ?? null, device: over.device ?? ctx.hub.deviceId });
    return over.pane ? ctx.codeLink.store.patchSession(projectId, made.id, { herdrPane: over.pane }) : made;
  };
  const thread = () => ctx.agent.newThread(projectId, "listener", null, { itemId: item.id });
  const draft = (over: Partial<ReviewDraft> = {}): ReviewDraft => ({ linkId: link.id, path: "src/a.ts", side: "new", line: 3, endLine: 3, quote: "const a = 1;", body: "Rename this.", ...over });
  const terminals = ctx.get("terminals") as unknown as FakeTerminals | undefined;
  return { ...bag, ctx, s: ctx.changeReview, projectId, repo, item, link, session, thread, draft, told, terminals, refuseWith: (why: string | null) => (refuse = why) };
}

async function until(check: () => boolean, timeout = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("keeps a ticket's comments: added, edited, resolved, removed, and told to whoever listens", async () => {
  const t = await machine();
  const heard: string[] = [];
  t.ctx.on("changeReview/changed", (_projectId, itemId) => void heard.push(itemId));
  const first = t.s.add(t.projectId, t.item.id, t.draft({ body: "  Rename this.  " }));
  expect(first).toMatchObject({ itemId: t.item.id, linkId: t.link.id, path: "src/a.ts", side: "new", line: 3, endLine: 3, quote: "const a = 1;", body: "Rename this.", state: "open", sentAt: null });
  const second = t.s.add(t.projectId, t.item.id, t.draft({ path: "src/b.ts", side: "old", line: 4, endLine: 6, quote: "a\nb\nc", body: "Why?" }));
  expect(t.s.comments(t.projectId, t.item.id).map((c) => c.id)).toEqual([first.id, second.id]);

  expect(t.s.edit(t.projectId, first.id, { state: "resolved" })).toMatchObject({ state: "resolved", body: "Rename this." });
  expect(t.s.edit(t.projectId, first.id, { state: "open", body: "Rename it." })).toMatchObject({ state: "open", body: "Rename it." });
  expect(t.s.edit(t.projectId, "absent", { body: "x" })).toBeNull();
  expect(t.s.remove(t.projectId, second.id)).toBe(true);
  expect(t.s.remove(t.projectId, second.id)).toBe(false);
  expect(t.s.comments(t.projectId, t.item.id)).toHaveLength(1);
  expect(heard).toEqual([t.item.id, t.item.id, t.item.id, t.item.id, t.item.id]);

  expect(() => t.s.add(t.projectId, t.item.id, t.draft({ body: "  " }))).toThrow("A comment needs some words.");
  expect(() => t.s.edit(t.projectId, first.id, { body: "" })).toThrow("A comment needs some words.");
  expect(() => t.s.add(t.projectId, t.item.id, t.draft({ linkId: "absent" }))).toThrow("unknown code link");
  expect(() => t.s.add(t.projectId, t.item.id, t.draft({ line: 5, endLine: 4 }))).toThrow();
  expect(() => t.s.add(t.projectId, "absent", t.draft())).toThrow("unknown ticket");
  await t.ctx.fiber.dispose();
});

it("lists no comment whose ticket or code link is gone", async () => {
  const t = await machine();
  t.s.add(t.projectId, t.item.id, t.draft());
  const db = t.dbFor(t.projectId);
  db.prepare("UPDATE plugin_changereview_comments SET link_id = 'gone'").run();
  expect(t.s.comments(t.projectId, t.item.id)).toEqual([]);
  expect(await t.s.send(t.projectId, t.item.id)).toEqual({ sent: 0, to: null, text: "" });
  db.prepare("UPDATE plugin_changereview_comments SET link_id = ?, item_id = 'gone'").run(t.link.id);
  expect(t.s.comments(t.projectId, "gone")).toEqual([]);
  await t.ctx.fiber.dispose();
});

it("names where a send would go: the newest session on this machine, by what can reach it", async () => {
  const t = await machine();
  expect(t.s.target(t.projectId, t.item.id)).toEqual({ kind: "none" });
  // another machine's session is not this machine's to reach
  t.session("headless", { threadId: t.thread().id, device: "elsewhere" });
  expect(t.s.target(t.projectId, t.item.id)).toEqual({ kind: "none" });

  const background = t.session("headless", { threadId: t.thread().id });
  expect(t.s.target(t.projectId, t.item.id)).toEqual({ kind: "conversation", sessionId: background.id, agent: "listener", agentTitle: "Listener" });
  // its run over, its conversation still takes words
  t.ctx.codeLink.store.patchSession(t.projectId, background.id, { state: "ended" });
  expect(t.s.target(t.projectId, t.item.id)).toMatchObject({ kind: "conversation", sessionId: background.id });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const outside = t.session("terminal");
  // a terminal Tomrade cannot type into is the one at work: the older conversation is left alone
  expect(t.s.target(t.projectId, t.item.id)).toEqual({ kind: "none" });
  t.ctx.codeLink.store.patchSession(t.projectId, outside.id, { state: "ended" });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const pane = t.session("terminal", { pane: PANE });
  expect(t.s.target(t.projectId, t.item.id)).toEqual({ kind: "terminal", sessionId: pane.id, agent: "listener", agentTitle: "Listener" });
  await t.ctx.fiber.dispose();
});

it("sends open, unsent comments to a background session's conversation, in file then line order, once", async () => {
  const t = await machine();
  const threadId = t.thread().id;
  t.session("headless", { threadId });
  const late = t.s.add(t.projectId, t.item.id, t.draft({ path: "src/b.ts", line: 9, endLine: 9, quote: "nine", body: "Third." }));
  t.s.add(t.projectId, t.item.id, t.draft({ path: "src/a.ts", line: 20, endLine: 22, quote: "x\ny\nz", body: "Second." }));
  t.s.add(t.projectId, t.item.id, t.draft({ path: "src/a.ts", line: 3, body: "First." }));
  const resolved = t.s.add(t.projectId, t.item.id, t.draft({ body: "Never mind." }));
  t.s.edit(t.projectId, resolved.id, { state: "resolved" });

  const sent = await t.s.send(t.projectId, t.item.id);
  expect(sent).toMatchObject({ sent: 3, to: "conversation" });
  await until(() => t.told.length === 1);
  expect(t.told[0]).toBe(sent.text);
  expect(sent.text).toContain(`<review-comments ticket="${t.item.key}">`);
  expect(sent.text).not.toContain("Never mind.");
  const at = ["First.", "Second.", "Third."].map((words) => sent.text.indexOf(words));
  expect(at.every((index, i) => index > (at[i - 1] ?? 0))).toBe(true);
  expect(sent.text).toContain("src/a.ts, lines 20-22 (new side)\n> x\n> y\n> z\nSecond.");
  const receipt = t.dbFor(t.projectId).prepare("SELECT request_id, source_json FROM plugin_agent_inputs").get() as { request_id: string; source_json: string };
  expect(receipt.request_id).toMatch(/^change-review:/);
  expect(JSON.parse(receipt.source_json)).toEqual({ kind: "change-review" });

  const after = t.s.comments(t.projectId, t.item.id);
  expect(after.filter((c) => c.sentAt !== null).map((c) => c.body).sort()).toEqual(["First.", "Second.", "Third."]);
  expect(after.find((c) => c.id === resolved.id)?.sentAt).toBeNull();
  // nothing new: nothing is said twice
  await until(() => !t.ctx.agent.activeRuns().length);
  expect(await t.s.send(t.projectId, t.item.id)).toEqual({ sent: 0, to: null, text: "" });
  expect(t.told).toHaveLength(1);

  // new words on a sent comment wait to be sent again; a changed state does not
  expect(t.s.edit(t.projectId, late.id, { state: "resolved" })?.sentAt).not.toBeNull();
  expect(t.s.edit(t.projectId, late.id, { state: "open", body: "Third, again." })?.sentAt).toBeNull();
  expect(await t.s.send(t.projectId, t.item.id)).toMatchObject({ sent: 1, to: "conversation" });
  await until(() => t.told.length === 2);
  expect(t.told[1]).toContain("Third, again.");
  await until(() => !t.ctx.agent.activeRuns().length);
  await t.ctx.fiber.dispose();
});

it("tells a terminal session's agent in one line to read the comments from a file", async () => {
  const t = await machine();
  const session = t.session("terminal", { pane: PANE });
  t.s.add(t.projectId, t.item.id, t.draft({ body: "Line one.\nLine two." }));
  const sent = await t.s.send(t.projectId, t.item.id);
  expect(sent).toMatchObject({ sent: 1, to: "terminal" });
  const file = path.join(t.ctx.codeLink.sessionDir(session.id), "review.md");
  expect(fs.readFileSync(file, "utf8")).toBe(sent.text);
  expect(t.terminals!.typed).toEqual([{ text: `Tomrade: review comments on ${t.item.key} — read ${file} and address them.`, keys: ["enter"] }]);
  expect(t.terminals!.typed[0]!.text).not.toContain("\n");
  expect(t.s.comments(t.projectId, t.item.id)[0]!.sentAt).not.toBeNull();
  expect(t.told).toEqual([]);
  await t.ctx.fiber.dispose();
});

it("hands the text back, and counts the comments sent, when no session can be reached or none is asked for", async () => {
  const t = await machine();
  t.s.add(t.projectId, t.item.id, t.draft());
  const none = await t.s.send(t.projectId, t.item.id);
  expect(none).toMatchObject({ sent: 1, to: null });
  expect(none.text).toContain("Rename this.");
  expect(t.s.comments(t.projectId, t.item.id)[0]!.sentAt).not.toBeNull();

  t.session("terminal", { pane: PANE });
  t.s.add(t.projectId, t.item.id, t.draft({ line: 8, endLine: 8, body: "And this." }));
  const copied = await t.s.send(t.projectId, t.item.id, { deliver: false });
  expect(copied).toMatchObject({ sent: 1, to: null });
  expect(copied.text).toContain("And this.");
  expect(copied.text).not.toContain("Rename this.");
  expect(t.terminals!.typed).toEqual([]);
  await t.ctx.fiber.dispose();
});

it("leaves the comments unsent when the delivery fails, and says why in the person's language", async () => {
  const t = await machine({ locale: "zh" });
  const pane = t.session("terminal", { pane: PANE });
  t.s.add(t.projectId, t.item.id, t.draft());
  t.terminals!.takes = false;
  await expect(t.s.send(t.projectId, t.item.id)).rejects.toThrow("Listener 的终端没有接收评论，所以什么都没发出。");
  expect(t.s.comments(t.projectId, t.item.id)[0]!.sentAt).toBeNull();

  t.ctx.codeLink.store.patchSession(t.projectId, pane.id, { state: "ended" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  t.session("headless", { threadId: t.thread().id });
  t.refuseWith("its agent is busy elsewhere");
  await expect(t.s.send(t.projectId, t.item.id)).rejects.toThrow("评论没有送到 Listener：its agent is busy elsewhere");
  expect(t.s.comments(t.projectId, t.item.id)[0]!.sentAt).toBeNull();
  expect(t.told).toEqual([]);

  t.refuseWith(null);
  expect(await t.s.send(t.projectId, t.item.id)).toMatchObject({ sent: 1, to: "conversation" });
  await until(() => t.told.length === 1);
  await until(() => !t.ctx.agent.activeRuns().length);
  await t.ctx.fiber.dispose();
});

it("reaches no terminal without a backend that types", async () => {
  const t = await machine({ terminals: false });
  t.session("terminal", { pane: PANE });
  expect(t.s.target(t.projectId, t.item.id)).toEqual({ kind: "none" });
  await t.ctx.fiber.dispose();
});

it("keeps a reviewing agent's findings as comments it is named on, unsent, and all of them or none", async () => {
  const t = await machine();
  const inv = { by: "ai:reviewer" as const, projectId: t.projectId };
  const finding = (over: Partial<ReviewDraft> = {}) => ({ ...t.draft({ body: "  This can be null.  ", ...over }), severity: "warning" as const });
  const changed: string[] = [];
  t.ctx.on("changeReview/changed", (_projectId, itemId) => void changed.push(itemId));

  const kept = (await t.ctx.tools.execute("submit_review_findings", { key: t.item.key, findings: [finding(), finding({ line: 9, endLine: 9, body: "And this." })] }, inv)) as ReviewComment[];
  expect(kept).toMatchObject([
    { body: "This can be null.", finding: { reviewer: "ai:reviewer", severity: "warning" }, sentAt: null, state: "open" },
    { body: "And this.", line: 9, finding: { reviewer: "ai:reviewer", severity: "warning" } }
  ]);
  expect(changed).toEqual([t.item.id]);
  // A person's own comment is not a finding, and resolving a finding leaves it one.
  expect(t.s.add(t.projectId, t.item.id, t.draft()).finding).toBeUndefined();
  expect(t.s.edit(t.projectId, kept[0].id, { state: "resolved" })?.finding).toEqual(kept[0].finding);

  const before = t.s.comments(t.projectId, t.item.id).length;
  await expect(t.ctx.tools.execute("submit_review_findings", { key: t.item.key, findings: [finding(), finding({ linkId: "another-ticket's" })] }, inv)).rejects.toThrow("unknown code link");
  await expect(t.ctx.tools.execute("submit_review_findings", { key: "AL-999", findings: [finding()] }, inv)).rejects.toThrow("unknown ticket");
  expect(t.s.comments(t.projectId, t.item.id)).toHaveLength(before);

  // Passed on by the person, a finding reaches the ticket's agent as one.
  const sent = await t.s.send(t.projectId, t.item.id, { deliver: false });
  expect(sent.text).toContain("found by a reviewing agent (warning)");
  expect(sent.text).toContain("And this.");
  await t.ctx.fiber.dispose();
});
