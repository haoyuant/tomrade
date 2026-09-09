import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { GIT_ENV, type Git } from "@tomrade/storage";
import { githubEnvironment, githubHttps, installGithubCredential, usesTomradeCredential, withGithubCredential } from "../src/credentials.js";
import { exec } from "../src/terminal.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-credentials-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function fixture() {
  const dir = fs.mkdtempSync(path.join(root, "repo-"));
  const hub = path.join(dir, "hub's folder");
  const settings = path.join(dir, "machine settings.json");
  const globalConfig = path.join(dir, "global.config");
  fs.writeFileSync(globalConfig, '[credential]\n\thelper = "!f() { echo username=wrong-account; echo password=wrong-token; }; f"\n');
  fs.writeFileSync(settings, JSON.stringify({ github: { token: "test-token-one" } }));
  const git: Git = (args, opts = {}) => new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd: opts.cwd ?? dir, env: { ...process.env, ...GIT_ENV, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" } }, (error, stdout, stderr) => {
      if (error && !opts.ok) reject(new Error(stderr));
      else resolve({ stdout, stderr, code: error ? 1 : 0 });
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  });
  await git(["init", "-q", "-b", "main"]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-qm", "initial"]);
  const fill = (cwd = dir, host = "github.com", protocol = "https") => git(["credential", "fill"], { cwd, ok: true, stdin: `protocol=${protocol}\nhost=${host}\npath=owner/repo.git\n\n` });
  return { dir, hub, settings, globalConfig, git, fill };
}

it("overrides the wrong global account in the checkout and existing worktrees, and reads rotated tokens", async () => {
  const f = await fixture();
  const before = fs.readFileSync(f.globalConfig, "utf8");
  expect((await f.fill()).stdout).toContain("username=wrong-account");
  const worktree = path.join(f.dir, "linked");
  await f.git(["worktree", "add", "-qb", "ticket", worktree]);
  await installGithubCredential(f.git, f.dir, f.hub, f.settings);
  expect(await usesTomradeCredential(f.git, worktree, f.hub)).toBe(true);
  for (const cwd of [f.dir, worktree]) {
    const result = await f.fill(cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("username=x-access-token\npassword=test-token-one");
    expect(result.stdout).not.toContain("wrong-account");
  }
  fs.writeFileSync(f.settings, JSON.stringify({ github: { token: "test-token-two" } }));
  expect((await f.fill(worktree)).stdout).toContain("password=test-token-two");
  const config = fs.readFileSync(path.join(f.dir, ".git/config"), "utf8");
  await installGithubCredential(f.git, worktree, f.hub, f.settings);
  expect(fs.readFileSync(path.join(f.dir, ".git/config"), "utf8")).toBe(config);
  expect(fs.readFileSync(f.globalConfig, "utf8")).toBe(before);
  for (const file of [path.join(f.dir, ".git/config"), ...fs.readdirSync(path.join(f.hub, "bin")).map(name => path.join(f.hub, "bin", name))]) {
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/test-token|wrong-token/);
  }
  expect((await f.fill(f.dir, "example.com")).stdout).toContain("username=wrong-account");
  expect((await f.fill(f.dir, "github.com", "http")).stdout).toContain("username=wrong-account");
});

it("does not leak a previous token when settings are missing, malformed, disconnected or contain newlines", async () => {
  const f = await fixture();
  await installGithubCredential(f.git, f.dir, f.hub, f.settings);
  for (const value of ["{}", "not json", JSON.stringify({ github: { token: "" } }), JSON.stringify({ github: { token: "bad\npassword=injected" } })]) {
    fs.writeFileSync(f.settings, value);
    const result = await f.fill();
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("password=");
    expect(result.stderr).not.toMatch(/test-token|injected/);
  }
  fs.rmSync(f.settings);
  expect((await f.fill()).code).not.toBe(0);
  const stored = await f.git(["credential", "approve"], { stdin: "protocol=https\nhost=github.com\nusername=ignored\npassword=do-not-store\n\n" });
  expect(stored.code).toBe(0);
  await f.git(["credential", "reject"], { stdin: "protocol=https\nhost=github.com\n\n" });
  expect(fs.existsSync(f.settings)).toBe(false);
});

it("leaves the original config intact when a config write fails or another git process holds its lock", async () => {
  const f = await fixture();
  const config = path.join(f.dir, ".git/config");
  const before = fs.readFileSync(config, "utf8");
  const failing: Git = (args, opts) => args.includes("--add") ? Promise.reject(new Error("write failed")) : f.git(args, opts);
  await expect(installGithubCredential(failing, f.dir, f.hub, f.settings)).rejects.toThrow("write failed");
  expect(fs.readFileSync(config, "utf8")).toBe(before);
  expect(fs.existsSync(`${config}.lock`)).toBe(false);
  fs.writeFileSync(`${config}.lock`, "someone else's lock");
  await expect(installGithubCredential(f.git, f.dir, f.hub, f.settings)).rejects.toThrow();
  expect(fs.readFileSync(`${config}.lock`, "utf8")).toBe("someone else's lock");
  expect(fs.readFileSync(config, "utf8")).toBe(before);
});

it("only offers the token for plain HTTPS github.com repository URLs", () => {
  expect(githubHttps("https://github.com/owner/repo.git")).toBe(true);
  for (const remote of ["git@github.com:owner/repo.git", "https://github.com.evil.test/owner/repo", "https://user:token@github.com/owner/repo", "http://github.com/owner/repo", "https://github.com:8443/owner/repo", "/tmp/repo", "https://github.com/owner/repo?token=x"]) expect(githubHttps(remote)).toBe(false);
});

it("passes gh credentials only to opted-in subprocesses and keeps terminal scripts free of tokens", async () => {
  const f = await fixture();
  await f.git(["remote", "add", "origin", "https://github.com/owner/repo"]);
  expect(await githubEnvironment(f.git, f.dir, f.hub, f.settings)).toEqual({});
  await installGithubCredential(f.git, f.dir, f.hub, f.settings);
  expect(await githubEnvironment(f.git, f.dir, f.hub, f.settings)).toEqual({ GH_TOKEN: "test-token-one", GITHUB_TOKEN: "test-token-one" });
  const command = withGithubCredential(f.hub, 'test "$GH_TOKEN" = "test-token-two" && test "$GITHUB_TOKEN" = "$GH_TOKEN" && echo account-ready');
  fs.writeFileSync(f.settings, JSON.stringify({ github: { token: "test-token-two" } }));
  expect(await exec("bash", ["-c", command], f.dir)).toBe("account-ready\n");
  const scriptCommand = withGithubCredential(f.hub, "gh pr view");
  expect(scriptCommand).not.toContain("test-token");
  expect(await exec("bash", ["-c", 'test "$GH_TOKEN" = "test-token-two" && echo account-ready'], f.dir, await githubEnvironment(f.git, f.dir, f.hub, f.settings))).toBe("account-ready\n");
  fs.writeFileSync(f.settings, "{}");
  await expect(githubEnvironment(f.git, f.dir, f.hub, f.settings)).rejects.toThrow("Reconnect");
  await f.git(["remote", "set-url", "origin", "https://example.com/owner/repo"]);
  expect(await githubEnvironment(f.git, f.dir, f.hub, f.settings)).toEqual({});
});
