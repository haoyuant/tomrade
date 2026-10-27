/*
 * What reading agents off their panes costs the pty host (pnpm --filter @tomradex/pty-host bench:detection):
 *
 * 1. one reading of a Claude Code or Codex screen (the live bottom, then the manifest), at two pane sizes;
 * 2. the slowest reading of screens built to make a backtracking engine work hard, under every manifest;
 * 3. several panes painting busily for a while, read as the host reads a followed pane, against the same panes unread:
 *    the CPU it takes and how late the event loop runs (a keystroke waits on it).
 */
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { compileManifest, detect } from "../dist/detection.js";
import { MANIFESTS } from "../dist/manifests.js";
import { Pane } from "../dist/pane.js";
import { AgentScreens, READ_TIMING } from "../dist/status.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) => fs.readFileSync(path.join(root, "tests/fixtures/agent-screens", name), "utf8");
const PANES = Number(process.env.PANES) || 6;
const SECONDS = Number(process.env.SECONDS) || 8;

class PrintPty {
  pid = 1;
  onData(listener) {
    this.listener = listener;
  }
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

function pane(cols, rows, id = "p") {
  const pty = new PrintPty();
  const p = new Pane(id, pty, "/", null, cols, rows, { onScroll: () => undefined, onExit: () => undefined });
  return { pane: p, print: (data) => pty.listener(data) };
}

const settle = (p) => new Promise((resolve) => p.term.write("", resolve));
const crlf = (text) => text.replace(/\n/g, "\r\n");
const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { mean: sorted.reduce((a, b) => a + b, 0) / sorted.length, p50: at(0.5), p99: at(0.99), max: sorted.at(-1) };
};
const us = (ms) => `${(ms * 1000).toFixed(0)} µs`;

async function oneReading() {
  console.log("1. One reading: the live bottom, then the manifest");
  const filler = Array.from({ length: 200 }, (_, i) => `  ⎿  line ${i} of tool output, ${"x".repeat(60)}`).join("\n");
  for (const [cols, rows] of [[120, 40], [200, 60]]) {
    for (const name of ["claude-working.txt", "claude-blocked-bash.txt", "claude-idle.txt", "codex-working.txt", "codex-blocked-command.txt", "codex-idle-after-turn.txt"]) {
      const manifest = compileManifest(MANIFESTS[`${name.split("-")[0]}.toml`]);
      const { pane: p, print } = pane(cols, rows);
      print(crlf(`${filler}\n${fixture(name)}`));
      await settle(p);
      const text = [];
      const evaluate = [];
      let state;
      for (let i = 0; i < 2000; i++) {
        const t0 = performance.now();
        const input = p.detectionInput();
        const t1 = performance.now();
        state = detect(manifest, input).state;
        const t2 = performance.now();
        text.push(t1 - t0);
        evaluate.push(t2 - t1);
      }
      const a = stats(text);
      const b = stats(evaluate);
      console.log(`   ${cols}×${rows} ${name.padEnd(28)} ${state.padEnd(8)} text ${us(a.p50)} (p99 ${us(a.p99)})  rules ${us(b.p50)} (p99 ${us(b.p99)})`);
      p.dispose();
    }
  }
}

function hardScreens(cols, rows) {
  const line = (s) => s.repeat(Math.ceil(cols / s.length)).slice(0, cols);
  return {
    "one long word": Array.from({ length: rows }, () => line("a")).join("\n") + "\n",
    "spaces then text": Array.from({ length: rows }, () => " ".repeat(cols - 1) + "x").join("\n") + "\n",
    "timer lookalikes": Array.from({ length: rows }, () => line("• Working (1s ")).join("\n") + "\n",
    "bullets": Array.from({ length: rows }, () => line("• ")).join("\n") + "\n",
    "rules and prompts": Array.from({ length: rows }, (_, i) => (i % 2 ? "─".repeat(cols) : `› ${line("enter to select · ")}`)).join("\n") + "\n",
    "spinner words": Array.from({ length: rows }, () => line("✻ Thinking… ")).join("\n") + "\n",
    "blank lines": `${"\n".repeat(rows - 1)}x\n`,
    "esc to cancel": Array.from({ length: rows }, () => line("esc to cancel enter to confirm ")).join("\n") + "\n"
  };
}

