import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { TerminalProvider } from "@tomradex/contracts";
import { CODE_WORDS } from "./words.js";

/** The terminal until the person picks one: it follows what this machine has. */
export const AUTO_TERMINAL = "auto";

/** Tomrade's own terminal on native Windows: a pane of its pty host, shown in the Terminal window as herdr's are elsewhere. */
export const BUILTIN_TERMINAL = "builtin";

/** Machine settings: which terminal opens, and how each coding agent is invoked in it. */
export const TerminalSettings = z.object({
  terminal: z.string().default(AUTO_TERMINAL).meta({ title: "Open in a terminal app of your own", advanced: true }).describe(CODE_WORDS("en")("terminalOwnHelp")),
  claudeCommand: z.string().default('"{bin}" {options} --mcp-config "{mcpConfig}" --settings "{settings}" {resume} "$(cat "{prompt}")"').meta({ title: "Claude Code command", advanced: true }),
  codexCommand: z.string().default('"{bin}" {resume} {options} -c mcp_servers.tomrade.url="{mcpUrl}" -c mcp_servers.tomrade.bearer_token_env_var="TOMRADE_MCP_TOKEN" "$(cat "{prompt}")"').meta({ title: "Codex command", advanced: true }),
  piCommand: z.string().default('"{bin}" {options} -e "{piExtension}" {resume} "$(cat "{prompt}")"').meta({ title: "Pi command", advanced: true }).describe("Pi takes no MCP flag; {piExtension} is a session-only extension that registers the server and reports like Claude's hooks."),
  /** WorkBuddy's CLI takes Claude Code's flags and posts Claude-shaped hooks. */
  workbuddyCommand: z.string().default('"{bin}" {options} --mcp-config "{mcpConfig}" --settings "{settings}" {resume} "$(cat "{prompt}")"').meta({ title: "WorkBuddy command", advanced: true }),
  /** Gemini CLI runs from a session home: the person's own ~/.gemini, with Tomrade's server and the hooks that report the session added to its settings. */
  geminiCommand: z.string().default('GEMINI_CLI_HOME="{geminiHome}" "{bin}" {options} {resume} -i "$(cat "{prompt}")"').meta({ title: "Gemini CLI command", advanced: true }).describe("{geminiHome} is a Gemini home for this session alone: your own ~/.gemini (sign-in, extensions, history) with Tomrade's server, and hooks that report the session to it, added to a copy of its settings. Your own files are not changed."),
  opencodeCommand: z.string().default('OPENCODE_CONFIG="{opencodeConfig}" "{bin}" {options} {resume} --prompt "$(cat "{prompt}")"').meta({ title: "OpenCode command", advanced: true }),
  /** No interactive terminal of its own: one headless run, shown and reported through {dshReporter}, resumed by session id. */
  dshCommand: z.string().default('"{bin}" --profile headless --patch "{dshPatch}" --json {resume} - < "{prompt}" | TOMRADE_PROMPT_FILE="{prompt}" ELECTRON_RUN_AS_NODE=1 "{node}" "{dshReporter}"').meta({ title: "DeepSeek Harness command", advanced: true }).describe("DeepSeek Harness has no interactive terminal: the ticket runs as one headless run, shown through {dshReporter} and resumed with --session-id. {bin} is the dsh Tomrade found, the desktop app's own included; {dshPatch} adds Tomrade's server for this run."),
  /** Antigravity's CLI reads Tomrade's server from its own config; the ticket's prompt asks it to claim first. */
  agyCommand: z.string().default('"{bin}" {options} {resume} -i "$(cat "{prompt}")"').meta({ title: "Antigravity CLI command", advanced: true }).describe("agy takes no MCP flag: it reaches Tomrade through its own user-level tomrade server (connect it under Antigravity CLI in Settings), and claims the ticket first."),
  /** Cursor's CLI reads Tomrade's server from ~/.cursor/mcp.json; the ticket's prompt asks it to claim first. */
  cursorCommand: z.string().default('"{bin}" {options} {resume} "$(cat "{prompt}")"').meta({ title: "Cursor command", advanced: true }).describe("cursor-agent takes no MCP flag: it reaches Tomrade through its own user-level tomrade server (connect it under Cursor in Settings), and claims the ticket first."),
  hermesCommand: z.string().default('"{bin}" chat {options} {resume} --query-file "{prompt}"').meta({ title: "Hermes command", advanced: true }).describe("Hermes takes no MCP flag: it reads its tomrade server from its own config.yaml, the header naming the $TOMRADE_MCP_TOKEN this terminal exports. Connect it under Hermes in Settings first."),
  otherCommand: z.string().default("").meta({ title: "Other agent command", advanced: true }).describe("Any other CLI agent with an MCP client — Gemini CLI, OpenCode, aider… Empty means none is set up. {mcpUrl}, {token} (also in $TOMRADE_MCP_TOKEN), {prompt}, {resume} (the bare session id) are filled in.")
});
export type TerminalSettings = z.infer<typeof TerminalSettings>;

