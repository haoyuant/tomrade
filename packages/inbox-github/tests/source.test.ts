import { describe, expect, it } from "vitest";
import { Contributions } from "@tomradex/contributions";
import { Inbox, entryId, type InboxSource } from "@tomradex/inbox";
import { commentFor, githubRepo, githubSource, kindOf, type Api, type Issue, type LandedLink } from "@tomradex/inbox-github";
import { fresh, settle } from "@tomradex/testkit";

const REPO = "acme/app";
const T0 = Date.parse("2026-10-01T00:00:00Z");

const issue = (number: number, extra: Partial<Issue> = {}): Issue => ({
  number,
  title: `Issue ${number}`,
  body: "Steps to reproduce…",
  html_url: `https://github.com/${REPO}/issues/${number}`,
  user: { login: "reporter" },
  labels: [],
  state: "open",
  created_at: new Date(T0 + number * 60_000).toISOString(),
  ...extra
});

/** GitHub as far as the source asks it: routes answered from plain arrays, writes recorded. */
function fakeGitHub() {
  const state = {
    issues: [] as Issue[],
    comments: [] as { issue_url: string; user: { login: string }; created_at: string }[],
    events: [] as { event: string; actor: { login: string }; created_at: string; issue: { number: number } }[],
    releases: [] as { tag_name: string; draft: boolean; prerelease: boolean; published_at: string }[],
    /** tag → the commits it contains */
    tags: new Map<string, string[]>(),
    writes: [] as { method: string; route: string; body: unknown }[],
    refuse: 0
  };
  const api: Api = {
    whoami: async () => "Maintainer",
    async request<T>(method: string, route: string, body?: unknown): Promise<T> {
      const [path, query = ""] = route.split("?");
      const q = new URLSearchParams(query);
      if (state.refuse) throw Object.assign(new Error("Resource not accessible by integration"), { status: state.refuse });
      if (method !== "GET") {
        state.writes.push({ method, route, body });
        return undefined as T;
      }
      const page = Number(q.get("page") ?? 1);
      const paged = <X>(xs: X[]) => (page === 1 ? xs : []) as T;
      if (path === `/repos/${REPO}/issues`) return paged(state.issues.filter((i) => q.get("state") !== "open" || i.state === "open"));
      if (path === `/repos/${REPO}/issues/comments`) return paged(state.comments.filter((c) => Date.parse(c.created_at) >= Date.parse(q.get("since")!)));
      if (path === `/repos/${REPO}/issues/events`) return paged([...state.events].reverse());
      if (path === `/repos/${REPO}/releases`) return paged(state.releases);
      const compare = /^\/repos\/acme\/app\/compare\/(\w+)\.\.\.(.+)$/.exec(path!);
      if (compare) return { status: state.tags.get(decodeURIComponent(compare[2]!))?.includes(compare[1]!) ? "ahead" : "behind" } as T;
      if (path === `/repos/${REPO}/pulls/7`) return { merge_commit_sha: "abc123" } as T;
      throw Object.assign(new Error(`${route} not found`), { status: 404 });
    }
  };
  return { api, state };
}

async function boot() {
  const f = await fresh({ plugins: [Contributions, [Inbox, { pullMs: 3_600_000 }]] });
  const gh = fakeGitHub();
  let connected = true;
  const links: LandedLink[] = [];
  const source: InboxSource = githubSource({
    api: gh.api,
    inbox: f.ctx.inbox,
    repos: async () => new Map([["repo-1", REPO]]),
    item: (projectId, itemId) => f.items.get(projectId, itemId),
    links: () => links,
    connected: async () => connected,
    words: () => ({
      source: "GitHub issues",
      connect: "Connect GitHub",
      noRepo: "No GitHub repository",
      noAccess: (repo: string) => `No access to ${repo}`,
      comment: "Comment",
      commentHelp: "",
      close: "Close",
      closeHelp: ""
    })
  });
  f.ctx.inbox.source(source);
  await settle();
  return { ...f, ...gh, inbox: f.ctx.inbox, p: f.project.id, links, disconnect: () => (connected = false) };
}