function hardest() {
  console.log("2. The slowest reading of screens built to backtrack, under every manifest (200×60)");
  const screens = hardScreens(200, 60);
  let worst = { ms: 0 };
  const perManifest = [];
  for (const [file, m] of Object.entries(MANIFESTS)) {
    const manifest = compileManifest(m);
    let slowest = { ms: 0 };
    for (const [name, screen] of Object.entries(screens)) {
      for (const title of ["", "⠋ ".repeat(100)]) {
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) detect(manifest, { screen, oscTitle: title, oscProgress: "" });
        const ms = (performance.now() - t0) / 20;
        if (ms > slowest.ms) slowest = { ms, name };
      }
    }
    perManifest.push(`${file.replace(".toml", "")} ${us(slowest.ms)}`);
    if (slowest.ms > worst.ms) worst = { ...slowest, file };
  }
  console.log(`   per manifest, slowest: ${perManifest.join(", ")}`);
  console.log(`   worst: ${worst.file} on "${worst.name}" ${us(worst.ms)}`);
}

/** A busy agent: a spinner line redrawn, tool output scrolling, the occasional permission prompt. */
function busy(print, i, cols) {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let out = `\x1b]0;${frames[i % frames.length]} Working on the parser\x07`;
  for (let k = 0; k < 8; k++) out += `  ⎿  ${`output ${i}.${k} `.padEnd(cols - 8, "·")}\r\n`;
  out += `\x1b[2K✻ Cogitating… (${Math.floor(i / 50)}s · ↓ ${i} tokens · esc to interrupt)\r`;
  if (i % 400 === 399) out += crlf(fixture("claude-blocked-bash.txt"));
  print(out);
}

async function busyPanes(read) {
  const cols = 160;
  const rows = 50;
  const panes = Array.from({ length: PANES }, (_, i) => pane(cols, rows, `p${i}`));
  let readings = 0;
  const screens = new AgentScreens({ told: () => undefined, timing: READ_TIMING });
  if (read) {
    for (const { pane: p } of panes) {
      const input = p.detectionInput.bind(p);
      p.detectionInput = () => {
        readings++;
        return input();
      };
    }
  }
  const delay = monitorEventLoopDelay({ resolution: 1 });
  // A keystroke's wait: a timer due every 5 ms, and how late it fires.
  const lateness = [];
  let due = performance.now() + 5;
  const key = setInterval(() => {
    const now = performance.now();
    lateness.push(Math.max(0, now - due));
    due = now + 5;
  }, 5);
  delay.enable();
  const cpu0 = process.cpuUsage();
  const start = performance.now();
  let i = 0;
  await new Promise((resolve) => {
    // Each pane paints about 120 times a second, about 1.3 kB each time.
    const tick = setInterval(() => {
      for (const { pane: p, print } of panes) {
        busy(print, i, cols);
        if (read) screens.changed(p, "claude");
      }
      i++;
      if (performance.now() - start > SECONDS * 1000) {
        clearInterval(tick);
        resolve();
      }
    }, 8);
  });
  await Promise.all(panes.map(({ pane: p }) => settle(p)));
  const elapsed = performance.now() - start;
  const cpu = process.cpuUsage(cpu0);
  delay.disable();
  clearInterval(key);
  screens.dispose();
  for (const { pane: p } of panes) p.dispose();
  const late = stats(lateness);
  return {
    cpu: ((cpu.user + cpu.system) / 1000 / elapsed) * 100,
    eld: { p50: delay.percentile(50) / 1e6, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 },
    late,
    readings,
    perSecond: readings / (elapsed / 1000),
    chunks: i * PANES
  };
}

async function main() {
  await oneReading();
  hardest();
  console.log(`3. ${PANES} busy panes (160×50, ~120 paints/s each, ${SECONDS} s), unread and read every ${READ_TIMING.readMs} ms`);
  // Warm both paths first, then alternate so the machine's drift falls on both alike.
  await busyPanes(false);
  await busyPanes(true);
  const runs = { off: [], on: [] };
  for (let r = 0; r < 2; r++) {
    runs.off.push(await busyPanes(false));
    runs.on.push(await busyPanes(true));
  }
  for (const [name, list] of Object.entries(runs)) {
    for (const x of list) {
      console.log(`   ${name.padEnd(3)} cpu ${x.cpu.toFixed(1)}%  event loop delay p50 ${x.eld.p50.toFixed(2)} ms p99 ${x.eld.p99.toFixed(2)} ms max ${x.eld.max.toFixed(1)} ms  keystroke timer late p50 ${x.late.p50.toFixed(2)} ms p99 ${x.late.p99.toFixed(2)} ms  readings ${x.readings} (${x.perSecond.toFixed(1)}/s) of ${x.chunks} paints`);
    }
  }
}

await main();
