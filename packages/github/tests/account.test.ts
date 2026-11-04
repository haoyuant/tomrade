/**
 * ctx.github is the one place the token is read. Connecting checks the token
 * before keeping it; while connected, Tomrade's own git commands get the
 * helper as GitHub's only credential, and nothing at all once disconnected.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Settings } from "@tomradex/settings";
import { credentialArgs } from "@tomradex/git";
import GitHubAccount from "@tomradex/github";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-github-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function machine() {
  const userData = path.join(root, `user data ${n++}`);
  fs.mkdirSync(userData, { recursive: true });
  const bag = await fresh({ plugins: [[Settings, { path: path.join(userData, "settings.json") }], [GitHubAccount, { ghToken: async () => "" }]] });
  return { ...bag, github: bag.ctx.github, userData };
}

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** What `git credential fill` gives one of Tomrade's commands, against a user config that names another account. */
function fill(args: string[]): string {
  const global = path.join(root, "global.config");
  fs.writeFileSync(global, '[credential]\n\thelper = "!f() { echo username=wrong-account; echo password=wrong-token; }; f"\n');
  return execFileSync("git", [...args, "credential", "fill"], {
    input: "protocol=https\nhost=github.com\npath=me/app.git\n\n",
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
  });
}

it("keeps only a token GitHub accepts, and hands it to git through the helper while connected", async () => {
  const { github, ctx, userData } = await machine();
  expect(github.credential()).toBeNull();
  expect(await github.token()).toBe("");

  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(answer(401, { message: "Bad credentials" }));
  await expect(github.connection.connect("ghp_rejected")).rejects.toThrow("Bad credentials");
  expect(await github.token()).toBe("");

  fetch.mockImplementation(async () => answer(200, { login: "me" }));
  expect(await github.connection.connect(" ghp_accepted ")).toEqual({ connected: true, label: "@me" });
  expect(await github.token()).toBe("ghp_accepted");
  expect(await github.account()).toBe("@me");

  const credential = github.credential();
  expect(credential).toEqual({ url: "https://github.com", helper: expect.stringContaining(path.join(userData, "bin", "tomrade-credential")) });
  const filled = fill(credentialArgs([credential!]));
  expect(filled).toContain("username=x-access-token\npassword=ghp_accepted");
  expect(filled).not.toContain("wrong");

  await github.connection.disconnect();
  expect(github.credential()).toBeNull();
  expect(ctx.settings.get().github).toEqual({ token: "" });
  expect(fill([])).toContain("username=wrong-account");
});

it("hands git a personal token that settings.json keeps sealed", async () => {
  const userData = path.join(root, `user data ${n++}`);
  fs.mkdirSync(userData, { recursive: true });
  const cipher = { available: () => true, encrypt: (v: string) => Buffer.from([...v].reverse().join("")), decrypt: (b: Buffer) => [...b.toString()].reverse().join("") };
  const { ctx } = await fresh({ plugins: [[Settings, { path: path.join(userData, "settings.json"), cipher }], [GitHubAccount, { ghToken: async () => "" }]] });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer(200, { login: "me" }));
  await ctx.github.connection.connect("ghp_sealed");
  expect(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).not.toContain("ghp_sealed");
  expect(fill(credentialArgs([ctx.github.credential()!]))).toContain("username=x-access-token\npassword=ghp_sealed");
  // POSIX modes only; Windows has no 0600.
  if (process.platform !== "win32") expect(fs.statSync(path.join(userData, "github-token.json")).mode & 0o777).toBe(0o600);
  await ctx.github.connection.disconnect!();
  expect(fs.existsSync(path.join(userData, "github-token.json"))).toBe(false);
});

it("falls back to the GitHub CLI's token for issues only, after the sign-in and the personal token", async () => {
  const userData = path.join(root, `user data ${n++}`);
  fs.mkdirSync(userData, { recursive: true });
  let gh = "gho_cli";
  const { ctx } = await fresh({ plugins: [[Settings, { path: path.join(userData, "settings.json") }], [GitHubAccount, { ghToken: async () => gh }]] });
  const github = ctx.github;
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    calls.push(String((init?.headers as Record<string, string>).Authorization));
    return answer(200, { login: "me" });
  });

  expect(await github.token()).toBe("");
  expect(github.credential()).toBeNull();
  expect(await github.readToken()).toBe("gho_cli");
  // gh reads issues only: the account itself, which storage and publishing go by, stays unconnected
  expect(await github.status()).toEqual({ connected: false });
  expect(await github.issues.whoami()).toBe("me");
  expect(calls.at(-1)).toBe("Bearer gho_cli");

  // a personal token comes first
  await github.connection.connect("ghp_own");
  expect(await github.readToken()).toBe("ghp_own");

  await github.disconnect();
  gh = "";
  // the cached answer is dropped only after its minute; a fresh account sees no gh
  const fresh2 = await fresh({ plugins: [[Settings, { path: path.join(userData, "settings.json") }], [GitHubAccount, { ghToken: async () => "" }]] });
  expect(await fresh2.ctx.github.status()).toEqual({ connected: false });
});
