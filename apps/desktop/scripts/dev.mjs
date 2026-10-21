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

// Ready means Vite printed its own URL: a connection to the port could reach another checkout's
// dev server. Resolves null when Vite exits first.
function startUi(port) {
  return new Promise((resolve, reject) => {
    const ui = spawn("pnpm", ["-F", "@tomradex/ui", "exec", "vite", "--host", host, "--port", String(port), "--strictPort"], {
      env: process.stdout.isTTY ? { ...process.env, FORCE_COLOR: "1" } : process.env,
      stdio: ["inherit", "pipe", "inherit"]
    });
    const url = `http://${host}:${port}/`;
    let output = "";
    const timer = setTimeout(() => { ui.kill("SIGTERM"); reject(new Error(`Vite did not start on ${host}:${port}`)); }, 15_000);
    ui.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      if (output === null) return;
      output += chunk.toString().replace(/\x1b\[[0-9;]*m/g, "");
      if (output.includes(url)) { output = null; clearTimeout(timer); resolve(ui); }
    });
    ui.once("exit", () => { if (output !== null) { clearTimeout(timer); resolve(null); } });
  });
}

// The built-in agent's Pi; a no-op once fetched. Offline, the app still starts without it.
const fetchPi = spawnSync("node", [path.join(path.dirname(fileURLToPath(import.meta.url)), "fetch-pi.mjs")], { stdio: "inherit" });
if (fetchPi.status !== 0) console.warn("Could not fetch the built-in agent; starting without it");
// The npm the app lends to machines without Node; same deal.
const fetchNpm = spawnSync("node", [path.join(path.dirname(fileURLToPath(import.meta.url)), "fetch-npm.mjs")], { stdio: "inherit" });
if (fetchNpm.status !== 0) console.warn("Could not fetch the bundled npm; starting without it");

let port = firstPort;
let ui;
for (;;) {
  while (!(await isAvailable(port))) port += 1;
  ui = await startUi(port);
  if (ui) break;
  // Another dev server took the port between the probe and Vite binding it; any other failure is real.
  if (await isAvailable(port)) process.exit(1);
  console.log(`Port ${port} was taken meanwhile; trying the next one`);
}

// Switching accounts restarts the app. Electron exits with this code and is
// started again here, because a self-relaunched app would outlive this script and its dev server.
const RESTART = 75;
const env = { ...process.env, VITE_DEV_SERVER_URL: `http://${host}:${port}`, TOMRADE_RESTART_EXIT_CODE: String(RESTART) };
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
