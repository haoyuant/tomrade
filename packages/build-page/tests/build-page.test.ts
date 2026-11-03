import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Service, type Context } from "cordis";
import { describe, expect, it, onTestFinished } from "vitest";
import { BuildPage, candidates, content, GENERATOR, publishPages, renderPage, type Api, type Candidate } from "@tomradex/build-page";
import { Contributions } from "@tomradex/contributions";
import type { Item } from "@tomradex/domain";
import { Inbox } from "@tomradex/inbox";
import { githubSource, type Issue } from "@tomradex/inbox-github";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { BUILD_PAGE_WORDS } from "../src/words.js";

const REPO = "acme/app";
const w = BUILD_PAGE_WORDS("en");
const T0 = Date.parse("2026-10-20T12:00:00Z");

/** GitHub's git data, pages and issues routes over plain maps; every write is recorded. */
function fakeGitHub() {
  const state = {
    blobs: new Map<string, string>(),
    trees: new Map<string, { base: string | null; entries: { path: string; sha: string }[] }>(),
    commits: new Map<string, { tree: string; parents: string[] }>(),
    refs: new Map<string, string>(),
    pages: null as null | { html_url: string; build_type?: string; source: { branch: string; path: string } },
    issues: [] as Issue[],
    writes: [] as { method: string; route: string; body: unknown }[]
  };
  let n = 0;
  const sha = (kind: string) => `${kind}${++n}`;
  const notFound = (route: string) => Object.assign(new Error(`${route} not found`), { status: 404 });
  /** The file at `file` in a commit's tree, following base trees. */
  const fileAt = (commit: string, file: string): string | null => {
    let tree: string | null = state.commits.get(commit)!.tree;
    while (tree) {
      const t = state.trees.get(tree)!;
      const hit = t.entries.find((e) => e.path === file);
      if (hit) return state.blobs.get(hit.sha)!;
      tree = t.base;
    }
    return null;
  };
  const api: Api & { whoami(): Promise<string> } = {
    whoami: async () => "maintainer",
    async request<T>(method: string, route: string, body?: unknown): Promise<T> {
      const b = body as Record<string, any>;
      const [p, query = ""] = route.split("?");
      const q = new URLSearchParams(query);
      if (method !== "GET") state.writes.push({ method, route, body });
      const base = `/repos/${REPO}`;
      if (method === "GET" && p === `${base}/git/ref/heads/gh-pages`) {
        const head = state.refs.get("gh-pages");
        if (!head) throw notFound(route);
        return { object: { sha: head } } as T;
      }
      if (method === "GET" && p === `${base}/contents/index.html`) {
        const head = state.refs.get(q.get("ref")!);
        const text = head ? fileAt(head, "index.html") : null;
        if (text === null) throw notFound(route);
        return { content: Buffer.from(text).toString("base64"), encoding: "base64" } as T;
      }
      const commit = /\/git\/commits\/(\w+)$/.exec(p!);
      if (method === "GET" && commit) return { tree: { sha: state.commits.get(commit[1]!)!.tree } } as T;
      if (method === "POST" && p === `${base}/git/blobs`) {
        const id = sha("blob");
        state.blobs.set(id, Buffer.from(b.content, "base64").toString("utf8"));
        return { sha: id } as T;
      }
      if (method === "POST" && p === `${base}/git/trees`) {
        const id = sha("tree");
        state.trees.set(id, { base: b.base_tree ?? null, entries: b.tree });
        return { sha: id } as T;
      }
      if (method === "POST" && p === `${base}/git/commits`) {
        const id = sha("commit");
        state.commits.set(id, { tree: b.tree, parents: b.parents });
        return { sha: id } as T;
      }
      if (method === "POST" && p === `${base}/git/refs`) {
        state.refs.set(b.ref.replace("refs/heads/", ""), b.sha);
        return {} as T;
      }
      if (method === "PATCH" && p === `${base}/git/refs/heads/gh-pages`) {
        state.refs.set("gh-pages", b.sha);
        return {} as T;
      }
      if (p === `${base}/pages`) {
        if (method === "POST") {
          state.pages = { html_url: "https://acme.github.io/app/", source: b.source };
          return state.pages as T;
        }
        if (!state.pages) throw notFound(route);
        return state.pages as T;
      }
      if (method === "GET" && p === `${base}/issues`) return (Number(q.get("page") ?? 1) === 1 ? state.issues.filter((i) => i.state === "open") : []) as T;
      if (method === "GET" && (p === `${base}/issues/comments` || p === `${base}/issues/events`)) return [] as T;
      throw notFound(route);
    }
  };
  /** What a reader of the published page sees. */
  const live = () => fileAt(state.refs.get("gh-pages")!, "index.html");
  return { api, state, live };
}

const item = (over: Partial<Item>): Item =>
  ({ id: over.key!, key: "X-1", title: "t", kind: "ticket", status: "todo", body: null, labels: [], blocks: [], blockedBy: [], fields: {}, ...over }) as Item;

