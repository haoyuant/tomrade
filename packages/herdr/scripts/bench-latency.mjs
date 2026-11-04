/*
 * How long what a program prints, and what the person types, take to reach Tomrade over herdr on this machine
 * (pnpm --filter @tomradex/herdr bench:latency; macOS and Linux, herdr installed). A herdr server of the run's own is
 * started, a pane runs a small program, and a control stream attaches to it as the Terminal window's does:
 *
 * - "output": the program prints a line stamped with the time every few tens of ms, as an agent draws its progress;
 * - "echo": the program echoes each key in raw mode; a key's latency is from sending it to the frame that paints it;
 * - "flood": the program prints as fast as it can for a few seconds; what the stream decoded, and the CPU it took.
 *
 * Inside a herdr pane HERDR_SOCKET_PATH names the person's server and wins over HERDR_SESSION: the pane's variables
 * are dropped first, and only this run's server is ever stopped.
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { herdrCall } from "../dist/client.js";
import { openTerminal } from "../dist/terminal.js";

// herdr paints only the cells that changed: what a frame says is read off a screen it is written to, as the window's xterm does.
const { Terminal } = createRequire(new URL("../../pty-host/package.json", import.meta.url))("@xterm/headless");

if (process.platform === "win32") {
  console.log("herdr runs on macOS and Linux only.");
  process.exit(0);
}
for (const key of ["HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_ENV"]) delete process.env[key];
const SESSION = `tomrade-bench-${process.pid}`;
const env = { ...process.env, HERDR_SESSION: SESSION };
const own = path.join(os.homedir(), ".config/herdr/sessions", SESSION, "herdr.sock");
const SAMPLES = Number(process.env.SAMPLES) || 80;
const FLOOD_S = Number(process.env.FLOOD_S) || 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const herdr = (...args) => execFileSync("herdr", args, { env, encoding: "utf8" });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-bench-"));

const server = spawn("herdr", ["server"], { env, stdio: "ignore" });
for (let i = 0; i < 50; i++) {
  try {
    if (herdr("status").includes(own)) break;
  } catch {
    // not up yet
  }
  await sleep(200);
}

const within = (what, promise, ms = 30_000) => Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`${what}: nothing within ${ms / 1000} s`)))]);

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return `median ${at(0.5).toFixed(1)} ms  p90 ${at(0.9).toFixed(1)} ms  max ${s.at(-1).toFixed(1)} ms  (${s.length} samples)`;
};

async function attach(name, script) {
  const file = path.join(work, `${name}.js`);
  fs.writeFileSync(file, script);
  const { root_pane } = await herdrCall(own, "workspace.create", { cwd: work, label: name, focus: false });
  await herdrCall(own, "pane.send_input", { pane_id: root_pane.pane_id, text: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`, keys: ["enter"] });
  const stream = openTerminal({ bin: "herdr", paneId: root_pane.pane_id, mode: "control", cols: 120, rows: 30, env });
  await within("attach", stream.settled);
  return stream;
}

async function output() {
  const script = `let n=0;const tick=()=>{process.stdout.write('T'+Date.now()+'\\r\\n');if(++n<${SAMPLES + 5})setTimeout(tick,20+Math.random()*40)};setTimeout(tick,1500)`;
  const stream = await attach("output", script);
  const screen = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
  const seen = new Set();
  const latencies = [];
  await within("output", new Promise((resolve) => {
    stream.onFrame((f) => {
      const now = Date.now();
      screen.write(f.bytes, () => {
        const b = screen.buffer.active;
        for (let y = 0; y < screen.rows; y++) {
          const stamp = /T(\d{13})/.exec(b.getLine(b.baseY + y)?.translateToString(true) ?? "")?.[1];
          if (!stamp || seen.has(stamp)) continue;
          seen.add(stamp);
          latencies.push(now - Number(stamp));
        }
        if (latencies.length >= SAMPLES) resolve();
      });
    });
  }));
  stream.close();
  screen.dispose();
  return latencies.slice(2);
}

async function echo() {
  const script = "process.stdin.setRawMode(true);process.stdin.on('data',(d)=>process.stdout.write(d));process.stdout.write('ready')";
  const stream = await attach("echo", script);
  let waiting = null;
  stream.onFrame((f) => {
    if (waiting && Buffer.from(f.bytes).toString("utf8").includes(waiting.key)) {
      waiting.done(performance.now() - waiting.at);
      waiting = null;
    }
  });
  await sleep(1500);
  const latencies = [];
  const keys = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < SAMPLES; i++) {
    const key = keys[i % keys.length];
    latencies.push(await within("echo", new Promise((resolve) => ((waiting = { key, at: performance.now(), done: resolve }), stream.input(key)))));
    await sleep(30 + Math.random() * 60);
    if (i % 40 === 39) stream.input("\r");
  }
  stream.close();
  return latencies;
}

async function flood() {
  const script = `const line='x'.repeat(110)+'\\r\\n';const end=Date.now()+${FLOOD_S * 1000 + 1500};let i=0;const go=()=>{if(Date.now()>end)return;let s='';for(let k=0;k<200;k++)s+=(i++)+' '+line;process.stdout.write(s,go)};setTimeout(go,1500)`;
  const stream = await attach("flood", script);
  let frames = 0;
  let bytes = 0;
  let first = 0;
  let last = 0;
  stream.onFrame((f) => {
    const now = performance.now();
    if (!first) first = now;
    last = now;
    frames++;
    bytes += f.bytes.length;
  });
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await sleep(FLOOD_S * 1000 + 2500);
  const cpu = process.cpuUsage(cpu0);
  const wall = performance.now() - t0;
  stream.close();
  const span = (last - first) / 1000 || 1;
  return `${frames} frames (${(frames / span).toFixed(0)}/s), ${(bytes / 1e6).toFixed(1)} MB (${(bytes / 1e6 / span).toFixed(1)} MB/s), this process ${(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(1)}% CPU`;
}

try {
  console.log(`herdr ${herdr("--version").trim()} on ${os.platform()} ${os.arch()}, ${SAMPLES} samples each`);
  console.log(`  output, print to frame: ${stats(await output())}`);
  console.log(`  echo, key to frame:     ${stats(await echo())}`);
  console.log(`  flood:                  ${await flood()}`);
} finally {
  try {
    if (herdr("status").includes(own)) herdr("server", "stop");
  } catch {
    // already gone
  }
  server.kill();
  fs.rmSync(path.dirname(own), { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
}
