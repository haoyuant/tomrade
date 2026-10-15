import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandCheck, CommandCheckOptions, EngineCommands } from "@tomradex/agent";

interface Permissions {
  allow?: unknown;
  ask?: unknown;
  deny?: unknown;
  defaultMode?: unknown;
}

interface Source {
  file: string;
  permissions: Permissions;
}

const managedFile = (): string =>
  process.platform === "darwin"
    ? "/Library/Application Support/ClaudeCode/managed-settings.json"
    : process.platform === "win32"
      ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode", "managed-settings.json")
      : "/etc/claude-code/managed-settings.json";

export const userSettingsFile = (): string => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");

/** The folder Claude Code reads `.claude/` from: the checkout's root when the run starts in a subfolder of it. */
function projectRoots(cwd: string): string[] {
  const roots = [cwd];
  for (let dir = cwd; ; ) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      if (dir !== cwd) roots.push(dir);
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return roots;
}

function read(file: string): Source | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as { permissions?: Permissions };
    return { file, permissions: parsed.permissions ?? {} };
  } catch {
    return null;
  }
}

/** Lowest to highest precedence, as Claude Code layers them. */
function sources({ cwd, worktree }: CommandCheckOptions): Source[] {
  const project = cwd ? projectRoots(cwd).flatMap((root) => [path.join(root, ".claude", "settings.json"), ...(worktree ? [] : [path.join(root, ".claude", "settings.local.json")])]) : [];
  const files = [userSettingsFile(), ...project, managedFile()];
  return files.map(read).filter((s): s is Source => !!s);
}

const rules = (value: unknown): string[] => (Array.isArray(value) ? value.filter((r): r is string => typeof r === "string") : []);

/** `Bash` and `Bash(*)` allow anything; auto mode sets such rules aside. */
const broad = (rule: string): boolean => /^Bash(?:\(\s*\*?\s*\))?$/.test(rule.trim());

/** Claude Code's Bash rule forms: `Bash`, `Bash(cmd)`, `Bash(prefix:*)` and `*` wildcards (`Bash(gh pr merge *)`). */
export function bashRuleMatches(rule: string, command: string): boolean {
  const m = /^Bash(?:\((.*)\))?$/s.exec(rule.trim());
  if (!m) return false;
  const pattern = m[1]?.trim();
  if (!pattern || pattern === "*") return true;
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2).trim();
    return command === prefix || command.startsWith(`${prefix} `);
  }
  const re = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  return re.test(command) || (pattern.endsWith(" *") && command === pattern.slice(0, -2));
}

const ruleFor = (command: string): string => `Bash(${command.split(/\s+/).slice(0, 3).join(" ")} *)`;

function decide(command: string, opts: CommandCheckOptions, layers: Source[]): CommandCheck {
  const found = (kind: "allow" | "ask" | "deny", skip?: (rule: string) => boolean) => {
    for (const layer of [...layers].reverse()) {
      const rule = rules(layer.permissions[kind]).find((r) => !skip?.(r) && bashRuleMatches(r, command));
      if (rule) return { rule, file: layer.file };
    }
    return undefined;
  };
  const configured = [...layers].reverse().map((l) => l.permissions.defaultMode).find((m): m is string => typeof m === "string");
  const mode = opts.permissionMode && opts.permissionMode !== "local" ? opts.permissionMode : (configured ?? "default");
  const fix = { rule: ruleFor(command), file: userSettingsFile() };
  const deny = found("deny");
  if (deny) return { state: "blocked", why: "deny-rule", mode, rule: deny };
  const ask = found("ask");
  if (ask) return { state: "asks", why: "ask-rule", mode, rule: ask };
  if (mode === "bypassPermissions") return { state: "allowed", why: "bypass", mode };
  if (mode === "plan") return { state: "blocked", why: "plan", mode };
  const allow = found("allow", mode === "auto" ? broad : undefined);
  if (allow) return { state: "allowed", why: "allow-rule", mode, rule: allow };
  if (mode === "auto") return { state: "blocked", why: "auto-mode", mode, fix };
  if (mode === "dontAsk") return { state: "blocked", why: "dont-ask", mode, fix };
  return { state: "asks", why: "prompts", mode, fix };
}

/** Read Claude Code's own settings files the way the CLI layers them, and add an allow rule to the user's. */
export const claudeCommands: EngineCommands = {
  async check(command, opts) {
    return decide(command.trim(), opts, sources(opts));
  },
  async allow(command, opts) {
    const before = decide(command.trim(), opts, sources(opts));
    if (!before.fix) return before;
    const file = before.fix.file;
    let settings: { permissions?: Permissions } = {};
    if (fs.existsSync(file)) {
      try {
        settings = JSON.parse(fs.readFileSync(file, "utf8")) as typeof settings;
      } catch {
        throw new Error(`${file} is not valid JSON — fix it by hand, then try again`);
      }
    }
    const permissions = (settings.permissions ??= {});
    const allow = rules(permissions.allow);
    if (!allow.includes(before.fix.rule)) permissions.allow = [...allow, before.fix.rule];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    return decide(command.trim(), opts, sources(opts));
  }
};
