import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { CODE_WORDS } from "./words.js";

/** The terminal until the person picks one: it follows what this machine has. */
export const AUTO_TERMINAL = "auto";

/** Machine settings: which terminal opens, and how each coding agent is invoked in it. */
export const TerminalSettings = z.object({
  terminal: z.string().default(AUTO_TERMINAL).meta({ title: "Terminal app" }).describe(`${CODE_WORDS("en")("terminalAutoHelp")} ${CODE_WORDS("en")("terminalHelp")}`),
  claudeCommand: z.string().default('claude {options} --mcp-config "{mcpConfig}" --settings "{settings}" {resume} "$(cat "{prompt}")"').meta({ title: "Claude Code command", advanced: true }),
  codexCommand: z.string().default('codex {resume} {options} -c mcp_servers.tomrade.url="{mcpUrl}" -c mcp_servers.tomrade.bearer_token_env_var="TOMRADE_MCP_TOKEN" "$(cat "{prompt}")"').meta({ title: "Codex command", advanced: true }),
  piCommand: z.string().default('pi {options} -e "{piExtension}" {resume} "$(cat "{prompt}")"').meta({ title: "Pi command", advanced: true }).describe("Pi takes no MCP flag; {piExtension} is a session-only extension that registers the server and reports like Claude's hooks."),
  /** WorkBuddy's CLI takes Claude Code's flags and posts Claude-shaped hooks. */
  workbuddyCommand: z.string().default('codebuddy {options} --mcp-config "{mcpConfig}" --settings "{settings}" {resume} "$(cat "{prompt}")"').meta({ title: "WorkBuddy command", advanced: true }),
  /** Gemini CLI runs from a session home: the person's own ~/.gemini, with Tomrade's server added to its settings. */
  geminiCommand: z.string().default('GEMINI_CLI_HOME="{geminiHome}" gemini {options} {resume} -i "$(cat "{prompt}")"').meta({ title: "Gemini CLI command", advanced: true }).describe("{geminiHome} is a Gemini home for this session alone: your own ~/.gemini (sign-in, extensions, history) with Tomrade's server added to a copy of its settings. Your own files are not changed."),
  opencodeCommand: z.string().default('OPENCODE_CONFIG="{opencodeConfig}" opencode {options} {resume} --prompt "$(cat "{prompt}")"').meta({ title: "OpenCode command", advanced: true }),
  /** No interactive terminal of its own: one headless run, shown and reported through {dshReporter}, resumed by session id. */
  dshCommand: z.string().default('"{bin}" --profile headless --patch "{dshPatch}" --json {resume} - < "{prompt}" | ELECTRON_RUN_AS_NODE=1 "{node}" "{dshReporter}"').meta({ title: "DeepSeek Harness command", advanced: true }).describe("DeepSeek Harness has no interactive terminal: the ticket runs as one headless run, shown through {dshReporter} and resumed with --session-id. {bin} is the dsh Tomrade found, the desktop app's own included; {dshPatch} adds Tomrade's server for this run."),
  /** Antigravity's CLI reads Tomrade's server from its own config; the ticket's prompt asks it to claim first. */
  agyCommand: z.string().default('agy {options} {resume} -i "$(cat "{prompt}")"').meta({ title: "Antigravity CLI command", advanced: true }).describe("agy takes no MCP flag: it reaches Tomrade through its own user-level tomrade server (connect it under Antigravity CLI in Settings), and claims the ticket first."),
  /** Cursor's CLI reads Tomrade's server from ~/.cursor/mcp.json; the ticket's prompt asks it to claim first. */
  cursorCommand: z.string().default('cursor-agent {options} {resume} "$(cat "{prompt}")"').meta({ title: "Cursor command", advanced: true }).describe("cursor-agent takes no MCP flag: it reaches Tomrade through its own user-level tomrade server (connect it under Cursor in Settings), and claims the ticket first."),
  hermesCommand: z.string().default('hermes chat {options} {resume} --query-file "{prompt}"').meta({ title: "Hermes command", advanced: true }).describe("Hermes takes no MCP flag: it reads its tomrade server from its own config.yaml, the header naming the $TOMRADE_MCP_TOKEN this terminal exports. Connect it under Hermes in Settings first."),
  otherCommand: z.string().default("").meta({ title: "Other agent command", advanced: true }).describe("Any other CLI agent with an MCP client — Gemini CLI, OpenCode, aider… Empty means none is set up. {mcpUrl}, {token} (also in $TOMRADE_MCP_TOKEN), {prompt}, {resume} (the bare session id) are filled in.")
});
export type TerminalSettings = z.infer<typeof TerminalSettings>;