/**
 * The section as this machine runs it. A terminal left on automatic is looked
 * at again each time — herdr once it is installed (on Windows, Tomrade's own
 * terminal host), the system terminal until then — and an app of the person's
 * own stays as it is. herdr or the built-in terminal picked by name, from when
 * they were choices, reads as automatic: the same panes where there are any.
 */
export async function machineTerminalSettings(stored: unknown, panes: Pick<PaneTerminal, "kind" | "installed"> | null | undefined, platform: NodeJS.Platform = process.platform): Promise<TerminalSettings> {
  const settings = TerminalSettings.parse(stored ?? {});
  if (!isAutoTerminal(settings.terminal)) return settings;
  // herdr has no Windows build and its bridge refuses Windows; the pty host runs only there.
  const own = platform === "win32" ? "builtin" : "herdr";
  return { ...settings, terminal: panes?.kind === own && (await panes.installed()) ? terminalOf(own) : SYSTEM_TERMINAL };
}

const terminalOf = (kind: PaneTerminal["kind"]) => (kind === "builtin" ? BUILTIN_TERMINAL : "herdr");

/** Automatic, or a pane backend picked by name before it stopped being a choice. */
export const isAutoTerminal = (terminal: string): boolean => terminal === AUTO_TERMINAL || terminal === "herdr" || terminal === BUILTIN_TERMINAL;

/** The backend whose panes a terminal setting opens; null for a terminal app. */
export const panesOf = (terminal: string): PaneTerminal["kind"] | null => (terminal === "herdr" ? "herdr" : terminal === BUILTIN_TERMINAL ? "builtin" : null);

const TERMINAL_APPS = new Set(["terminal", "iterm", "iterm2", "warp", "ghostty", "alacritty", "kitty", "wezterm", "hyper", "tabby", "rio", "wave"]);

/**
 * Linux emulators Tomrade knows, each with what it runs a program after: x-terminal-emulator and gnome-terminal
 * are the default chain, the rest are picked by name.
 */
const LINUX_TERMINALS: Record<string, string[]> = {
  "x-terminal-emulator": ["-e"],
  "gnome-terminal": ["--"],
  konsole: ["-e"],
  "xfce4-terminal": ["-x"],
  kitty: [],
  alacritty: ["-e"],
  wezterm: ["start", "--"]
};

/** The arguments that make a Linux emulator run `bash script`; one Tomrade does not know gets the common `-e`. */
function linuxArgs(terminal: string, script: string): string[] {
  return [...(LINUX_TERMINALS[path.posix.basename(terminal)] ?? ["-e"]), "bash", script];
}

