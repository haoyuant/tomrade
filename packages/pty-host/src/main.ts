import fs from "node:fs";
import path from "node:path";
import { killTree, scanProcesses, spawnConpty } from "./conpty.js";
import { Host, serve } from "./host.js";
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

let server: Awaited<ReturnType<typeof serve>> | null = null;
const host = new Host({
  spawn: spawnConpty,
  shell: () => defaultShell(process.env),
  killTree,
  scan: () => scanProcesses(),
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
