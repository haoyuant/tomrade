import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Service, type Context } from "cordis";
import { expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh } from "@tomradex/testkit";
import { PrFeedback, type PullReader } from "@tomradex/pr-feedback";

const URL_7 = "https://github.com/o/r/pull/7";

interface Session {
  id: string;
  itemIds: string[];
  mode: "headless" | "terminal";
  threadId: string | null;
  device: string;
  agent: string;
  startedAt: number;
  endedAt: number | null;
}

class FakeGitHub extends Service {
  static provide = "github";
  constructor(ctx: Context) {
    super(ctx, "github");
  }
  async token() {
    return "";
  }
}

class FakeRepos extends Service {
  static provide = "repos";
  constructor(ctx: Context) {
    super(ctx, "repos");
  }
  get() {
    return { remote: "https://github.com/o/r" };
  }
}

/** Stands for code link: the ticket's link and the session that worked it. */
class FakeCodeLink extends Service {
  static provide = "codeLink";
  links: { itemId: string; repoId: string; delivery: number; prUrl: string | null; prNumber: number | null }[] = [];
  list: Session[] = [];
  store = { openPulls: () => this.links, activeDelivery: () => ({ sequence: 1 }) };
  constructor(ctx: Context) {
    super(ctx, "codeLink");
  }
  sessionsOf(_projectId: string, itemId: string) {
    return this.list.filter((s) => s.itemIds.includes(itemId));
  }
}

class FakeAgent extends Service {
  static provide = "agent";
  sent: { threadId: string; text: string; requestId: string }[] = [];
  running: string[] = [];
  asking: string[] = [];
  refuse: string | null = null;
  ran: { startedAt: number; endedAt: number | null }[] = [];
  store = { runs: () => this.ran, pending: (_projectId: string, threadId: string) => (this.asking.includes(threadId) ? {} : null) };
  constructor(ctx: Context) {
    super(ctx, "agent");
  }
  activeRuns() {
    return this.running.map((id) => ({ thread: { id } }));
  }
  send(_projectId: string, threadId: string, input: { text: string }, delivery: { requestId: string }) {
    if (this.refuse) throw new Error(this.refuse);
    this.sent.push({ threadId, text: input.text, requestId: delivery.requestId });
    return { runId: "run" };
  }
}

/** GitHub as data, counting what was asked. */
class FakeReader implements PullReader {
  pull = { state: "open", head: { sha: "sha1" }, user: { login: "ann" }, updated_at: "t0" };
  comments: unknown[] = [];
  inline: unknown[] = [];
  reviews: unknown[] = [];
  runs: unknown[] = [];
  statuses: unknown[] = [];
  failing = false;
  asked: string[] = [];
  async read<T>(route: string, pick: (raw: unknown) => T): Promise<T> {
    this.asked.push(route);
    if (this.failing) throw new Error("offline");
    if (route.includes("/check-runs")) return pick({ check_runs: this.runs });
    if (route.includes("/status")) return pick({ statuses: this.statuses });
    if (route.includes("/issues/")) return pick(this.comments);
    if (route.includes("/reviews")) return pick(this.reviews);
    if (route.includes("/comments")) return pick(this.inline);
    return pick(this.pull);
  }
  /** What GitHub does to `updated_at` when anyone writes. */
  touch() {
    this.pull = { ...this.pull, updated_at: `t${Math.random()}` };
  }
}

async function boot(prefs: Record<string, unknown> = { enabled: true }, session: Partial<Session> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pr-feedback-"));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ prFeedback: prefs }));
  const f = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings.json") }], FakeGitHub, FakeRepos, FakeCodeLink, FakeAgent, [PrFeedback, { intervalMs: 3_600_000 }]] });
  const ctx = f.ctx as Context;
  const code = ctx.codeLink as unknown as FakeCodeLink;
  const agent = ctx.agent as unknown as FakeAgent;
  const reader = new FakeReader();
  ctx.prFeedback.reader = reader;
  const item = f.items.create({ projectId: f.project.id, boardId: f.board.id, title: "Ticket", status: "verifying", workType: "coding", by: "human" });
  code.links = [{ itemId: item.id, repoId: "repo", delivery: 1, prUrl: URL_7, prNumber: 7 }];
  code.list = [{ id: "s1", itemIds: [item.id], mode: "headless", threadId: "th1", device: f.hub.deviceId, agent: "claude-code", startedAt: Date.now() - 60_000, endedAt: null, ...session }];
  const s = ctx.prFeedback;
  // the first look sets where watching starts; what happens after it is news
  const watch = async () => s.look();
  const comment = (id: number, login: string, association = "NONE", extra: Record<string, unknown> = {}) => ({ id, user: { login, type: extra.type ?? "User" }, author_association: association, created_at: new Date(Date.now() + 1_000).toISOString(), html_url: `https://gh/c/${id}`, body: `words ${id}` });
  const failing = (name = "test") => ({ name, status: "completed", conclusion: "failure", html_url: `https://ci/${name}` });
  return { ...f, ctx, s, code, agent, reader, item, watch, comment, failing };
}

