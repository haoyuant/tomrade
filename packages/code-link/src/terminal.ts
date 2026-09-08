import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Machine settings: which terminal opens, and how each coding agent is invoked in it. */
export const TerminalSettings = z.object({
  /** Terminal, iTerm, Warp, Ghostty… — anything `open -a` knows; "none" only prepares the command for copying. */
  terminal: z.string().default("Terminal"),
  claudeCommand: z.string().default('claude --mcp-config "{mcpConfig}" --settings "{settings}" {resume} "$(cat "{prompt}")"'),
  codexCommand: z.string().default('codex {resume} -c mcp_servers.tomrade.url="{mcpUrl}" -c mcp_servers.tomrade.bearer_token_env_var="TOMRADE_MCP_TOKEN" "$(cat "{prompt}")"'),
  /** Any other CLI agent with an MCP client — Gemini CLI, OpenCode, aider… Empty means none is set up. {mcpUrl}, {token} (also in $TOMRADE_MCP_TOKEN), {prompt}, {resume} (the bare session id) are filled in. */
  otherCommand: z.string().default("")
});
export type TerminalSettings = z.infer<typeof TerminalSettings>;

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

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const run = (cmd: string, args: string[], cwd?: string) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, cwd }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/** Whether a command answers `--version` on this machine. */
export const commandOk = (cmd: string): Promise<boolean> => run(cmd, ["--version"]).then(() => true, () => false);

/** Run a command in a folder and return its stdout; the caller decides what a failure means. */
export const exec = (cmd: string, args: string[], cwd: string): Promise<string> => run(cmd, args, cwd);