describe("what may go on the page", () => {
  const items = [
    item({ key: "A-1", title: "Dark mode", status: "doing" }),
    item({ key: "A-2", title: "Export to CSV", status: "todo" }),
    item({ key: "A-3", title: "Fix login", status: "done" }),
    item({ key: "A-4", title: "Done without code", status: "done" }),
    item({ key: "A-5", title: "Dropped", status: "cancelled" }),
    item({ key: "A-6", title: "An epic", kind: "epic", status: "todo" })
  ];
  const merged = new Map([["A-3", T0]]);

  it("offers open tickets for the roadmap and merged ones for the changelog", () => {
    expect(candidates(items, merged).map((c) => [c.key, c.section])).toEqual([
      ["A-1", "roadmap"],
      ["A-2", "roadmap"],
      ["A-3", "changelog"]
    ]);
  });

  it("puts only ticked tickets on the page, and only their titles", () => {
    const offered: Candidate[] = candidates(items, merged);
    const html = renderPage(content({ repo: REPO, title: "Acme", footer: true, picks: ["A-1", "A-3"] }, offered, "en", T0, w), w);
    expect(html).toContain("Dark mode");
    expect(html).toContain("Fix login");
    expect(html).not.toContain("Export to CSV");
    expect(html).not.toContain("A-1");
    expect(html).toContain(`content="${GENERATOR}"`);
  });

  it("publishes nothing ticked by default, and the footer can be turned off", () => {
    const offered = candidates(items, merged);
    const none = renderPage(content({ repo: REPO, title: "Acme", footer: false, picks: [] }, offered, "en", T0, w), w);
    for (const c of offered) expect(none).not.toContain(c.title);
    expect(none).not.toContain("Built with");
    expect(renderPage(content({ repo: REPO, title: "Acme", footer: true, picks: [] }, offered, "en", T0, w), w)).toContain("Built with");
  });

  it("escapes titles and points feedback at a new issue in the repository", () => {
    const offered = candidates([item({ key: "B-1", title: `<script>alert("x")</script>` })], new Map());
    const html = renderPage(content({ repo: REPO, title: "A & B", footer: true, picks: ["B-1"] }, offered, "en", T0, w), w);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain(`href="https://github.com/${REPO}/issues/new?`);
  });
});

describe("publishing to GitHub Pages", () => {
  it("makes the gh-pages branch and turns Pages on", async () => {
    const gh = fakeGitHub();
    const out = await publishPages(gh.api, REPO, { "index.html": `<meta name="generator" content="${GENERATOR}">one`, ".nojekyll": "" }, "m");
    expect(out).toMatchObject({ ok: true, pages: "enabled", url: "https://acme.github.io/app/" });
    expect(gh.live()).toContain("one");
    expect(gh.state.pages?.source).toEqual({ branch: "gh-pages", path: "/" });
  });

  it("updates its own page on top of what the branch holds", async () => {
    const gh = fakeGitHub();
    await publishPages(gh.api, REPO, { "index.html": `<meta name="generator" content="${GENERATOR}">one` }, "m");
    const first = gh.state.refs.get("gh-pages")!;
    const out = await publishPages(gh.api, REPO, { "index.html": `<meta name="generator" content="${GENERATOR}">two` }, "m");
    expect(out).toMatchObject({ ok: true, pages: "served" });
    expect(gh.live()).toContain("two");
    const head = gh.state.commits.get(gh.state.refs.get("gh-pages")!)!;
    expect(head.parents).toEqual([first]);
    expect(gh.state.trees.get(head.tree)!.base).toBe(gh.state.commits.get(first)!.tree);
  });

  it("leaves a site it did not make alone", async () => {
    const gh = fakeGitHub();
    await publishPages(gh.api, REPO, { "index.html": "someone's docs" }, "m");
    const before = gh.state.refs.get("gh-pages");
    expect(await publishPages(gh.api, REPO, { "index.html": `<meta name="generator" content="${GENERATOR}">` }, "m")).toEqual({ ok: false, reason: "foreign" });
    expect(gh.state.refs.get("gh-pages")).toBe(before);
  });

  it("says where Pages serves from when it is not gh-pages", async () => {
    const gh = fakeGitHub();
    gh.state.pages = { html_url: "https://acme.github.io/app/", source: { branch: "main", path: "/docs" } };
    expect(await publishPages(gh.api, REPO, { "index.html": "x" }, "m")).toMatchObject({ ok: true, pages: "elsewhere", source: "main/docs" });
  });
});

class FakeGitHub extends Service {
  static provide = "github";
  token = async () => "token";
  readonly api = fakeGitHub().api;
  constructor(ctx: Context) {
    super(ctx, "github");
  }
}