/** The Linux emulators on PATH, and $TERMINAL where it names one that is there. */
function linuxTerminals(env: NodeJS.ProcessEnv = process.env, runnable: (file: string) => boolean = isExecutable): string[] {
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  const there = (name: string) => (name.includes("/") ? runnable(name) : dirs.some((dir) => runnable(path.posix.join(dir, name))));
  const own = env.TERMINAL?.trim();
  return [...new Set([...(own ? [own] : []), ...Object.keys(LINUX_TERMINALS)])].filter(there);
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A terminal app of the person's own to open sessions in instead: installed macOS bundles that `open -a` can launch, the Linux emulators found, then none. */
export function terminalApps(roots = ["/Applications", path.join(os.homedir(), "Applications"), "/System/Applications"], platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "win32") return ["none"];
  if (platform !== "darwin") return [...linuxTerminals(env), "none"];
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
  return [...found].sort((a, b) => a.localeCompare(b)).concat("none");
}

/** Each engine's template setting, and the bare command its default ran before it named the located CLI. */
const TEMPLATES: Record<string, { key: keyof TerminalSettings; bare?: string }> = {
  "claude-code": { key: "claudeCommand", bare: "claude" },
  codex: { key: "codexCommand", bare: "codex" },
  pi: { key: "piCommand", bare: "pi" },
  workbuddy: { key: "workbuddyCommand", bare: "codebuddy" },
  gemini: { key: "geminiCommand", bare: "gemini" },
  opencode: { key: "opencodeCommand", bare: "opencode" },
  hermes: { key: "hermesCommand", bare: "hermes" },
  dsh: { key: "dshCommand", bare: "dsh" },
  agy: { key: "agyCommand", bare: "agy" },
  cursor: { key: "cursorCommand", bare: "cursor-agent" },
  other: { key: "otherCommand" }
};

