import net from "node:net";
import { spawn } from "node:child_process";

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

let port = firstPort;
while (!(await isAvailable(port))) port += 1;

const env = { ...process.env, VITE_DEV_SERVER_URL: `http://${host}:${port}` };
const ui = spawn("pnpm", ["-F", "@tomrade/ui", "exec", "vite", "--host", host, "--port", String(port)], { env, stdio: "inherit" });
await waitForServer(port);
const electron = spawn("pnpm", ["exec", "electron", "."], { env, stdio: "inherit" });
let shuttingDown = false;

const stop = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  ui.kill("SIGTERM");
  electron.kill("SIGTERM");
  setTimeout(() => process.exit(code), 100);
};

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
ui.once("exit", (code) => { if (!shuttingDown && code !== 0) stop(code ?? 1); });
electron.once("exit", (code) => { if (!shuttingDown) stop(code ?? 0); });

console.log(`Tomrade UI: http://${host}:${port}`);