class FakeRepos extends Service {
  static provide = "repos";
  constructor(ctx: Context) {
    super(ctx, "repos");
  }
  list() {
    return [{ id: "repo-1", remote: `https://github.com/${REPO}.git` }];
  }
}

class FakeCodeLink extends Service {
  static provide = "codeLink";
  merged: { itemId: string; prState: string | null; mergedSha: string | null; updatedAt: number }[] = [];
  constructor(ctx: Context) {
    super(ctx, "codeLink");
  }
  links() {
    return this.merged;
  }
}

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-build-page-"));
  const f = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings.json") }], Contributions, [Inbox, { pullMs: 3_600_000 }], FakeGitHub, FakeRepos, FakeCodeLink, BuildPage] });
  onTestFinished(() => {
    f.ctx.fiber.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ctx = f.ctx as Context;
  const gh = fakeGitHub();
  ctx.buildPage.api = gh.api;
  const p = f.project.id;
  const mk = (title: string, status: Item["status"] = "todo") => {
    const made = f.items.create({ projectId: p, boardId: f.board.id, title, by: "human" });
    return status === "todo" ? made : f.items.update(p, made.id, { status }, "human");
  };
  return { ...f, ctx, gh, p, mk, page: ctx.buildPage, code: ctx.codeLink as unknown as FakeCodeLink };
}

describe("the build page", () => {
  it("starts with nothing ticked and the project's repository", async () => {
    const t = await boot();
    t.mk("Dark mode");
    const state = await t.page.state(t.p);
    expect(state.config).toMatchObject({ repo: REPO, footer: true, picks: [] });
    expect(state.candidates.map((c) => c.title)).toEqual(["Dark mode"]);
  });

  it("publishes exactly what was previewed, and only what was ticked", async () => {
    const t = await boot();
    const shown = t.mk("Dark mode", "doing");
    const hidden = t.mk("Secret partner work");
    const fixed = t.mk("Fix login", "done");
    t.code.merged.push({ itemId: fixed.id, prState: "merged", mergedSha: "abc", updatedAt: T0 });
    const preview = await t.page.preview(t.p, { repo: REPO, title: "Acme", footer: true, picks: [shown.id, fixed.id] });
    expect(preview).toMatchObject({ roadmap: 1, changelog: 1 });
    expect(preview.html).not.toContain(hidden.title);
    const out = await t.page.publish(t.p, preview.id);
    expect(out).toEqual({ url: "https://acme.github.io/app/", warning: null });
    expect(t.gh.live()).toBe(preview.html);
    expect((await t.page.state(t.p)).config.picks).toEqual([shown.id, fixed.id]);
  });

  it("refuses to publish without a preview, or an out-of-date one", async () => {
    const t = await boot();
    await expect(t.page.publish(t.p, "nope")).rejects.toThrow(w("noPreview"));
    const first = await t.page.preview(t.p, { repo: REPO, title: "Acme", footer: true, picks: [] });
    await t.page.preview(t.p, { repo: REPO, title: "Acme", footer: false, picks: [] });
    await expect(t.page.publish(t.p, first.id)).rejects.toThrow(w("stale"));
    expect(t.gh.state.writes).toEqual([]);
  });

  it("only publishes to the project's own repositories", async () => {
    const t = await boot();
    await expect(t.page.preview(t.p, { repo: "someone/else", title: "x", footer: true, picks: [] })).rejects.toThrow(w("noRepo"));
  });

  it("brings feedback sent from the page into the Inbox", async () => {
    const t = await boot();
    const preview = await t.page.preview(t.p, { repo: REPO, title: "Acme", footer: true, picks: [] });
    await t.page.publish(t.p, preview.id);
    // A visitor follows the page's feedback link and files the issue it opens.
    const link = new URL(/class="button" href="([^"]+)"/.exec(t.gh.live()!)![1]!.replace(/&amp;/g, "&"));
    const [, owner, repo] = link.pathname.split("/");
    expect(`${owner}/${repo}`).toBe(REPO);
    t.gh.state.issues.push({ number: 9, title: "Crash on save", body: link.searchParams.get("body"), html_url: `https://github.com/${REPO}/issues/9`, user: { login: "visitor" }, labels: [], state: "open", created_at: new Date(T0).toISOString() });
    const inbox = t.ctx.inbox;
    inbox.source(
      githubSource({
        api: t.gh.api,
        inbox,
        repos: async () => new Map([["repo-1", REPO]]),
        item: () => null,
        links: () => [],
        connected: async () => true,
        words: () => ({ source: "GitHub", connect: "", noRepo: "", noAccess: (r) => r, repoFailed: (r) => r, releaseFailed: (x) => x, comment: "", commentHelp: "", close: "", closeHelp: "" })
      })
    );
    await settle();
    await inbox.setSource(t.p, "github", true);
    expect(inbox.list(t.p).map((e) => [e.externalId, e.title, e.reporter])).toEqual([[`${REPO}#9`, "Crash on save", "visitor"]]);
  });
});
