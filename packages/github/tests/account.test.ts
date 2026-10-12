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
import { credentialArgs } from "@tomradex/storage";
import GitHubAccount from "@tomradex/github";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-github-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function machine() {
  const userData = path.join(root, `user data ${n++}`);
  fs.mkdirSync(userData, { recursive: true });
  const bag = await fresh({ plugins: [[Settings, { path: path.join(userData, "settings.json") }], GitHubAccount] });
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
