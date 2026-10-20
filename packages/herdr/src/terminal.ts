import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** One picture of the terminal: ANSI bytes that paint it — all of it when `full`, else only the cells that changed. */
export interface TerminalFrame {
  seq: number;
  width: number;
  height: number;
  full: boolean;
  bytes: Uint8Array;
}

/** `control` owns input and size (taking them from any other owner); `observe` only watches, alongside others. */
export type TerminalMode = "control" | "observe";

export type TerminalScroll = { direction: "up" | "down"; lines: number; column?: number; row?: number; modifiers?: number };
export type TerminalMouse = { action: "down" | "up" | "drag" | "move"; button?: "left" | "middle" | "right" | "none"; column: number; row: number; modifiers?: number };

/** A live terminal of a herdr pane. Calls on a closed stream, or on an observer, are dropped. */
export interface TerminalStream {
  readonly paneId: string;
  readonly mode: TerminalMode;
  onFrame(listener: (frame: TerminalFrame) => void): () => void;
  /** Once: the reason is herdr's (`server_shutdown`…), or what it printed when it would not attach (a pane it does not have). */
  onClose(listener: (reason: string | null) => void): () => void;
  input(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  scroll(scroll: TerminalScroll): void;
  mouse(mouse: TerminalMouse): void;
  close(): void;
  readonly closed: boolean;
}

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
  scroll: (s: TerminalScroll) => ({ type: "terminal.scroll", direction: s.direction, lines: size(s.lines), ...(s.column === undefined ? {} : { column: s.column }), ...(s.row === undefined ? {} : { row: s.row }), modifiers: s.modifiers ?? 0 }),
  mouse: (m: TerminalMouse) => ({ type: "terminal.mouse", action: m.action, button: m.button ?? "left", column: m.column, row: m.row, modifiers: m.modifiers ?? 0 }),
  release: () => ({ type: "terminal.release" })
};

/** How long a released controller has to leave before it is ended. */
export const RELEASE_GRACE_MS = 1_000;

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
    queueMicrotask(() => finish(err instanceof Error ? err.message : String(err)));
    settle();
  }
  if (child) {
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
