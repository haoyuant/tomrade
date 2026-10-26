import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import type { SpawnPty } from "./host.js";
import type { Pane } from "./pane.js";

/** A program on a pseudoconsole: node-pty over ConPTY with the OpenConsole it ships, the same on Windows 10 and 11 and twice as fast as the system's conhost. */
export const spawnConpty: SpawnPty = (file, args, opts) => {
  const pty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
  return pty.spawn(file, args, { name: "xterm-256color", cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows, useConpty: true, useConptyDll: true });
};

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
