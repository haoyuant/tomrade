import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { parseProcessTable, type ProcessRow } from "./agents.js";
import type { SpawnPty } from "./host.js";
import type { Pane } from "./pane.js";

/** A program on a pseudoconsole: node-pty over ConPTY with the OpenConsole it ships, the same on Windows 10 and 11 and twice as fast as the system's conhost. */
export const spawnConpty: SpawnPty = (file, args, opts) => {
  const pty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
  return pty.spawn(file, args, { name: "xterm-256color", cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows, useConpty: true, useConptyDll: true });
};

/** Every process's pid, parent, start (FILETIME), name and command line, one per line, tabs between; UTF-8 for names in any script. */
const PROCESS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine | ForEach-Object {",
  "  $created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }",
  "  \"$($_.ProcessId)`t$($_.ParentProcessId)`t$created`t$($_.Name)`t$($_.CommandLine -replace '[\\r\\n\\t]', ' ')\"",
  "}"
].join("\n");

/** The process table, through Windows PowerShell (always there); rejects when it fails or takes longer than `timeoutMs`. */
export function scanProcesses(timeoutMs = 15_000): Promise<ProcessRow[]> {
  const encoded = Buffer.from(PROCESS_SCRIPT, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(parseProcessTable(stdout));
    });
  });
}

/**
 * Ends a pane's process and everything it started. taskkill /T walks the tree from the live root, so it goes first;
 * node-pty's kill then closes the console (its helper's "AttachConsole failed" goes to the host's ignored stderr).
 */
export function killTree(pane: Pane): Promise<void> {
  return new Promise<void>((resolve) => {
    execFile("taskkill", ["/T", "/F", "/PID", String(pane.pid)], { windowsHide: true }, () => {
      try {
        pane.pty.kill();
      } catch {
        // already gone
      }
      resolve();
    });
  });
}
