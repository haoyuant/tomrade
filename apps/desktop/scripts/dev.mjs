import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const firstPort = Number(process.env.VITE_DEV_PORT ?? 5173);

function isAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function waitForServer(port) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > 15_000) reject(new Error(`Vite did not start on ${host}:${port}`));
        else setTimeout(check, 100);
      });
    };
    check();
  });
}

// The built-in agent's Pi; a no-op once fetched. Offline, the app still starts without it.
const fetchPi = spawnSync("node", [path.join(path.dirname(fileURLToPath(import.meta.url)), "fetch-pi.mjs")], { stdio: "inherit" });
if (fetchPi.status !== 0) console.warn("Could not fetch the built-in agent; starting without it");

let port = firstPort;
while (!(await isAvailable(port))) port += 1;

// Switching accounts restarts the app. Electron exits with this code and is
// started again here, because a self-relaunched app would outlive this script and its dev server.
const RESTART = 75;
const env = { ...process.env, VITE_DEV_SERVER_URL: `http://${host}:${port}`, TOMRADE_RESTART_EXIT_CODE: String(RESTART) };
const ui = spawn("pnpm", ["-F", "@tomradex/ui", "exec", "vite", "--host", host, "--port", String(port)], { env, stdio: "inherit" });
await waitForServer(port);
let electron;
let shuttingDown = false;
const startElectron = () => {
  electron = spawn("pnpm", ["exec", "electron", "."], { env, stdio: "inherit" });
  electron.once("exit", (code) => {
    if (shuttingDown) return;
    if (code === RESTART) startElectron();
    else stop(code ?? 0);
  });
};

const stop = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  ui.kill("SIGTERM");
  // Electron publishes what it has not synced on SIGTERM; give it the time before this script goes.
  if (electron.exitCode === null && electron.signalCode === null) {
    electron.once("exit", () => process.exit(code));
    electron.kill("SIGTERM");
    setTimeout(() => process.exit(code), 8_000).unref();
  } else setTimeout(() => process.exit(code), 100);
};

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
ui.once("exit", (code) => { if (!shuttingDown && code !== 0) stop(code ?? 1); });
startElectron();

console.log(`Tomrade UI: http://${host}:${port}`);
