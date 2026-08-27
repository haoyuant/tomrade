/**
 * GitHub adds only what git cannot do alone — find a repository and make one —
 * so that is what is tested here, plus the property that matters most: a token
 * lives in settings, never in a project's config, and never in an error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "@tomrade/settings";
import { Storage } from "@tomrade/storage";
import { GitError } from "@tomrade/storage-git";
import { fresh, settle } from "@tomrade/testkit";
import storageGithub, { GitHub, GitHubError } from "@tomrade/storage-github";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-gh-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

let n = 0;
async function machine(token = "") {
  const home = path.join(root, `home-${n++}`);
  fs.mkdirSync(home, { recursive: true });
  const bag = await fresh({
    plugins: [
      [Settings, { path: path.join(home, "settings.json") }],
      [Storage, { path: path.join(home, "storage.json"), debounceMs: 60_000, reconcileMs: 0 }],
      [storageGithub, { root: path.join(home, "remotes") }]
    ]
  });
  await settle();
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
    expect(Object.keys((provider!.schema as { properties: Record<string, unknown> }).properties)).toEqual(["owner", "repo", "branch", "path"]);
    expect(provider!.browsable).toBe(true);

    // The secret is a settings card, and the dialog masks it from the schema.
    const section = settings.sections().find((s) => s.id === "github");
    expect(section).toBeDefined();
    expect((section!.schema as { properties: { token: { format?: string } } }).properties.token.format).toBe("password");
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
      { label: "acme/app (private)", config: { owner: "acme", repo: "app", branch: "trunk", path: "" } },
      { label: "me/notes", config: { owner: "me", repo: "notes", branch: "main", path: "" } }
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
    // git puts the remote URL in its stderr; the URL carries the token.
    const leaked = new GitError(["push"], "fatal: could not read from 'https://x-access-token:ghp_SECRET@github.com/me/app.git'");
    expect(leaked.message).not.toContain("ghp_SECRET");
    expect(leaked.message).toContain("github.com/me/app.git");

    // And end to end: a bind that cannot reach GitHub must not name the token.
    const { storage, project } = await machine("ghp_SECRET_TOKEN");
    stubGitHub({ "GET /repos/nobody/nothing": { body: { full_name: "nobody/nothing" } } });
    const failure = await storage.bind(project.id, "github", { owner: "nobody", repo: "nothing", branch: "main", path: "" }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("ghp_SECRET_TOKEN");
    expect(storage.binding(project.id)).toBeNull();
  });
});
