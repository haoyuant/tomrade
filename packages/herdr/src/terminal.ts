import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { errorMessage, type TerminalFrame, type TerminalMode, type TerminalMouse, type TerminalScroll, type TerminalStream } from "@tomradex/contracts";

export type { TerminalFrame, TerminalMode, TerminalMouse, TerminalScroll, TerminalStream } from "@tomradex/contracts";

export type TerminalLine = { type: "frame"; frame: TerminalFrame } | { type: "closed"; reason: string | null };

/** One line of `herdr terminal session control|observe`; null for anything else, which herdr may add later. */
export function parseTerminalLine(line: string): TerminalLine | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed?.type === "terminal.closed") return { type: "closed", reason: typeof parsed.reason === "string" ? parsed.reason : null };
  if (parsed?.type !== "terminal.frame" || typeof parsed.bytes !== "string") return null;
  return {
    type: "frame",
    frame: {
      seq: Number(parsed.seq) || 0,
      width: Number(parsed.width) || 0,
      height: Number(parsed.height) || 0,
      full: parsed.full === true,
      bytes: new Uint8Array(Buffer.from(parsed.bytes, "base64"))
    }
  };
}

const size = (n: number) => Math.max(1, Math.min(0xffff, Math.round(n) || 1));

/** The stdin lines control mode reads, as herdr 0.9.5 names them. */
export const terminalCommand = {
  input: (data: string | Uint8Array) => (typeof data === "string" ? { type: "terminal.input", text: data } : { type: "terminal.input", bytes: Buffer.from(data).toString("base64") }),
  resize: (cols: number, rows: number) => ({ type: "terminal.resize", cols: size(cols), rows: size(rows) }),
  scroll: (s: TerminalScroll) => ({ type: "terminal.scroll", direction: s.direction, lines: size(s.lines), ...(s.source === undefined ? {} : { source: s.source }), ...(s.column === undefined ? {} : { column: s.column }), ...(s.row === undefined ? {} : { row: s.row }), modifiers: s.modifiers ?? 0 }),
  mouse: (m: TerminalMouse) => ({ type: "terminal.mouse", action: m.action, button: m.button ?? "left", column: m.column, row: m.row, modifiers: m.modifiers ?? 0 }),
  release: () => ({ type: "terminal.release" })
};

/** How long a released controller has to leave before it is ended. */
export const RELEASE_GRACE_MS = 1_000;

/**
 * Every observer's herdr ends with this process, however it exits. A controller ends by itself once its stdin closes;
 * an observer reads no stdin and notices only when a paint of its pane cannot be written, so an idle pane's observer
 * would stay for good — and herdr paints for every client it has whenever any pane changes.
 */
const observers = new Set<ChildProcess>();
let endsWithUs = false;
const endWithUs = (child: ChildProcess) => {
  observers.add(child);
  child.once("exit", () => observers.delete(child));
  if (endsWithUs) return;
  endsWithUs = true;
  process.once("exit", endEveryObserver);
};

/** Ends every observer's herdr at once, as this process exits. */
export function endEveryObserver(): void {
  for (const child of observers) child.kill();
}

/** A `herdr terminal session` as `openTerminal` starts it, the way `ps` prints its command. */
const OWN_STREAM = /(?:^|\/)herdr terminal session (?:observe \S+|control \S+ --takeover) --cols \d+ --rows \d+$/;

/** In `ps -axo pid=,ppid=,command=`: the streams an earlier Tomrade left when it crashed or was killed, its own parent gone. */
export function strayStreams(ps: string): number[] {
  const out: number[] = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m && m[2] === "1" && OWN_STREAM.test(m[3]!.trim())) out.push(Number(m[1]));
  }
  return out;
}

/** Ends the streams `strayStreams` finds on this machine; how many. */
export async function endStrayStreams(): Promise<number> {
  if (process.platform === "win32") return 0;
  const ps = await new Promise<string>((resolve) => execFile("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? "" : out)));
  let ended = 0;
  for (const pid of strayStreams(ps)) {
    try {
      process.kill(pid);
      ended++;
    } catch {
      // gone meanwhile
    }
  }
  return ended;
}

/** A stream as it is opened: `settled` once herdr has attached or refused it, or its process has ended — closed or not. */
export interface OpenedTerminal extends TerminalStream {
  readonly settled: Promise<void>;
}

/**
 * `herdr terminal session <mode>` for one pane, as a stream. The child reads
 * its commands on stdin, so it ends with Tomrade: a closed stdin detaches it.
 */
export function openTerminal(input: { bin: string; paneId: string; mode: TerminalMode; cols: number; rows: number; env?: NodeJS.ProcessEnv }): OpenedTerminal {
  const args = ["terminal", "session", input.mode, input.paneId, ...(input.mode === "control" ? ["--takeover"] : []), "--cols", String(size(input.cols)), "--rows", String(size(input.rows))];
  const frames = new Set<(frame: TerminalFrame) => void>();
  const closes = new Set<(reason: string | null) => void>();
  let closed = false;
  let reason: string | null = null;
  let stderr = "";
  let child: ChildProcessWithoutNullStreams | null = null;
  let settle = () => {};
  const settled = new Promise<void>((resolve) => (settle = resolve));

  const finish = (why: string | null) => {
    if (closed) return;
    closed = true;
    reason = why;
    for (const listener of closes) listener(why);
    frames.clear();
    closes.clear();
  };
  const write = (command: Record<string, unknown>) => {
    if (closed || input.mode !== "control" || !child?.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(command)}\n`);
  };

  try {
    child = spawn(input.bin, args, { env: input.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    queueMicrotask(() => finish(errorMessage(err)));
    settle();
  }
  if (child) {
    if (input.mode === "observe") endWithUs(child);
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = parseTerminalLine(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (line) settle();
        if (line?.type === "frame") for (const listener of frames) listener(line.frame);
        else if (line?.type === "closed") finish(line.reason);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
    child.stdin.on("error", () => undefined);
    child.once("error", (err) => {
      finish(err.message);
      settle();
    });
    child.once("close", () => {
      finish(stderr.replace(/^herdr:\s*/, "").trim() || null);
      settle();
    });
  }

  return {
    paneId: input.paneId,
    mode: input.mode,
    settled,
    get closed() {
      return closed;
    },
    onFrame(listener) {
      if (closed) return () => undefined;
      frames.add(listener);
      return () => frames.delete(listener);
    },
    onClose(listener) {
      if (closed) {
        listener(reason);
        return () => undefined;
      }
      closes.add(listener);
      return () => closes.delete(listener);
    },
    input: (data) => write(terminalCommand.input(data)),
    resize: (cols, rows) => write(terminalCommand.resize(cols, rows)),
    scroll: (s) => write(terminalCommand.scroll(s)),
    mouse: (m) => write(terminalCommand.mouse(m)),
    close() {
      if (closed || !child) return finish(null);
      const proc = child;
      if (input.mode === "control" && proc.stdin.writable) proc.stdin.end(`${JSON.stringify(terminalCommand.release())}\n`);
      else proc.kill();
      setTimeout(() => proc.exitCode === null && proc.signalCode === null && proc.kill(), RELEASE_GRACE_MS).unref();
      finish(null);
    }
  };
}
