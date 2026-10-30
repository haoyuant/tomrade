/*
 * What a flood of output costs between the pty host and the window (pnpm --filter @tomradex/pty-host bench:flood):
 * a pane fed colored output that keeps scrolling, for a few seconds, with one window attached. Two shapes, each at a
 * steady agent's pace and at a pace that fills more than a screen a second:
 *
 * - "log": a build log or tool output, the whole screen scrolling;
 * - "tui": an agent drawing as Claude Code and Codex do, the output above scrolling under an input box that stays put
 *   at the bottom (the box erased and drawn again after every chunk).
 *
 * Reported per run: what the program wrote (the floor for anything that paints all of it), the frames and bytes the
 * host sends a second (and as they go down the pipe, JSON and base64), the host's time painting them (reading the
 * screen and diffing it), the time a window's xterm takes to parse them, and what a further 16 ms batch in the main
 * process would make of them. The window's screen is checked against the host's at the end.
 */
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { Pane } from "../dist/pane.js";
import { frameLine, line } from "../dist/protocol.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
const SECONDS = Number(process.env.SECONDS) || 5;
const COLS = Number(process.env.COLS) || 200;
const ROWS = Number(process.env.ROWS) || 50;
/** The program writes every few ms (as often as the platform's timers fire) the lines due by then, at these rates. */
const TICK_MS = 4;
const RATES = (process.env.RATES || "120,600").split(",").map(Number);
const BATCH_MS = 16;

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

const settle = (term) => new Promise((resolve) => term.write("", resolve));
const palette = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94];

/** One line of colored output, as wide as the pane mostly is. */
function logLine(n) {
  const c = palette[n % palette.length];
  const words = `step ${n}: compiled module ${(n * 7919) % 100000} in ${(n % 97) + 3} ms`;
  return `\x1b[2m${String(n).padStart(6)}\x1b[0m \x1b[${c}m${words}\x1b[0m \x1b[38;5;${(n * 13) % 256}m${"·".repeat(Math.max(0, COLS - words.length - 20) - (n % 40))}\x1b[0m \x1b[1mok\x1b[0m`;
}

const BOX = 6;
function box(n) {
  const rule = `\x1b[38;5;244m${"─".repeat(COLS)}\x1b[0m`;
  return [`\x1b[33m✻ Cogitating… (${Math.floor(n / 50)}s · ↓ ${n} tokens · esc to interrupt)\x1b[0m`, rule, `\x1b[1m>\x1b[0m `, "", rule, `  \x1b[2m? for shortcuts\x1b[0m`].join("\r\n");
}

const lines = (from, to, prefix = "") => Array.from({ length: to - from }, (_, i) => `${prefix}${logLine(from + i)}\r\n`).join("");
const shapes = {
  log: (from, to) => lines(from, to),
  // Ink's way: up to the box's first row, erase to the end, the new lines, the box again.
  tui: (from, to) => `\x1b[${BOX - 1}A\r\x1b[J${lines(from, to, "  ⎿  ")}${box(to)}`
};

async function flood(name, rate) {
  const pty = new PrintPty();
  const pane = new Pane("p", pty, "/", null, COLS, ROWS, { onScroll: () => undefined, onExit: () => undefined });
  const print = (data) => pty.listener(data);
  if (name === "tui") print(`${"\r\n".repeat(ROWS - BOX)}${box(0)}`);
  await settle(pane.term);
  const frames = [];
  pane.attach({ mode: "control", send: (f) => frames.push({ at: performance.now(), frame: f }), close: () => undefined }, COLS, ROWS);
  await settle(pane.term);
  await new Promise((r) => setTimeout(r, 50));
  const attached = frames.splice(0);

  // The host's own work for each paint: reading the screen and diffing it.
  let painting = 0;
  const flush = pane.flush.bind(pane);
  pane.flush = () => {
    const t0 = performance.now();
    flush();
    painting += performance.now() - t0;
  };

  const start = performance.now();
  let n = 0;
  let wrote = 0;
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      const due = Math.floor(((performance.now() - start) / 1000) * rate);
      if (due > n) {
        const data = shapes[name](n, due);
        wrote += Buffer.byteLength(data);
        print(data);
        n = due;
      }
      if (performance.now() - start > SECONDS * 1000) {
        clearInterval(tick);
        resolve();
      }
    }, TICK_MS);
  });
  await settle(pane.term);
  await new Promise((r) => setTimeout(r, 100));
  const elapsed = (performance.now() - start) / 1000;

  const bytes = frames.reduce((sum, f) => sum + f.frame.bytes.length, 0);
  const wire = frames.reduce((sum, f) => sum + Buffer.byteLength(line(frameLine(f.frame))), 0);

  // A window's xterm parsing all of it, from the screen it was painted at attach.
  const window = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true });
  for (const f of attached) window.write(f.frame.bytes);
  await settle(window);
  const t0 = performance.now();
  for (const f of frames) window.write(f.frame.bytes);
  await settle(window);
  const parsing = performance.now() - t0;
  const text = (term, top) => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(top + y)?.translateToString(true).trimEnd() ?? "").join("\n");
  const same = text(window, window.buffer.active.viewportY) === text(pane.term, pane.term.buffer.active.baseY);

  // A 16 ms batch over the frames as they came: how many messages it leaves, and how long a frame waits in it.
  let messages = 0;
  let waited = 0;
  let open = null;
  for (const f of frames) {
    if (open === null || f.at - open >= BATCH_MS) {
      messages++;
      open = f.at;
    }
    waited += open + BATCH_MS - f.at;
  }

  pane.dispose();
  window.dispose();
  return {
    same,
    wrote: wrote / elapsed,
    frames: frames.length / elapsed,
    bytes: bytes / elapsed,
    wire: wire / elapsed,
    perFrame: bytes / Math.max(1, frames.length),
    painting: painting / elapsed,
    paintEach: painting / Math.max(1, frames.length),
    parsing: parsing / elapsed,
    batched: messages / elapsed,
    batchWait: waited / Math.max(1, frames.length)
  };
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(`Flood: ${COLS}×${ROWS}, colored lines at ${RATES.join(" and ")} a second, ${SECONDS} s per run`);
await flood("log", RATES[0]);
for (const rate of RATES) {
  for (const name of ["log", "tui"]) {
    const x = await flood(name, rate);
    console.log(
      `  ${name.padEnd(3)} ${rate} lines/s: the program wrote ${kb(x.wrote)}/s  frames ${x.frames.toFixed(1)}/s  bytes ${kb(x.bytes)}/s (${kb(x.perFrame)} a frame)  on the pipe ${kb(x.wire)}/s  ` +
        `host painting ${x.painting.toFixed(1)} ms/s (${x.paintEach.toFixed(2)} ms a frame)  window parsing ${x.parsing.toFixed(1)} ms/s  ` +
        `16 ms batch: ${x.batched.toFixed(1)} messages/s, ${x.batchWait.toFixed(1)} ms added a frame  ${x.same ? "screens match" : "SCREENS DIFFER"}`
    );
  }
}