const id = (n: number) => entryId("github", `${REPO}#${n}`);

describe("reading GitHub", () => {
  it("finds the GitHub repository behind any spelling of its remote", async () => {
    const alias = async (host: string) => (host === "github.com-work" ? "github.com" : host);
    expect(await githubRepo("git@github.com:acme/app.git", alias)).toBe("acme/app");
    expect(await githubRepo("https://github.com/Acme/App", alias)).toBe("acme/app");
    expect(await githubRepo("git@github.com-work:acme/app.git", alias)).toBe("acme/app");
    expect(await githubRepo("git@gitlab.com:acme/app.git", alias)).toBeNull();
    expect(await githubRepo("/Users/me/app", alias)).toBeNull();
  });

  it("reads the kind from labels", () => {
    expect(kindOf(["bug"])).toBe("bug");
    expect(kindOf([{ name: "Type: Bug" }])).toBe("bug");
    expect(kindOf([{ name: "enhancement" }])).toBe("idea");
    expect(kindOf([{ name: "question" }])).toBe("feedback");
  });

  it("points a duplicate at its main issue", () => {
    const dup = (externalId: string) => commentFor({ state: "closed", reason: "duplicate", duplicateOf: { externalId, url: null } }, REPO);
    expect(dup("acme/app#3")).toBe("Duplicate of #3");
    expect(dup("acme/lib#3")).toBe("Duplicate of acme/lib#3");
    expect(commentFor({ state: "closed", reason: "duplicate", duplicateOf: { externalId: "R-ABCDEF", url: "https://x/r" } }, REPO)).toBe("Duplicate of https://x/r");
  });
});

