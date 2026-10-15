import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashRuleMatches, claudeCommands } from "@tomradex/engine-claude-code";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-claude-perms-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
let config = "";
let project = "";
const saved = process.env.CLAUDE_CONFIG_DIR;
beforeEach(() => {
  config = path.join(root, `config-${n}`);
  project = path.join(root, `project-${n++}`);
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = config;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
});

const write = (file: string, permissions: object) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions }));
};

describe("Claude Code Bash rules", () => {
  it("matches the rule forms Claude Code accepts", () => {
    const merge = "gh pr merge";
    expect(bashRuleMatches("Bash(gh pr merge *)", "gh pr merge 7 --squash")).toBe(true);
    expect(bashRuleMatches("Bash(gh pr merge *)", merge)).toBe(true);
    expect(bashRuleMatches("Bash(gh pr merge:*)", merge)).toBe(true);
    expect(bashRuleMatches("Bash(gh *)", merge)).toBe(true);
    expect(bashRuleMatches("Bash", merge)).toBe(true);
    expect(bashRuleMatches("Bash(gh pr create *)", merge)).toBe(false);
    expect(bashRuleMatches("Bash(gh pr merged-thing)", merge)).toBe(false);
    expect(bashRuleMatches("Read(*)", merge)).toBe(false);
  });
});

describe("whether Claude Code may merge", () => {
  const opts = (permissionMode?: string, worktree = false) => ({ cwd: project, worktree, ...(permissionMode ? { permissionMode } : {}) });

  it("says auto mode may refuse, and adding the user rule allows it", async () => {
    write(path.join(config, "settings.json"), { allow: ["Read(*)"] });
    const before = await claudeCommands.check("gh pr merge", opts("auto"));
    expect(before).toMatchObject({ state: "blocked", why: "auto-mode", fix: { rule: "Bash(gh pr merge *)", file: path.join(config, "settings.json") } });
    const after = await claudeCommands.allow!("gh pr merge", opts("auto"));
    expect(after).toMatchObject({ state: "allowed", why: "allow-rule", rule: { rule: "Bash(gh pr merge *)" } });
    expect(JSON.parse(fs.readFileSync(path.join(config, "settings.json"), "utf8")).permissions.allow).toEqual(["Read(*)", "Bash(gh pr merge *)"]);
  });

  it("finds the project's checked-in rule, and a local one only outside a worktree", async () => {
    write(path.join(project, ".claude", "settings.local.json"), { allow: ["Bash(gh pr merge:*)"] });
    expect((await claudeCommands.check("gh pr merge", opts("auto"))).state).toBe("allowed");
    expect((await claudeCommands.check("gh pr merge", opts("auto", true))).state).toBe("blocked");
    write(path.join(project, ".claude", "settings.json"), { allow: ["Bash(gh pr merge *)"] });
    expect(await claudeCommands.check("gh pr merge", opts("auto", true))).toMatchObject({ state: "allowed", rule: { file: path.join(project, ".claude", "settings.json") } });
  });

  it("lets a deny rule win, with nothing Tomrade can add", async () => {
    write(path.join(config, "settings.json"), { allow: ["Bash(gh pr merge *)"] });
    write(path.join(project, ".claude", "settings.json"), { deny: ["Bash(gh pr merge:*)"] });
    const check = await claudeCommands.check("gh pr merge", opts("bypassPermissions"));
    expect(check).toMatchObject({ state: "blocked", why: "deny-rule", rule: { rule: "Bash(gh pr merge:*)" } });
    expect(check.fix).toBeUndefined();
  });

  it("reads the mode the settings default to, and sets a broad rule aside in auto mode", async () => {
    write(path.join(config, "settings.json"), { allow: ["Bash"], defaultMode: "acceptEdits" });
    expect(await claudeCommands.check("gh pr merge", opts("local"))).toMatchObject({ state: "allowed", mode: "acceptEdits" });
    expect(await claudeCommands.check("gh pr merge", opts("auto"))).toMatchObject({ state: "blocked", why: "auto-mode" });
    expect(await claudeCommands.check("gh pr merge", opts("bypassPermissions"))).toMatchObject({ state: "allowed", why: "bypass" });
    expect(await claudeCommands.check("gh pr merge", opts("plan"))).toMatchObject({ state: "blocked", why: "plan" });
  });
});