it("asks GitHub nothing while it is off", async () => {
  const { s, reader, agent } = await boot({ enabled: false });
  await s.look();
  expect(reader.asked).toEqual([]);
  expect(agent.sent).toEqual([]);
  expect(s.notices()).toEqual([]);
});

it("wakes the agent once every check has ended, naming what failed", async () => {
  const { s, watch, reader, agent, failing } = await boot();
  reader.runs = [{ name: "build", status: "in_progress", conclusion: null }];
  await watch();
  expect(agent.sent).toEqual([]);
  reader.runs = [{ name: "build", status: "in_progress", conclusion: null }, failing("test")];
  await s.look();
  expect(agent.sent).toEqual([]);
  reader.runs = [{ name: "build", status: "completed", conclusion: "success" }, failing("test")];
  await s.look();
  expect(agent.sent).toHaveLength(1);
  expect(agent.sent[0]!.threadId).toBe("th1");
  expect(agent.sent[0]!.text).toContain("test (failure) https://ci/test");
  await s.look();
  expect(agent.sent).toHaveLength(1);
});

it("hears CI of a new commit again, and stops looking at a commit it reported", async () => {
  const { s, watch, reader, agent, failing } = await boot();
  await watch();
  reader.runs = [failing()];
  await s.look();
  expect(agent.sent).toHaveLength(1);
  reader.asked = [];
  await s.look();
  expect(reader.asked.filter((route) => route.includes("/check-runs"))).toEqual([]);
  reader.pull = { ...reader.pull, head: { sha: "sha2" } };
  await s.look();
  expect(agent.sent).toHaveLength(2);
});

it("does not wake for what was already red when first seen", async () => {
  const { s, watch, reader, agent, failing } = await boot();
  reader.runs = [failing()];
  await watch();
  await s.look();
  expect(agent.sent).toEqual([]);
});

it("reads comments only when the pull request moved", async () => {
  const { s, watch, reader } = await boot();
  await watch();
  reader.asked = [];
  await s.look();
  expect(reader.asked.filter((route) => route.includes("comments") || route.includes("reviews"))).toEqual([]);
});

it("wakes for a person with access and only records a stranger", async () => {
  const { s, watch, reader, agent, comment } = await boot();
  await watch();
  reader.comments = [comment(1, "mallory", "NONE")];
  reader.touch();
  await s.look();
  expect(agent.sent).toEqual([]);
  reader.comments = [comment(1, "mallory", "NONE"), comment(2, "bob", "COLLABORATOR")];
  reader.touch();
  await s.look();
  expect(agent.sent).toHaveLength(1);
  expect(agent.sent[0]!.text).toContain("words 2");
  expect(agent.sent[0]!.text).not.toContain("words 1");
});

it("carries a review asking for changes and its inline comments in one wake, and skips an approval", async () => {
  const { s, watch, reader, agent, comment } = await boot();
  await watch();
  const at = new Date(Date.now() + 1_000).toISOString();
  reader.reviews = [
    { id: 1, state: "APPROVED", user: { login: "bob" }, author_association: "MEMBER", submitted_at: at, body: "fine" },
    { id: 2, state: "CHANGES_REQUESTED", user: { login: "bob" }, author_association: "MEMBER", submitted_at: at, body: "please change" }
  ];
  reader.inline = [{ ...comment(3, "bob", "MEMBER"), path: "src/a.ts" }];
  reader.touch();
  await s.look();
  expect(agent.sent).toHaveLength(1);
  expect(agent.sent[0]!.text).toContain("please change");
  expect(agent.sent[0]!.text).toContain("on src/a.ts");
  expect(agent.sent[0]!.text).not.toContain("fine");
});

it("does not wake the agent for what it wrote itself under the author's account", async () => {
  const { s, watch, reader, agent, comment } = await boot();
  await watch();
  agent.ran = [{ startedAt: Date.now() - 1_000, endedAt: null }];
  reader.comments = [comment(1, "ann", "OWNER")];
  reader.touch();
  await s.look();
  expect(agent.sent).toEqual([]);
});

