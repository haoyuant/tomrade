import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { GIT_ENV, type Git } from "@tomradex/storage";
import { githubEnvironment, githubHttps, installGithubCredential, migrateGithubCredential, usesTomradeCredential, withGithubCredential } from "../src/helper.js";

const exec = (command: string, args: string[], cwd: string, env: Record<string, string> = {}) =>
  new Promise<string>((resolve, reject) => execFile(command, args, { cwd, env: { ...process.env, ...env } }, (error, stdout) => (error ? reject(error) : resolve(stdout))));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-credentials-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** What the account reads: the token in the settings file, as it is now. */
const token = (settings: string) => async () => {
  try {
    return String(JSON.parse(fs.readFileSync(settings, "utf8")).github?.token ?? "");
  } catch {
    return "";
  }
};

async function fixture() {
  const dir = fs.mkdtempSync(path.join(root, "repo-"));
  // Paths hold the spaces and apostrophes of a real macOS userData folder.
  const userData = path.join(dir, "user data's folder");
  const settings = path.join(userData, "settings.json");
  const globalConfig = path.join(dir, "global.config");
  fs.mkdirSync(userData, { recursive: true });
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
  return { dir, userData, settings, globalConfig, git, fill };
}

it("overrides the wrong global account in the checkout and existing worktrees, and reads rotated tokens", async () => {
  const f = await fixture();
  const before = fs.readFileSync(f.globalConfig, "utf8");
  expect((await f.fill()).stdout).toContain("username=wrong-account");
  const worktree = path.join(f.dir, "linked");
  await f.git(["worktree", "add", "-qb", "ticket", worktree]);
  await installGithubCredential(f.git, f.dir, f.settings);
  expect(await usesTomradeCredential(f.git, worktree, f.settings)).toBe(true);
  for (const cwd of [f.dir, worktree]) {
    const result = await f.fill(cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("username=x-access-token\npassword=test-token-one");
    expect(result.stdout).not.toContain("wrong-account");
  }
  fs.writeFileSync(f.settings, JSON.stringify({ github: { token: "test-token-two" } }));
  expect((await f.fill(worktree)).stdout).toContain("password=test-token-two");
  const config = fs.readFileSync(path.join(f.dir, ".git/config"), "utf8");
  await installGithubCredential(f.git, worktree, f.settings);
  expect(fs.readFileSync(path.join(f.dir, ".git/config"), "utf8")).toBe(config);
  expect(fs.readFileSync(f.globalConfig, "utf8")).toBe(before);
  for (const file of [path.join(f.dir, ".git/config"), ...fs.readdirSync(path.join(f.userData, "bin")).map(name => path.join(f.userData, "bin", name))]) {
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/test-token|wrong-token/);
  }
  expect((await f.fill(f.dir, "example.com")).stdout).toContain("username=wrong-account");
  expect((await f.fill(f.dir, "github.com", "http")).stdout).toContain("username=wrong-account");
});

it("does not leak a previous token when settings are missing, malformed, disconnected or contain newlines", async () => {
  const f = await fixture();
  await installGithubCredential(f.git, f.dir, f.settings);
  for (const value of ["{}", "not json", JSON.stringify({ github: { token: "" } }), JSON.stringify({ github: { token: "bad\npassword=injected" } })]) {
    fs.writeFileSync(f.settings, value);
    const result = await f.fill();
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("password=");
    expect(result.stderr).not.toMatch(/test-token|injected/);
  }
  // A token settings.json keeps sealed is not git's to read.
  fs.writeFileSync(f.settings, JSON.stringify({ github: { token: "tomrade-encrypted:v1:c2VhbGVk" } }));
  expect((await f.fill()).stdout).not.toContain("password=");
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
  await expect(installGithubCredential(failing, f.dir, f.settings)).rejects.toThrow("write failed");
  expect(fs.readFileSync(config, "utf8")).toBe(before);
  expect(fs.existsSync(`${config}.lock`)).toBe(false);
  fs.writeFileSync(`${config}.lock`, "someone else's lock");
  await expect(installGithubCredential(f.git, f.dir, f.settings)).rejects.toThrow();
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
  expect(await githubEnvironment(f.git, f.dir, f.settings, token(f.settings))).toEqual({});
  await installGithubCredential(f.git, f.dir, f.settings);
  expect(await githubEnvironment(f.git, f.dir, f.settings, token(f.settings))).toEqual({ GH_TOKEN: "test-token-one", GITHUB_TOKEN: "test-token-one" });
  const command = withGithubCredential(f.settings, 'test "$GH_TOKEN" = "test-token-two" && test "$GITHUB_TOKEN" = "$GH_TOKEN" && echo account-ready');
  fs.writeFileSync(f.settings, JSON.stringify({ github: { token: "test-token-two" } }));
  expect(await exec("bash", ["-c", command], f.dir)).toBe("account-ready\n");
  const scriptCommand = withGithubCredential(f.settings, "gh pr view");
  expect(scriptCommand).not.toContain("test-token");
  expect(await exec("bash", ["-c", 'test "$GH_TOKEN" = "test-token-two" && echo account-ready'], f.dir, await githubEnvironment(f.git, f.dir, f.settings, token(f.settings)))).toBe("account-ready\n");
  fs.writeFileSync(f.settings, "{}");
  await expect(githubEnvironment(f.git, f.dir, f.settings, token(f.settings))).rejects.toThrow("Reconnect");
  await f.git(["remote", "set-url", "origin", "https://example.com/owner/repo"]);
  expect(await githubEnvironment(f.git, f.dir, f.settings, token(f.settings))).toEqual({});
});

