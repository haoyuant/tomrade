/**
 * GitHub adds only what git cannot do alone — find a repository and make one —
 * so that is what is tested here, plus the property that matters most: a token
 * lives in settings, never in a project's config, and never in an error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { GitError } from "@tomradex/storage-git";
import { fresh, settle } from "@tomradex/testkit";
import storageGithub, { GitHub, GitHubError } from "@tomradex/storage-github";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-gh-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

let n = 0;
/**
 * A git that never reaches a network: it echoes its arguments and fails. That is
 * enough to prove what happens to a token on the way back out, and it keeps the
 * suite offline and deterministic.
 */
function fakeGit(home: string): string {
  const file = path.join(home, "fake-git");
  fs.writeFileSync(file, ['#!/bin/sh', 'echo "fake git: $@" >&2', 'case "$1" in', '  init|config) exit 0 ;;', '  *) exit 1 ;;', 'esac', ''].join("\n"), "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

async function machine(token = "") {
  const home = path.join(root, `home-${n++}`);
  fs.mkdirSync(home, { recursive: true });
  const bag = await fresh({
    plugins: [
      [Settings, { path: path.join(home, "settings.json") }],
      [Storage, { gitBinary: fakeGit(home), snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      storageGithub
    ],
    hubDir: path.join(home, "hub")
  });
  await settle();
  await bag.ctx.storage.ready;
  if (token) bag.ctx.settings.set({ ...bag.ctx.settings.get(), github: { token } });
  return { ...bag, storage: bag.ctx.storage, settings: bag.ctx.settings };
}

/** Minimal GitHub, answering only the routes the provider actually calls. */
function stubGitHub(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
      const key = `${method} ${url.replace("https://api.github.com", "")}`;
      const match = routes[key] ?? { status: 404, body: { message: "Not Found" } };
      return {
        ok: (match.status ?? 200) < 400,
        status: match.status ?? 200,
        json: async () => match.body,
        text: async () => JSON.stringify(match.body)
      };
    })
  );
  return calls;
}

describe("the GitHub provider", () => {
  it("registers the provider and keeps its token in settings, not in the project config", async () => {
    const { storage, settings } = await machine();
    const provider = storage.describe().find((p) => p.id === "github");
    expect(provider).toBeDefined();
    expect(provider!.settingsSection).toBe("github");
    expect(Object.keys((provider!.schema as { properties: Record<string, unknown> }).properties)).toEqual(["owner", "repo", "branch"]);
    expect(provider!.browsable).toBe(true);

    // The secret is a settings card, and the dialog masks it from the schema.
    const section = settings.sections().find((s) => s.id === "github");
    expect(section).toBeDefined();
    expect((section!.schema as { properties: { token: { format?: string } } }).properties.token.format).toBe("password");
  });

  it("asks for its account where it is used, not in a settings card of its own", async () => {
    const { storage, settings } = await machine();
    const provider = storage.describe().find((p) => p.id === "github")!;
    // The renderer draws this inline; it also knows where to send the user for one.
    expect(provider.connection?.label).toMatch(/token/i);
    expect(provider.connection?.url).toMatch(/^https:\/\/github\.com\//);
    expect(new URL(provider.connection!.url!).searchParams.get("scopes")).toBe("repo,workflow");
    expect(provider.creatable).toBe(true);
    // The section still exists — it is where the token is kept — but the provider
    // claims it, and the settings dialog skips any section a provider claims.
    expect(settings.sections().find((x) => x.id === "github")).toBeDefined();
    expect(provider.settingsSection).toBe("github");
    expect(await storage.connection("github")).toEqual({ connected: false });
  });

  it("verifies a token before storing it, and never stores one that fails", async () => {
    const { storage, settings } = await machine();
    stubGitHub({ "GET /user": { status: 401, body: { message: "Bad credentials" } } });
    await expect(storage.connect("github", "ghp_wrong")).rejects.toThrow(/Bad credentials/);
    expect((settings.get().github as { token: string }).token).toBe("");

    stubGitHub({ "GET /user": { body: { login: "haoyuant" } } });
    expect(await storage.connect("github", "  ghp_good  ")).toEqual({ connected: true, label: "@haoyuant" });
    expect((settings.get().github as { token: string }).token).toBe("ghp_good");
    expect(await storage.connection("github")).toEqual({ connected: true, label: "@haoyuant" });

    await storage.disconnect("github");
    expect((settings.get().github as { token: string }).token).toBe("");
    expect(await storage.connection("github")).toEqual({ connected: false });
  });

  it("refuses an empty token without asking GitHub", async () => {
    const { storage } = await machine();
    const calls = stubGitHub({});
    expect(await storage.connect("github", "   ")).toMatchObject({ connected: false });
    expect(calls).toHaveLength(0);
  });

  it("makes a whole destination out of a name", async () => {
    const { storage } = await machine("ghp_test");
    stubGitHub({ "GET /user": { body: { login: "haoyuant" } } });
    expect(await storage.draft("github", "backlog")).toEqual({ owner: "haoyuant", repo: "backlog", branch: "main" });
    // An owner can be named outright, and a name is made safe for a URL.
    expect(await storage.draft("github", "acme/the backlog")).toEqual({ owner: "acme", repo: "the-backlog", branch: "main" });
  });

  it("lists repositories a token can see, as ready-made configs", async () => {
    const { storage } = await machine("ghp_test");
    stubGitHub({
      "GET /user/repos?per_page=100&sort=updated&affiliation=owner,organization_member": {
        body: [
          { full_name: "acme/app", name: "app", owner: { login: "acme" }, default_branch: "trunk", private: true, pushed_at: null },
          { full_name: "me/notes", name: "notes", owner: { login: "me" }, default_branch: "main", private: false, pushed_at: null }
        ]
      }
    });
    expect(await storage.browse("github")).toEqual([
      { label: "acme/app (private)", config: { owner: "acme", repo: "app", branch: "trunk" } },
      { label: "me/notes", config: { owner: "me", repo: "notes", branch: "main" } }
    ]);
  });

  it("refuses to browse without a token, and says where to put one", async () => {
    const { storage } = await machine();
    await expect(storage.browse("github")).rejects.toThrow(/Settings → GitHub/);
  });

  it("creates a private repository under a user, and under an organisation", async () => {
    const api = new GitHub(() => "ghp_test");
    const calls = stubGitHub({
      "GET /user": { body: { login: "me" } },
      "POST /user/repos": { body: { full_name: "me/backlog" } },
      "POST /orgs/acme/repos": { body: { full_name: "acme/backlog" } }
    });
    await api.create("me", "backlog");
    await api.create("acme", "backlog");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      "https://api.github.com/user/repos",
      "https://api.github.com/orgs/acme/repos"
    ]);
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ name: "backlog", private: true });
  });

  it("reports a missing repository as absent rather than as a failure", async () => {
    const api = new GitHub(() => "ghp_test");
    stubGitHub({ "GET /repos/me/gone": { status: 404, body: { message: "Not Found" } } });
    expect(await api.exists("me", "gone")).toBeNull();
  });

  it("surfaces a GitHub message rather than a bare status", async () => {
    const api = new GitHub(() => "ghp_test");
    stubGitHub({ "GET /user": { status: 403, body: { message: "Bad credentials" } } });
    await expect(api.login()).rejects.toThrow(GitHubError);
    await expect(api.login()).rejects.toThrow(/Bad credentials/);
  });

  it("never lets a token reach an error message", async () => {
    // The URL carries the token, and it reaches us twice: in git's own output,
    // and in the arguments we handed git.
    const fromOutput = new GitError(["push"], "fatal: could not read from 'https://x-access-token:ghp_SECRET@github.com/me/app.git'");
    expect(fromOutput.message).not.toContain("ghp_SECRET");
    expect(fromOutput.message).toContain("github.com/me/app.git");
    const fromArgs = new GitError(["remote", "add", "origin", "https://x-access-token:ghp_SECRET@github.com/me/app.git"], "");
    expect(fromArgs.message).not.toContain("ghp_SECRET");
    expect(fromArgs.message).toContain("github.com/me/app.git");

    // And end to end: a bind that cannot reach GitHub must not name the token.
    const { storage, project } = await machine("ghp_SECRET_TOKEN");
    stubGitHub({ "GET /repos/nobody/nothing": { body: { full_name: "nobody/nothing" } } });
    const failure = await storage.bind(project.id, "github", { owner: "nobody", repo: "nothing", branch: "main" }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("ghp_SECRET_TOKEN");
    // The fake git accepts init and refuses the rest, so no remote was recorded either.
    expect(storage.entry(project.id)?.remote?.config).not.toMatchObject({ owner: "nobody" });
  });
});