/**
 * The section as this machine runs it. A terminal left on automatic is looked
 * at again each time — herdr once it is installed, the system terminal until
 * then — and one the person picked stays as it is.
 */
export async function machineTerminalSettings(stored: unknown, herdr: Pick<HerdrTerminal, "installed"> | null | undefined): Promise<TerminalSettings> {
  const settings = TerminalSettings.parse(stored ?? {});
  if (settings.terminal !== AUTO_TERMINAL) return settings;
  return { ...settings, terminal: (await herdr?.installed()) ? "herdr" : SYSTEM_TERMINAL };
}

const TERMINAL_APPS = new Set(["terminal", "iterm", "iterm2", "warp", "ghostty", "alacritty", "kitty", "wezterm", "hyper", "tabby", "rio", "wave"]);

/** Installed macOS terminal bundles that `open -a` can launch. */
export function terminalApps(roots = ["/Applications", path.join(os.homedir(), "Applications"), "/System/Applications"], platform = process.platform): string[] {
  if (platform !== "darwin") return ["herdr", "none"];
  const found = new Set<string>();
  const scan = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith(".app")) {
        const name = entry.name.slice(0, -4);
        if (TERMINAL_APPS.has(name.toLowerCase())) found.add(name);
      } else if (depth < 1) scan(path.join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots) scan(root, 0);
  return [...found].sort((a, b) => a.localeCompare(b)).concat("herdr", "none");
}