it("does not repeat an event read again", async () => {
  const { s, watch, reader, agent, comment } = await boot();
  await watch();
  reader.comments = [comment(1, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  reader.touch();
  await s.look();
  expect(agent.sent).toHaveLength(1);
});

it("sends the same events under the same request id after a crash, so Agent takes them once", async () => {
  const { s, watch, reader, agent, comment, project, dbFor } = await boot();
  await watch();
  reader.comments = [comment(1, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  const first = agent.sent[0]!;
  // the app stopped after the send and before the event was marked
  dbFor(project.id).prepare("UPDATE plugin_prfeedback_events SET state = 'pending'").run();
  reader.comments = [comment(1, "bob", "MEMBER"), comment(2, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  expect(agent.sent[1]).toEqual(first);
});

it("waits for a turn or a question to end, and what came meanwhile goes along", async () => {
  const { s, watch, reader, agent, comment } = await boot();
  await watch();
  agent.running = ["th1"];
  reader.comments = [comment(1, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  agent.running = [];
  agent.asking = ["th1"];
  reader.comments = [comment(1, "bob", "MEMBER"), comment(2, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  expect(agent.sent).toEqual([]);
  agent.asking = [];
  await s.look();
  expect(agent.sent).toHaveLength(1);
  expect(agent.sent[0]!.text).toContain("words 1");
  expect(agent.sent[0]!.text).toContain("words 2");
});

it("stops at the wake limit and tells the person instead", async () => {
  const { s, watch, reader, agent, comment } = await boot({ enabled: true, maxWakes: 1 });
  await watch();
  reader.comments = [comment(1, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  reader.comments = [comment(1, "bob", "MEMBER"), comment(2, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  expect(agent.sent).toHaveLength(1);
  expect(s.notices()).toHaveLength(1);
  expect(s.notices()[0]!.text).toContain("#7");
});

it("gives an automated reviewer three rounds on a pull request", async () => {
  const { s, watch, reader, agent, comment } = await boot({ enabled: true, maxWakes: 50 });
  await watch();
  for (let n = 1; n <= 5; n++) {
    reader.comments = [...reader.comments, comment(n, "review[bot]", "NONE")];
    reader.touch();
    await s.look();
  }
  expect(agent.sent).toHaveLength(3);
});

it("only tells the person about a terminal session, and writes nothing to it", async () => {
  const { s, watch, reader, agent, comment, failing } = await boot({ enabled: true }, { mode: "terminal", threadId: null });
  await watch();
  reader.runs = [failing()];
  reader.comments = [comment(1, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  expect(agent.sent).toEqual([]);
  expect(s.notices().map((n) => n.sessionId)).toEqual(["s1"]);
});

it("does not wake the agent of a locked ticket", async () => {
  const { s, watch, reader, agent, comment, ctx, item, project } = await boot();
  await watch();
  const get = ctx.items.get.bind(ctx.items);
  vi.spyOn(ctx.items, "get").mockImplementation((projectId, id) => ({ ...get(projectId, id)!, humanLocked: true }));
  reader.comments = [comment(1, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  expect(agent.sent).toEqual([]);
  expect(s.notices().map((n) => [n.projectId, n.itemId])).toEqual([[project.id, item.id]]);
});

it("tells the person when an agent refuses, without failing the look", async () => {
  const { s, watch, reader, agent, comment } = await boot();
  await watch();
  agent.refuse = "archived";
  reader.comments = [comment(1, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  expect(s.notices()[0]!.text).toContain("archived");
});

it("leaves finished tickets, ended pull requests and other machines' sessions alone", async () => {
  const { s, watch, reader, agent, code, items, project, item, comment, failing } = await boot();
  await watch();
  reader.pull = { ...reader.pull, state: "closed" };
  reader.comments = [comment(1, "bob", "MEMBER")];
  reader.runs = [failing()];
  reader.touch();
  await s.look();
  expect(agent.sent).toEqual([]);

  reader.pull = { ...reader.pull, state: "open" };
  code.list = code.list.map((session) => ({ ...session, device: "elsewhere" }));
  reader.asked = [];
  await s.look();
  expect(reader.asked).toEqual([]);

  code.list = code.list.map((session) => ({ ...session, device: (s.ctx as Context).hub.deviceId }));
  items.update(project.id, item.id, { status: "done" }, "human");
  await s.look();
  expect(reader.asked).toEqual([]);
  expect(agent.sent).toEqual([]);
});

it("survives GitHub failing, and says so only when it keeps failing", async () => {
  const { s, watch, reader, agent } = await boot();
  await watch();
  reader.failing = true;
  await s.look();
  await s.look();
  expect(s.notices()).toEqual([]);
  await s.look();
  expect(s.notices()).toHaveLength(1);
  reader.failing = false;
  await s.look();
  expect(s.notices()).toEqual([]);
  expect(agent.sent).toEqual([]);
});

it("clears a notice when the branch moves or the switch goes off, and starts afresh when turned on again", async () => {
  const { s, ctx, watch, reader, agent, comment } = await boot({ enabled: true, maxWakes: 1 });
  await watch();
  reader.comments = [comment(1, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  reader.comments = [comment(1, "bob", "MEMBER"), comment(2, "bob", "MEMBER")];
  reader.touch();
  await s.look();
  expect(s.notices()).toHaveLength(1);
  reader.pull = { ...reader.pull, head: { sha: "sha2" } };
  await s.look();
  expect(s.notices()).toEqual([]);

  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, prFeedback: { enabled: false, maxWakes: 1, allowedLogins: "" } });
  ctx.settings.set({ ...settings, prFeedback: { enabled: true, maxWakes: 5, allowedLogins: "" } });
  await s.look();
  await s.look();
  expect(agent.sent).toHaveLength(1);
});
