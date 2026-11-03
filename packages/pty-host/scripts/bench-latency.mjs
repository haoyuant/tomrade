/*
 * How long what a program prints, and what the person types, take to reach the window, on a real pseudoconsole and
 * pipe (pnpm --filter @tomradex/pty-host bench:latency; Windows only). A host serves a pipe as Tomrade's does and a
 * terminal attaches to it as the main process does:
 *
 * - "output": a program prints a line stamped with the time every few tens of ms, as an agent draws its progress;
 *   each stamp's latency is the time its frame reaches the terminal;
 * - "echo": a program in raw mode echoes each key; each key's latency is the time from sending it to the frame that
 *   paints it.
 *
 * Both include ConPTY's own paint; that part is the same whatever the host does.
 */
import os from "node:os";
import { performance } from "node:perf_hooks";
import { openTerminal, hostCall } from "../dist/client.js";
import { killTree, spawnConpty } from "../dist/conpty.js";
import { Host, serve } from "../dist/host.js";

if (process.platform !== "win32") {
  console.log("ConPTY latency is measured on Windows only.");
  process.exit(0);
}
const SAMPLES = Number(process.env.SAMPLES) || 80;

const host = new Host({ spawn: spawnConpty, shell: () => ({ file: "cmd.exe", args: [] }), killTree, version: "bench", idleMs: 60_000, onIdle: () => undefined });
const pipe = `\\\\.\\pipe\\tomrade-pty-bench-latency-${process.pid}`;
const server = await serve(host, pipe);

async function attach(script) {
  const { pane_id } = await hostCall(pipe, "pane.launch", { cwd: os.tmpdir(), file: process.execPath, args: ["-e", script], env: { ...process.env }, cols: 120, rows: 30 });
  const stream = openTerminal(pipe, { paneId: pane_id, mode: "control", cols: 120, rows: 30 });
  await stream.attached;
  return stream;
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return `median ${at(0.5).toFixed(1)} ms  p90 ${at(0.9).toFixed(1)} ms  max ${s.at(-1).toFixed(1)} ms  (${s.length} samples)`;
};

async function output() {
  // Stamps in ms since the epoch, which both processes read off the same clock.
  const script = `let n=0;const tick=()=>{process.stdout.write('T'+Date.now()+'\\r\\n');if(++n<${SAMPLES + 5})setTimeout(tick,20+Math.random()*40)};setTimeout(tick,500)`;
  const stream = await attach(script);
  const seen = new Set();
  const latencies = [];
  await new Promise((resolve) => {
    stream.onFrame((f) => {
      const now = Date.now();
      for (const [, stamp] of Buffer.from(f.bytes).toString("utf8").matchAll(/T(\d{13})/g)) {
        if (seen.has(stamp)) continue;
        seen.add(stamp);
        latencies.push(now - Number(stamp));
      }
      if (latencies.length >= SAMPLES) resolve();
    });
  });
  stream.close();
  return latencies.slice(2);
}

async function echo() {
  const script = "process.stdin.setRawMode(true);process.stdin.on('data',(d)=>process.stdout.write(d));process.stdout.write('ready')";
  const stream = await attach(script);
  let waiting = null;
  stream.onFrame((f) => {
    if (!waiting) return;
    if (Buffer.from(f.bytes).toString("utf8").includes(waiting.key)) {
      waiting.done(performance.now() - waiting.at);
      waiting = null;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const latencies = [];
  const keys = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < SAMPLES; i++) {
    const key = keys[i % keys.length];
    latencies.push(
      await new Promise((resolve) => {
        waiting = { key, at: performance.now(), done: resolve };
        stream.input(key);
      })
    );
    // Some time between keys, as a person types, at a random phase of the platform's timer tick.
    await new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 60));
    if (i % 40 === 39) stream.input("\r");
  }
  stream.close();
  return latencies;
}

console.log(`Latency on ConPTY over a pipe, ${SAMPLES} samples each`);
console.log(`  output, print to frame: ${stats(await output())}`);
console.log(`  echo, key to frame:     ${stats(await echo())}`);
await host.shutdown();
server.close();
// node-pty's ConPTY handles keep the process up after its panes end.
process.exit(0);