/** The command template a terminal session starts an engine with; Claude Code's flags are the common ground. */
export function terminalTemplate(settings: TerminalSettings, engine: string): string {
  switch (engine) {
    case "codex": return settings.codexCommand;
    case "pi": return settings.piCommand;
    case "workbuddy": return settings.workbuddyCommand;
    // A template saved before Gemini 0.64 ignored a system defaults file root does not own.
    case "gemini": return settings.geminiCommand.replace(/GEMINI_CLI_SYSTEM_DEFAULTS_PATH=("?)\{geminiSettings\}\1/, 'GEMINI_CLI_HOME="{geminiHome}"');
    case "opencode": return settings.opencodeCommand;
    case "hermes": return settings.hermesCommand;
    case "dsh": return settings.dshCommand;
    case "agy": return settings.agyCommand;
    case "cursor": return settings.cursorCommand;
    case "other": return settings.otherCommand;
    default: return settings.claudeCommand;
  }
}

export interface LaunchInput {
  cwd: string;
  command: string;
  /** Environment the script exports before the command. */
  env?: Record<string, string>;
  /** Where the script is written: the session's folder. */
  dir: string;
  /** What herdr labels the session's tab (or its own workspace): the ticket's key. */
  label?: string;
  /** The project's herdr workspace the session opens in as a tab; without, herdr gets a workspace of its own. */
  workspace?: { key: string; label: string };
  /** The command that resumes the agent's session later, written beside the script for herdr to run after a restart of its own. */
  resume?: string;
}

/** The script a `resume` command is written to, next to `run.command`; it reads the session id from `resume-id`. */
export const RESUME_SCRIPT = "resume.command";
export const RESUME_ID_FILE = "resume-id";

/** What a terminal of "herdr" is run through: a pane with the script going in it, on a server started for it when none runs. */
export interface HerdrTerminal {
  launch(input: { cwd: string; label?: string; command: string; workspace?: { key: string; label: string } }): Promise<{ paneId: string; startedServer?: "first" | "again" } | null>;
  installed(): Promise<string | null>;
}

export interface LaunchResult {
  script: string;
  launched: boolean;
  /** The herdr pane the script runs in, when the terminal is herdr. */
  paneId?: string;
  /** The terminal is herdr, and herdr did not answer: the script went to the system terminal instead. */
  herdrMissing?: "notInstalled" | "notRunning";
  /** herdr was not running and Tomrade started its server for this launch; "first" the first time ever on this machine. */
  herdrStarted?: "first" | "again";
  /** On Windows, no Git Bash to run the script with: nothing opened. */
  gitBashMissing?: true;
}

/** Where a herdr launch goes when herdr does not answer; off macOS the platform's own emulator is used whatever the name. */
export const SYSTEM_TERMINAL = "Terminal";

/** Git Bash where Git for Windows installs it (the shell plugin's findBash looks in the same places); WSL's bash.exe sees another filesystem, so a bare `bash` on PATH never counts. */
export function gitBash(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): string | null {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs")];
  return roots.filter((dir): dir is string => !!dir).map((dir) => path.win32.join(dir, "Git", "bin", "bash.exe")).find(exists) ?? null;
}

/** Thrown when Windows has no Git Bash to run a session's script. */
export class GitBashMissing extends Error {
  constructor() {
    super("Git Bash is not installed");
  }
}

/**
 * A script on Windows: Git Bash runs it in Windows Terminal, in the session's folder, as the Terminal window's New
 * terminal opens there; without Windows Terminal, in a console window of its own. Resolves with the app it opened.
 */
export function openOnWindows(script: string, cwd: string, bash: string | null = gitBash(), launch: typeof spawn = spawn): Promise<string> {
  if (!bash) return Promise.reject(new GitBashMissing());
  const start = (command: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = launch(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  return start("wt.exe", ["-d", cwd, bash, script]).then(
    () => "Windows Terminal",
    () => start(bash, [script]).then(() => "Git Bash")
  );
}

/** Hands a script to a terminal app; an object so tests can stand in for the app. */
export const terminalApp = {
  async open(terminal: string, script: string, cwd: string = os.homedir()): Promise<void> {
    if (process.platform === "darwin") await run("open", ["-a", terminal, script]);
    else if (process.platform === "win32") await openOnWindows(script, cwd);
    else {
      try {
        await run("x-terminal-emulator", ["-e", `bash ${shellQuote(script)}`]);
      } catch {
        await run("gnome-terminal", ["--", "bash", script]);
      }
    }
  }
};

/** What to tell the person after a launch: that it went elsewhere, that Windows has no Git Bash to run it, or — once — that Tomrade started herdr in the background. Null otherwise. */
export function herdrFallbackNote(locale: unknown, launch: LaunchResult, install: string): string | null {
  const w = CODE_WORDS(locale);
  if (launch.herdrStarted === "first") return w("herdrStartedInBackground");
  const noBash = launch.gitBashMissing ? w("gitBashMissing") : null;
  if (!launch.herdrMissing) return noBash;
  const app = process.platform === "darwin" ? SYSTEM_TERMINAL : w("systemTerminal");
  const note = launch.herdrMissing === "notInstalled" ? w("herdrNotInstalledFallback", { app, install }) : w("herdrNotRunningFallback", { app });
  return launch.launched ? note : `${note} ${noBash ?? w("fallbackDidNotOpen", { app })}`;
}

/** Fill a command template. Unknown placeholders are left as they are, so a typo is visible in the terminal. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key]! : whole)).replace(/\s{2,}/g, " ").trim();
}

const bare = (value: string): string => (/^[\w.:@/-]+$/.test(value) ? value : shellQuote(value));

/** The model and effort a thread was started with, as the CLI's own flags; nothing for a knob left on its default. */
export function optionFlags(engine: string, options: unknown): string {
  const o = options && typeof options === "object" ? (options as Record<string, unknown>) : {};
  const model = typeof o.model === "string" && o.model.trim() ? o.model.trim() : null;
  const effort = typeof o.effort === "string" && o.effort.trim() ? o.effort.trim() : null;
  const flags: string[] = [];
  if (engine === "claude-code" || engine === "workbuddy") {
    if (model) flags.push(`--model ${bare(model)}`);
    if (effort) flags.push(`--effort ${bare(effort)}`);
  } else if (engine === "codex") {
    if (model) flags.push(`-m ${bare(model)}`);
    if (effort) flags.push(`-c model_reasoning_effort=${bare(effort)}`);
  } else if (engine === "pi") {
    if (model) flags.push(`--model ${bare(model)}`);
    if (effort) flags.push(`--thinking ${bare(effort)}`);
  } else if (engine === "gemini") {
    if (model) flags.push(`-m ${bare(model)}`);
  } else if (engine === "agy") {
    if (model) flags.push(`--model ${bare(model)}`);
    if (effort) flags.push(`--effort ${bare(effort)}`);
  } else if (engine === "cursor") {
    if (model) flags.push(`--model ${bare(model)}`);
  } else if (engine === "hermes") {
    // a model id, or provider:model
    if (model) flags.push(`-m ${bare(model)}`);
  } else if (engine === "opencode") {
    // provider/model, as OpenCode names them
    if (model) flags.push(`--model ${bare(model)}`);
  }
  return flags.join(" ");
}

/** A template without an `{options}` slot (one saved before the slot existed) gets the flags right after the command. */
export function withOptions(template: string, flags: string): string {
  if (template.includes("{options}")) return template.replace("{options}", flags);
  return flags ? template.replace(/^(\s*\S+)/, `$1 ${flags}`) : template;
}

/**
 * Write a `.command` script and hand it to the terminal app. macOS runs a
 * `.command` file in a new window when it is opened with Terminal or iTerm;
 * Windows runs it with Git Bash in Windows Terminal; elsewhere the common
 * emulators take `-e`. A terminal of "herdr" starts
 * herdr's server when it is installed but not running; one that still does
 * not answer opens the system terminal instead. A terminal of "none" writes
 * the script and stops, for a person to run it themselves.
 */
export async function launchTerminal(input: LaunchInput, terminal: string, herdr: HerdrTerminal | null = null): Promise<LaunchResult> {
  fs.mkdirSync(input.dir, { recursive: true });
  const script = path.join(input.dir, "run.command");
  const exports = Object.entries(input.env ?? {}).map(([k, v]) => `export ${k}=${shellQuote(v)}`);
  // The script's own pid is the session's heartbeat: the shell outlives the agent
  // it runs by a moment and dies with the window, so "is the pid alive" answers
  // "is the session alive" whether or not a hook got to say so.
  const pidFile = path.join(input.dir, "pid");
  const wrap = (command: string) => ["#!/bin/bash", `cd ${shellQuote(input.cwd)} || exit 1`, `echo $$ > ${shellQuote(pidFile)}`, `trap 'rm -f ${shellQuote(pidFile)}' EXIT`, ...exports, command, ""].join("\n");
  fs.writeFileSync(script, wrap(input.command), { mode: 0o755 });
  // The same wrapper around the resume: the pid file and the token come back with the session.
  if (input.resume) fs.writeFileSync(path.join(input.dir, RESUME_SCRIPT), wrap(input.resume), { mode: 0o755 });
  if (terminal === "none") return { script, launched: false };
  let herdrMissing: LaunchResult["herdrMissing"];
  if (terminal === "herdr") {
    // The script, not the command: the pid file and the exports come along, and the shell stays after the agent for the person to read.
    const pane = herdr ? await herdr.launch({ cwd: input.cwd, label: input.label, command: `bash ${shellQuote(script)}`, ...(input.workspace ? { workspace: input.workspace } : {}) }) : null;
    if (pane) return { script, launched: true, paneId: pane.paneId, ...(pane.startedServer ? { herdrStarted: pane.startedServer } : {}) };
    herdrMissing = (await herdr?.installed()) ? "notRunning" : "notInstalled";
    terminal = SYSTEM_TERMINAL;
  }
  const missing = herdrMissing ? { herdrMissing } : {};
  try {
    await terminalApp.open(terminal, script, input.cwd);
    return { script, launched: true, ...missing };
  } catch (error) {
    return { script, launched: false, ...missing, ...(error instanceof GitBashMissing ? { gitBashMissing: true as const } : {}) };
  }
}

/**
 * Run one setup command where the person can watch it and answer its
 * questions: a new shell afterwards picks up a PATH the install just changed.
 * Windows gets PowerShell, which the official installers there are written for.
 */
export async function setupTerminal(command: string, dir: string, terminal: string, herdr: HerdrTerminal | null = null): Promise<{ launched: boolean }> {
  if (process.platform === "win32") return setupOnWindows(command);
  const { launched } = await launchTerminal({ cwd: os.homedir(), command: `${command}\necho\nexec "\${SHELL:-bash}" -l`, dir, label: "setup" }, terminal, herdr);
  return { launched };
}

/**
 * A setup command in a PowerShell console window of its own. Detached, with no cmd in between to read the
 * command's `|`; the policy is lifted for this process alone, since the default `Restricted` refuses the
 * `.ps1` shim npm writes beside every `.cmd` (`npm.ps1`, `pi.ps1`, …), and PowerShell prefers the `.ps1`.
 */
export function setupOnWindows(command: string, launch: typeof spawn = spawn): Promise<{ launched: boolean }> {
  return new Promise((resolve) => {
    const child = launch("powershell.exe", ["-NoExit", "-ExecutionPolicy", "Bypass", "-Command", command], { cwd: os.homedir(), detached: true, stdio: "ignore" });
    child.once("error", () => resolve({ launched: false }));
    child.once("spawn", () => {
      child.unref();
      resolve({ launched: true });
    });
  });
}

export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const run = (cmd: string, args: string[], cwd?: string, env?: Record<string, string>) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, cwd, env: { ...process.env, ...env } }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/** Whether a command answers `--version` on this machine. */
export const commandOk = (cmd: string): Promise<boolean> => run(cmd, ["--version"]).then(() => true, () => false);

/** Run a command in a folder and return its stdout; the caller decides what a failure means. */
export const exec = (cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<string> => run(cmd, args, cwd, env);
