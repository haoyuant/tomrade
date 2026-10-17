import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/** Machine settings: which terminal opens, and how each coding agent is invoked in it. */
export const TerminalSettings = z.object({
  terminal: z.string().default("Terminal").meta({ title: "Terminal app" }).describe('Terminal, iTerm, Warp, Ghostty… — anything `open -a` knows. "none" only prepares the command for copying.'),
  claudeCommand: z.string().default('claude {options} --mcp-config "{mcpConfig}" --settings "{settings}" {resume} "$(cat "{prompt}")"').meta({ title: "Claude Code command" }),
  codexCommand: z.string().default('codex {resume} {options} -c mcp_servers.tomrade.url="{mcpUrl}" -c mcp_servers.tomrade.bearer_token_env_var="TOMRADE_MCP_TOKEN" "$(cat "{prompt}")"').meta({ title: "Codex command" }),
  piCommand: z.string().default('pi {options} -e "{piExtension}" {resume} "$(cat "{prompt}")"').meta({ title: "Pi command" }).describe("Pi takes no MCP flag; {piExtension} is a session-only extension that registers the server and reports like Claude's hooks."),
  /** WorkBuddy's CLI takes Claude Code's flags and posts Claude-shaped hooks. */
  workbuddyCommand: z.string().default('codebuddy {options} --mcp-config "{mcpConfig}" --settings "{settings}" {resume} "$(cat "{prompt}")"').meta({ title: "WorkBuddy command" }),
  /** Gemini CLI reads a session-only settings file as its lowest layer, so the person's own settings still win. */
  geminiCommand: z.string().default('GEMINI_CLI_SYSTEM_DEFAULTS_PATH="{geminiSettings}" gemini {options} {resume} -i "$(cat "{prompt}")"').meta({ title: "Gemini CLI command" }),
  opencodeCommand: z.string().default('OPENCODE_CONFIG="{opencodeConfig}" opencode {options} {resume} --prompt "$(cat "{prompt}")"').meta({ title: "OpenCode command" }),
  /** No interactive terminal of its own: one headless run, shown and reported through {dshReporter}, resumed by session id. */
  dshCommand: z.string().default('"{bin}" --profile headless --patch "{dshPatch}" --json {resume} - < "{prompt}" | ELECTRON_RUN_AS_NODE=1 "{node}" "{dshReporter}"').meta({ title: "DeepSeek Harness command" }).describe("DeepSeek Harness has no interactive terminal: the ticket runs as one headless run, shown through {dshReporter} and resumed with --session-id. {bin} is the dsh Tomrade found, the desktop app's own included; {dshPatch} adds Tomrade's server for this run."),
  hermesCommand: z.string().default('hermes chat {options} {resume} --query-file "{prompt}"').meta({ title: "Hermes command" }).describe("Hermes takes no MCP flag: it reads its tomrade server from its own config.yaml, the header naming the $TOMRADE_MCP_TOKEN this terminal exports. Connect it under Hermes in Settings first."),
  otherCommand: z.string().default("").meta({ title: "Other agent command" }).describe("Any other CLI agent with an MCP client — Gemini CLI, OpenCode, aider… Empty means none is set up. {mcpUrl}, {token} (also in $TOMRADE_MCP_TOKEN), {prompt}, {resume} (the bare session id) are filled in.")
});
export type TerminalSettings = z.infer<typeof TerminalSettings>;

/** The command template a terminal session starts an engine with; Claude Code's flags are the common ground. */
export function terminalTemplate(settings: TerminalSettings, engine: string): string {
  switch (engine) {
    case "codex": return settings.codexCommand;
    case "pi": return settings.piCommand;
    case "workbuddy": return settings.workbuddyCommand;
    case "gemini": return settings.geminiCommand;
    case "opencode": return settings.opencodeCommand;
    case "hermes": return settings.hermesCommand;
    case "dsh": return settings.dshCommand;
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
 * elsewhere the common emulators take `-e`. A terminal of "none" writes the
 * script and stops, for a person to run it themselves.
 */
export async function launchTerminal(input: LaunchInput, terminal: string): Promise<{ script: string; launched: boolean }> {
  fs.mkdirSync(input.dir, { recursive: true });
  const script = path.join(input.dir, "run.command");
  const exports = Object.entries(input.env ?? {}).map(([k, v]) => `export ${k}=${shellQuote(v)}`);
  // The script's own pid is the session's heartbeat: the shell outlives the agent
  // it runs by a moment and dies with the window, so "is the pid alive" answers
  // "is the session alive" whether or not a hook got to say so.
  const pidFile = path.join(input.dir, "pid");
  fs.writeFileSync(
    script,
    ["#!/bin/bash", `cd ${shellQuote(input.cwd)} || exit 1`, `echo $$ > ${shellQuote(pidFile)}`, `trap 'rm -f ${shellQuote(pidFile)}' EXIT`, ...exports, input.command, ""].join("\n"),
    { mode: 0o755 }
  );
  if (terminal === "none") return { script, launched: false };
  try {
    if (process.platform === "darwin") await run("open", ["-a", terminal, script]);
    else if (process.platform === "win32") await run("cmd", ["/c", "start", "", "bash", script]);
    else {
      try {
        await run("x-terminal-emulator", ["-e", `bash ${shellQuote(script)}`]);
      } catch {
        await run("gnome-terminal", ["--", "bash", script]);
      }
    }
    return { script, launched: true };
  } catch {
    return { script, launched: false };
  }
}

/**
 * Run one setup command where the person can watch it and answer its
 * questions: a new shell afterwards picks up a PATH the install just changed.
 * Windows gets PowerShell, which the official installers there are written for.
 */
export async function setupTerminal(command: string, dir: string, terminal: string): Promise<{ launched: boolean }> {
  if (process.platform === "win32") {
    // Detached, PowerShell gets a console window of its own; no cmd in between to read the command's `|`.
    return new Promise((resolve) => {
      const child = spawn("powershell.exe", ["-NoExit", "-Command", command], { cwd: os.homedir(), detached: true, stdio: "ignore" });
      child.once("error", () => resolve({ launched: false }));
      child.once("spawn", () => {
        child.unref();
        resolve({ launched: true });
      });
    });
  }
  const { launched } = await launchTerminal({ cwd: os.homedir(), command: `${command}\necho\nexec "\${SHELL:-bash}" -l`, dir }, terminal);
  return { launched };
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const run = (cmd: string, args: string[], cwd?: string, env?: Record<string, string>) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, cwd, env: { ...process.env, ...env } }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/** Whether a command answers `--version` on this machine. */
export const commandOk = (cmd: string): Promise<boolean> => run(cmd, ["--version"]).then(() => true, () => false);

/** Run a command in a folder and return its stdout; the caller decides what a failure means. */
export const exec = (cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<string> => run(cmd, args, cwd, env);