it("moves an installed helper from the old Hub location to userData, once", async () => {
  const f = await fixture();
  await installGithubCredential(f.git, f.dir, f.settings);
  const legacy = path.join(f.dir, "old-hub", "bin", "tomrade-credential");
  await f.git(["config", "--local", "--replace-all", "credential.https://github.com.helper", ""]);
  await f.git(["config", "--local", "--add", "credential.https://github.com.helper", `!'${legacy}'`]);
  expect(await usesTomradeCredential(f.git, f.dir, f.settings)).toBe(false);
  expect(await migrateGithubCredential(f.git, f.dir, f.settings)).toBe(true);
  expect(await usesTomradeCredential(f.git, f.dir, f.settings)).toBe(true);
  expect(fs.readFileSync(path.join(f.dir, ".git/config"), "utf8")).not.toContain(legacy);
  expect(await migrateGithubCredential(f.git, f.dir, f.settings)).toBe(false);
  expect((await f.fill()).stdout).toContain("password=test-token-one");
});

it("leaves a checkout on another Tomrade's helper, and still moves an old Hub helper of its own", async () => {
  const f = await fixture();
  const dev = path.join(f.dir, "dev's data");
  const devSettings = path.join(dev, "settings.json");
  fs.mkdirSync(dev);
  fs.writeFileSync(devSettings, JSON.stringify({ github: { token: "dev-token" } }));
  await installGithubCredential(f.git, f.dir, devSettings);
  const config = fs.readFileSync(path.join(f.dir, ".git/config"), "utf8");
  fs.writeFileSync(f.settings, JSON.stringify({ github: { token: "" } }));
  expect(await migrateGithubCredential(f.git, f.dir, f.settings)).toBe(false);
  expect(fs.readFileSync(path.join(f.dir, ".git/config"), "utf8")).toBe(config);
  expect((await f.fill()).stdout).toContain("password=dev-token");

  await installGithubCredential(f.git, f.dir, f.settings);
  const oldHub = path.join(f.dir, "old hub");
  fs.mkdirSync(path.join(oldHub, "bin"), { recursive: true });
  for (const name of ["tomrade-credential", "tomrade-credential.cjs"]) fs.copyFileSync(path.join(f.userData, "bin", name), path.join(oldHub, "bin", name));
  await f.git(["config", "--local", "--replace-all", "credential.https://github.com.helper", ""]);
  await f.git(["config", "--local", "--add", "credential.https://github.com.helper", `!'${path.join(oldHub, "bin", "tomrade-credential")}'`]);
  expect(await migrateGithubCredential(f.git, f.dir, f.settings)).toBe(true);
  expect(await usesTomradeCredential(f.git, f.dir, f.settings)).toBe(true);
});

it("repairs a checkout whose other-Tomrade helper can no longer run, because the build that wrote it was deleted", async () => {
  const f = await fixture();
  const dev = path.join(f.dir, "dev data");
  const devSettings = path.join(dev, "settings.json");
  fs.mkdirSync(dev);
  fs.writeFileSync(devSettings, JSON.stringify({ github: { token: "dev-token" } }));
  await installGithubCredential(f.git, f.dir, devSettings);
  expect(await migrateGithubCredential(f.git, f.dir, f.settings)).toBe(false);

  const script = path.join(dev, "bin", "tomrade-credential");
  fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace(process.execPath, path.join(f.dir, "removed-worktree", "Electron")));
  expect(await migrateGithubCredential(f.git, f.dir, f.settings)).toBe(true);
  expect(await usesTomradeCredential(f.git, f.dir, f.settings)).toBe(true);
  expect((await f.fill()).stdout).toContain("password=test-token-one");
});
