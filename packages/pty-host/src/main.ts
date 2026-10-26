import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Host, serve, type SpawnPty } from "./host.js";
import { PROTOCOL } from "./protocol.js";
import { defaultShell } from "./shell.js";

/*
 * The pty host's own process: Electron's binary run as Node
 * (ELECTRON_RUN_AS_NODE), started detached by the app so its terminals outlive
 * it. Everything it needs comes in its environment.
 */

const pipe = process.env.TOMRADE_PTY_PIPE;
const logFile = process.env.TOMRADE_PTY_LOG;
const version = process.env.TOMRADE_PTY_VERSION ?? "0";
const idleMs = Number(process.env.TOMRADE_PTY_IDLE_MS) || 30_000;

const log = (text: string) => {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${text}\n`);
  } catch {
    // nowhere to say it
  }
};

if (!pipe) {
  log("no pipe named; exiting");
  process.exit(2);
}

const pty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

// useConptyDll: the OpenConsole shipped with node-pty, the same on Windows 10 and 11 and twice as fast as the system's conhost.
const spawn: SpawnPty = (file, args, opts) => pty.spawn(file, args, { name: "xterm-256color", cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows, useConpty: true, useConptyDll: true });

/** taskkill /T walks the tree from the live root, so it goes first; node-pty's kill then frees the console. */
const killTree: ConstructorParameters<typeof Host>[0]["killTree"] = (pane) =>
  new Promise<void>((resolve) => {
    execFile("taskkill", ["/T", "/F", "/PID", String(pane.pid)], { windowsHide: true }, () => {
      try {
        pane.pty.kill();
      } catch {
        // already gone
      }
      resolve();
    });
  });

let server: Awaited<ReturnType<typeof serve>> | null = null;
const host = new Host({
  spawn,
  shell: () => defaultShell(process.env),
  killTree,
  version,
  idleMs,
  log,
  onIdle: () => {
    log("no terminals left; exiting");
    server?.close();
    process.exit(0);
  }
});

process.on("uncaughtException", (err) => log(`uncaught: ${err.stack ?? err.message}`));
process.on("unhandledRejection", (err) => log(`unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));

serve(host, pipe).then(
  (s) => {
    server = s;
    log(`listening on ${pipe} (protocol ${PROTOCOL}, ${version})`);
  },
  (err: Error) => {
    // Another host answers there already (two starts at once): that one serves.
    log(`could not listen on ${pipe}: ${err.message}`);
    process.exit(0);
  }
);