describe("the GitHub inbox source", () => {
  it("says why it cannot pull", async () => {
    const t = await boot();
    t.disconnect();
    await t.inbox.setSource(t.p, "github", true);
    expect((await t.inbox.sources(t.p))[0]).toMatchObject({ unavailable: "Connect GitHub" });
  });

  it("brings in open issues once, leaves pull requests and closed ones out, and says when GitHub refuses", async () => {
    const t = await boot();
    t.state.issues.push(issue(1, { labels: ["bug"] }), issue(2, { pull_request: {} }), issue(3, { state: "closed" }));
    await t.inbox.setSource(t.p, "github", true);
    expect(t.inbox.list(t.p).map((e) => [e.externalId, e.kind, e.reporter])).toEqual([[`${REPO}#1`, "bug", "reporter"]]);
    expect(await t.inbox.refresh(t.p)).toBe(0);

    t.state.refuse = 403;
    await t.inbox.refresh(t.p);
    expect((await t.inbox.sources(t.p))[0]!.error).toBe(`No access to ${REPO}`);
  });

  it("comments on triage, and closes only once the project allows it", async () => {
    const t = await boot();
    t.state.issues.push(issue(1), issue(2), issue(3));
    await t.inbox.setSource(t.p, "github", true);
    const { item } = await t.inbox.accept(t.p, id(1));
    await t.inbox.close(t.p, id(2), "duplicate", id(1));
    await t.inbox.flush(t.p);
    expect(t.state.writes).toEqual([
      { method: "POST", route: `/repos/${REPO}/issues/1/comments`, body: { body: `Thanks for reporting this — it is now tracked as ${item.key}: Issue 1.` } },
      { method: "POST", route: `/repos/${REPO}/issues/2/comments`, body: { body: "Duplicate of #1" } }
    ]);

    t.state.writes.length = 0;
    await t.inbox.setSourceOption(t.p, "github", "close", true);
    await t.inbox.close(t.p, id(3), "wontfix");
    await t.inbox.flush(t.p);
    expect(t.state.writes.map((w) => [w.method, w.route, w.body])).toEqual([
      ["PATCH", `/repos/${REPO}/issues/3`, { state: "closed", state_reason: "not_planned" }],
      ["POST", `/repos/${REPO}/issues/3/comments`, { body: expect.stringContaining("don't plan") }]
    ]);

    t.state.writes.length = 0;
    await t.inbox.reply(t.p, id(1), "Can you share the log?");
    expect(t.state.writes).toEqual([{ method: "POST", route: `/repos/${REPO}/issues/1/comments`, body: { body: "Can you share the log?" } }]);
  });

  it("says which release fixed it once the ticket's merge is in one, and closes it as completed", async () => {
    const t = await boot();
    t.state.issues.push(issue(1));
    await t.inbox.setSource(t.p, "github", true);
    await t.inbox.setSourceOption(t.p, "github", "close", true);
    const { item } = await t.inbox.accept(t.p, id(1));
    t.links.push({ repoId: "repo-1", mergedSha: "def456", prNumber: 7, prState: "merged" });
    t.state.releases.push({ tag_name: "v1.0.0", draft: false, prerelease: false, published_at: "2026-09-01T00:00:00Z" });
    t.state.tags.set("v1.0.0", []);
    await t.inbox.flush(t.p);
    t.state.writes.length = 0;

    // merged but not done, then done but in no release yet
    await t.inbox.refresh(t.p);
    t.items.update(t.p, item.id, { status: "done" }, "human");
    await t.inbox.refresh(t.p);
    expect(t.inbox.get(t.p, id(1))!.shippedIn).toBeNull();

    // the pull request's merge commit is in v1.2.0 and later; the earliest is named
    t.state.releases.unshift(
      { tag_name: "v1.3.0", draft: false, prerelease: false, published_at: "2026-10-10T00:00:00Z" },
      { tag_name: "v1.3.0-rc.1", draft: false, prerelease: true, published_at: "2026-10-09T00:00:00Z" },
      { tag_name: "v1.2.0", draft: false, prerelease: false, published_at: "2026-10-05T00:00:00Z" }
    );
    t.state.tags.set("v1.3.0", ["abc123"]);
    t.state.tags.set("v1.2.0", ["abc123"]);
    await t.inbox.refresh(t.p);
    await t.inbox.flush(t.p);
    expect(t.inbox.get(t.p, id(1))!.shippedIn).toBe("v1.2.0");
    expect(t.state.writes.map((w) => [w.method, w.route, w.body])).toEqual([
      ["PATCH", `/repos/${REPO}/issues/1`, { state: "closed", state_reason: "completed" }],
      ["POST", `/repos/${REPO}/issues/1/comments`, { body: "Fixed in v1.2.0." }]
    ]);
  });

  it("marks a triaged issue when someone else comments or reopens it, and leaves it at that", async () => {
    const t = await boot();
    t.state.issues.push(issue(1), issue(2));
    await t.inbox.setSource(t.p, "github", true);
    await t.inbox.accept(t.p, id(1));
    await t.inbox.close(t.p, id(2), "wontfix");
    await t.inbox.flush(t.p);
    t.state.writes.length = 0;

    const soon = new Date(Date.now() + 1_000).toISOString();
    t.state.comments.push({ issue_url: `https://api.github.com/repos/${REPO}/issues/1`, user: { login: "maintainer" }, created_at: soon });
    await t.inbox.refresh(t.p);
    expect(t.inbox.list(t.p, "activity")).toEqual([]);

    t.state.comments.push({ issue_url: `https://api.github.com/repos/${REPO}/issues/1`, user: { login: "reporter" }, created_at: soon });
    t.state.events.push({ event: "reopened", actor: { login: "reporter" }, created_at: soon, issue: { number: 2 } });
    await t.inbox.refresh(t.p);
    expect(t.inbox.list(t.p, "activity").map((e) => [e.id, e.status])).toEqual([
      [id(1), "accepted"],
      [id(2), "closed"]
    ]);
    expect(t.state.writes).toEqual([]);
  });
});