/** The command template a terminal session starts an engine with: the engine's own, else the setting's, Claude Code's flags as the common ground. */
export function terminalTemplate(settings: TerminalSettings, engine: string, declared?: string): string {
  if (declared?.trim()) return declared.trim();
  const { key, bare } = TEMPLATES[engine] ?? TEMPLATES["claude-code"]!;
  let template = settings[key];
  // A template saved before Gemini 0.64 ignored a system defaults file root does not own.
  if (key === "geminiCommand") template = template.replace(/GEMINI_CLI_SYSTEM_DEFAULTS_PATH=("?)\{geminiSettings\}\1/, 'GEMINI_CLI_HOME="{geminiHome}"');
  // A default saved as it was, with the bare name a terminal without Tomrade's folders cannot find, is today's default.
  const now = DEFAULT_TEMPLATES[key];
  return bare && template === now.replace('"{bin}"', bare) ? now : template;
}

const DEFAULT_TEMPLATES = TerminalSettings.parse({});

/** The command name an engine's template runs when Tomrade found no CLI for its {bin}. */
export function bareCommand(engine: string): string {
  return (TEMPLATES[engine] ?? TEMPLATES["claude-code"]!).bare ?? engine;
}

export interface LaunchInput {
  cwd: string;
  command: string;
  /** Environment the script exports before the command. */
  env?: Record<string, string>;
  /** Folders the script puts on PATH around the terminal's own. */
  path?: TerminalPath;
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

/** What a terminal of "herdr" or "builtin" is run through: a pane with the script going in it, on a backend started for it when none runs. */
export type PaneTerminal = Pick<TerminalProvider, "kind" | "launch" | "installed">;

export interface LaunchResult {
  script: string;
  launched: boolean;
  /** The herdr pane the script runs in, when the terminal is herdr. */
  paneId?: string;
  /** The terminal is herdr, and herdr did not answer: the script went to the system terminal instead. */
  herdrMissing?: "notInstalled" | "notRunning";
  /** The terminal is Tomrade's own, and its host did not start: the script went to the system terminal instead. */
  hostFailed?: true;
  /** herdr was not running and Tomrade started its server for this launch; "first" the first time ever on this machine. */
  herdrStarted?: "first" | "again";
  /** On Windows, no Git Bash to run the script with: nothing opened. */
  gitBashMissing?: true;
}

/** Where a herdr launch goes when herdr does not answer; off macOS the platform's own emulator is used whatever the name. */
export const SYSTEM_TERMINAL = "Terminal";

/**
 * Git Bash where Git for Windows and Scoop install it, else beside the git on PATH (`cmd\git.exe` → `bin\bash.exe`),
 * else a bash.exe on PATH. WSL's bash.exe (System32, the WindowsApps alias) sees another filesystem, so it never counts.
 */
export function gitBash(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): string | null {
  const w = path.win32;
  const scoop = env.SCOOP ?? (env.USERPROFILE && w.join(env.USERPROFILE, "scoop"));
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && w.join(env.LOCALAPPDATA, "Programs")].filter((dir): dir is string => !!dir).map((dir) => w.join(dir, "Git"));
  if (scoop) roots.push(w.join(scoop, "apps", "git", "current"));
  const installed = roots.map((dir) => w.join(dir, "bin", "bash.exe")).find(exists);
  if (installed) return installed;
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const dirs = pathValue.split(";").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean);
  for (const dir of dirs) {
    if (!exts.some((ext) => exists(w.join(dir, `git${ext.toLowerCase()}`)))) continue;
    // cmd and bin sit beside bin; mingw64\bin and usr\bin one level deeper.
    const beside = [w.join(dir, "..", "bin", "bash.exe"), w.join(dir, "..", "..", "bin", "bash.exe")].find(exists);
    if (beside) return beside;
  }
  const wsl = (dir: string) => /\\(system32|sysnative)$|\\windowsapps$/i.test(w.normalize(dir).replace(/\\+$/, ""));
  return dirs.filter((dir) => !wsl(dir)).map((dir) => w.join(dir, "bash.exe")).find(exists) ?? null;
}

/** Thrown when Windows has no Git Bash to run a session's script. */
export class GitBashMissing extends Error {
  constructor() {
    super("Git Bash is not installed");
  }
}

/**
 * Where a terminal finds a CLI the way Tomrade runs it: the CLI's own folder and those a fresh PATH added ahead of
 * the terminal's PATH, Tomrade's node shims behind it, so a Node of the person's own still wins. With no CLI
 * found, only the shims: node and npm for a terminal install on a machine without Node.
 */
export interface TerminalPath {
  ahead: string[];
  behind: string[];
}

export function terminalPath(cli: { path?: string; pathDirs?: string[] } | null | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): TerminalPath {
  const p = platform === "win32" ? path.win32 : path.posix;
  return { ahead: cli?.path ? [p.dirname(cli.path), ...(cli.pathDirs ?? [])] : [], behind: env.TOMRADE_NODE_SHIMS ? [env.TOMRADE_NODE_SHIMS] : [] };
}

/** The script's PATH line, or null with nothing to add; Git Bash on Windows names `C:\x` as `/c/x`. */
export function pathExport(dirs: TerminalPath, platform: NodeJS.Platform = process.platform): string | null {
  if (!dirs.ahead.length && !dirs.behind.length) return null;
  const unix = (dir: string) => (platform === "win32" ? dir.replace(/^([A-Za-z]):[\\/]*/, (_, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, "/") : dir);
  const part = (list: string[]) => (list.length ? [shellQuote(list.map(unix).join(":"))] : []);
  return `export PATH=${[...part(dirs.ahead), '"$PATH"', ...part(dirs.behind)].join(":")}`;
}

/** PowerShell's form of the PATH line, for the setup console on Windows. */
export function powerShellPath(dirs: TerminalPath): string {
  return `$env:Path = ${[...dirs.ahead.map((dir) => psQuote(`${dir};`)), "$env:Path", ...dirs.behind.map((dir) => psQuote(`;${dir}`))].join(" + ")}`;
}

/** A setup command that starts with the CLI's bare name, run as the file Tomrade located instead. */
export function locatedCommand(command: string, name: string, file: string | undefined, platform: NodeJS.Platform = process.platform): string {
  const [first, ...rest] = command.split(" ");
  if (!file || first !== name) return command;
  return [platform === "win32" ? `& ${psQuote(file)}` : shellQuote(file), ...rest].join(" ");
}

/**
 * A script on Windows: Git Bash runs it in Windows Terminal, in the session's folder, as the Terminal window's New
 * terminal opens there; without Windows Terminal, in a console window of its own. Resolves with the app it opened.
 */
export function openOnWindows(script: string, cwd: string, bash: string | null = gitBash(), launch: typeof spawn = spawn): Promise<string> {
  if (!bash) return Promise.reject(new GitBashMissing());
  const start = (command: string, args: string[]) => startDetached(launch, command, args, cwd);
  return start("wt.exe", ["-d", cwd, bash, script]).then(
    () => "Windows Terminal",
    () => start(bash, [script]).then(() => "Git Bash")
  );
}

/**
 * A script on Linux: detached, since most emulators stay in the foreground until their window closes; the script
 * as its own argument, as several emulators read one `-e` string as a program name. Resolves with the app it opened.
 */
export function openOnLinux(script: string, cwd: string, launch: typeof spawn = spawn, terminal: string = SYSTEM_TERMINAL): Promise<string> {
  const chain = ["x-terminal-emulator", "gnome-terminal"];
  // One picked by name goes first; the default chain still catches it when it cannot start.
  if (terminal !== SYSTEM_TERMINAL && !chain.includes(terminal)) chain.unshift(terminal);
  else if (terminal === "gnome-terminal") chain.reverse();
  return chain.reduce<Promise<string>>((tried, app) => tried.catch(() => startDetached(launch, app, linuxArgs(app, script), cwd).then(() => app)), Promise.reject(new Error("no terminal")));
}

/** Resolves once the app has started, without waiting for it to exit; rejects when it cannot start. */
function startDetached(launch: typeof spawn, command: string, args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = launch(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Hands a script to a terminal app; an object so tests can stand in for the app. */
export const terminalApp = {
  async open(terminal: string, script: string, cwd: string = os.homedir()): Promise<void> {
    if (process.platform === "darwin") await run("open", ["-a", terminal, script]);
    else if (process.platform === "win32") await openOnWindows(script, cwd);
    else await openOnLinux(script, cwd, spawn, terminal);
  }
};

/** What to tell the person after a launch: that it went elsewhere, that Windows has no Git Bash to run it, or — once — that Tomrade started herdr in the background. Null otherwise. */
export function herdrFallbackNote(locale: unknown, launch: LaunchResult): string | null {
  const w = CODE_WORDS(locale);
  if (launch.herdrStarted === "first") return w("herdrStartedInBackground");
  const noBash = launch.gitBashMissing ? w("gitBashMissing") : null;
  if (!launch.herdrMissing && !launch.hostFailed) return noBash;
  const app = process.platform === "darwin" ? SYSTEM_TERMINAL : w("systemTerminal");
  const note = launch.hostFailed ? w("hostFailedFallback", { app }) : launch.herdrMissing === "notInstalled" ? w("herdrNotInstalledFallback", { app }) : w("herdrNotRunningFallback", { app });
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
export async function launchTerminal(input: LaunchInput, terminal: string, panes: PaneTerminal | null = null, platform: NodeJS.Platform = process.platform, bash: () => string | null = gitBash): Promise<LaunchResult> {
  fs.mkdirSync(input.dir, { recursive: true });
  const script = path.join(input.dir, "run.command");
  const exports = Object.entries(input.env ?? {}).map(([k, v]) => `export ${k}=${shellQuote(v)}`);
  const onPath = input.path && pathExport(input.path);
  if (onPath) exports.push(onPath);
  // The script's own pid is the session's heartbeat: the shell outlives the agent
  // it runs by a moment and dies with the window, so "is the pid alive" answers
  // "is the session alive" whether or not a hook got to say so.
  const pidFile = path.join(input.dir, "pid");
  // Git Bash's $$ is an MSYS pid that process.kill cannot see; /proc/$$/winpid is the Windows one.
  const writePid = platform === "win32" ? `{ cat /proc/$$/winpid 2>/dev/null || echo $$; } > ${shellQuote(pidFile)}` : `echo $$ > ${shellQuote(pidFile)}`;
  // Windows Terminal and Linux emulators close the window with its shell; a shell of the person's own keeps it open
  // to read, the pid file gone first as the EXIT trap would have, since exec skips the trap.
  const keepOpen = `rm -f ${shellQuote(pidFile)}\nexec "\${SHELL:-bash}"`;
  const wrap = (command: string, stay = false) => ["#!/bin/bash", `cd ${shellQuote(input.cwd)} || exit 1`, writePid, `trap 'rm -f ${shellQuote(pidFile)}' EXIT`, ...exports, command, ...(stay ? [keepOpen] : []), ""].join("\n");
  const systemWindow = (app: string) => platform !== "darwin" && app !== "none" && app !== "herdr";
  fs.writeFileSync(script, wrap(input.command, systemWindow(terminal)), { mode: 0o755 });
  // The same wrapper around the resume: the pid file and the token come back with the session.
  if (input.resume) fs.writeFileSync(path.join(input.dir, RESUME_SCRIPT), wrap(input.resume), { mode: 0o755 });
  if (terminal === "none") return { script, launched: false };
  let missing: Pick<LaunchResult, "herdrMissing" | "hostFailed"> = {};
  const kind = panesOf(terminal);
  if (kind) {
    // Git Bash runs the script in the pty host's pane, as it would in Windows Terminal.
    const shell = kind === "builtin" ? bash() : null;
    if (kind === "builtin" && !shell) return { script, launched: false, gitBashMissing: true };
    // The script, not the command: the pid file and the exports come along, and the shell stays after the agent for the person to read.
    const pane = panes?.kind === kind ? await panes.launch({ cwd: input.cwd, label: input.label, command: `bash ${shellQuote(script)}`, ...(shell ? { program: { file: shell, args: [script] } } : {}), ...(input.workspace ? { workspace: input.workspace } : {}) }) : null;
    if (pane) return { script, launched: true, paneId: pane.paneId, ...(pane.startedServer ? { herdrStarted: pane.startedServer } : {}) };
    missing = kind === "builtin" ? { hostFailed: true } : { herdrMissing: (await panes?.installed()) ? "notRunning" : "notInstalled" };
    terminal = SYSTEM_TERMINAL;
    if (systemWindow(terminal)) fs.writeFileSync(script, wrap(input.command, true), { mode: 0o755 });
  }
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
export async function setupTerminal(command: string, dir: string, terminal: string, panes: PaneTerminal | null = null, dirs?: TerminalPath): Promise<{ launched: boolean }> {
  if (process.platform === "win32") return setupOnWindows(dirs && (dirs.ahead.length || dirs.behind.length) ? `${powerShellPath(dirs)}; ${command}` : command);
  const { launched } = await launchTerminal({ cwd: os.homedir(), command: `${command}\necho\nexec "\${SHELL:-bash}" -l`, dir, label: "setup", ...(dirs ? { path: dirs } : {}) }, terminal, panes);
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

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

const run = (cmd: string, args: string[], cwd?: string, env?: Record<string, string>) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, cwd, env: { ...process.env, ...env } }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/** Whether a command answers `--version` on this machine. */
export const commandOk = (cmd: string): Promise<boolean> => run(cmd, ["--version"]).then(() => true, () => false);

/** Run a command in a folder and return its stdout; the caller decides what a failure means. */
export const exec = (cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<string> => run(cmd, args, cwd, env);
