import { createHash } from "node:crypto";
import os from "node:os";
import type { TerminalFrame, TerminalMode, TerminalMouse, TerminalScroll, TerminalStatus } from "@tomradex/contracts";

/*
 * What Tomrade and its pty host say to each other over a named pipe, in herdr's
 * shapes: one line of JSON per message. A request is `{id, method, params}` and
 * its reply `{id, result}` or `{id, error: {code, message}}`. Two requests keep
 * the connection: `events.subscribe` goes on with `{event, data}` lines, and
 * `terminal.attach` with frames one way and terminal commands the other.
 */

/** Bumped when a message changes shape; a host speaking another one is not used. */
export const PROTOCOL = 1;

/** The pipe this user's host listens on; `scope` (the data folder) keeps a checkout's host apart from the installed app's. */
export function pipePath(scope = "", user = os.userInfo().username): string {
  const who = user.replace(/[^A-Za-z0-9_.-]/g, "_") || "user";
  const tag = scope ? `-${createHash("sha256").update(scope).digest("hex").slice(0, 8)}` : "";
  return `\\\\.\\pipe\\tomrade-pty-${who}${tag}`;
}

/** The host answered with an error (`pane_not_found`, `invalid_request`…), or could not be reached (`unreachable`, `timeout`). */
export class PtyHostError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PtyHostError";
  }
}

export interface Request {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** Splits a stream into lines, each handed over without its newline; a partial line waits for the rest. */
export function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
      if (line) onLine(line);
    }
  };
}

export const line = (message: unknown): string => `${JSON.stringify(message)}\n`;

/** A pane as `pane.get` and `pane.list` give it. */
export interface PaneInfo {
  pane_id: string;
  title: string | null;
  label: string | null;
  cwd: string;
  pid: number;
  scroll: { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number };
  /** The coding agent the host sees running in the pane; absent from a host older than that. */
  agent?: string | null;
  /** How that agent reads on the pane's screen and title, by herdr's detection manifests (by its title alone from a host before them). */
  agent_status?: TerminalStatus;
}

/** What `pane.process_info` gives, in herdr's shape: the pane's processes, nearest first. */
export interface ProcessInfo {
  foreground_processes: { pid: number; name: string; cmdline: string }[];
}

export interface LaunchParams {
  cwd: string;
  /** The program to run; the host's default shell without one. */
  file?: string;
  args?: string[];
  /** Typed into the shell once it runs, with Enter. */
  command?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  label?: string;
}

export interface AttachParams {
  pane_id: string;
  mode: TerminalMode;
  cols: number;
  rows: number;
}

export const frameLine = (frame: TerminalFrame) => ({ type: "terminal.frame", seq: frame.seq, width: frame.width, height: frame.height, full: frame.full, bytes: Buffer.from(frame.bytes).toString("base64") });

export type TerminalLine = { type: "frame"; frame: TerminalFrame } | { type: "closed"; reason: string | null };

/** One line of an attached terminal, as the host sends it; null for anything else. */
export function parseTerminalLine(text: string): TerminalLine | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed?.type === "terminal.closed") return { type: "closed", reason: typeof parsed.reason === "string" ? parsed.reason : null };
  if (parsed?.type !== "terminal.frame" || typeof parsed.bytes !== "string") return null;
  return {
    type: "frame",
    frame: { seq: Number(parsed.seq) || 0, width: Number(parsed.width) || 0, height: Number(parsed.height) || 0, full: parsed.full === true, bytes: new Uint8Array(Buffer.from(parsed.bytes, "base64")) }
  };
}

export const clampSize = (n: number) => Math.max(1, Math.min(0xffff, Math.round(n) || 1));

/** What an attached terminal sends the host, as herdr's control mode reads it. */
export const terminalCommand = {
  input: (data: string | Uint8Array) => (typeof data === "string" ? { type: "terminal.input", text: data } : { type: "terminal.input", bytes: Buffer.from(data).toString("base64") }),
  resize: (cols: number, rows: number) => ({ type: "terminal.resize", cols: clampSize(cols), rows: clampSize(rows) }),
  scroll: (s: TerminalScroll) => ({ type: "terminal.scroll", direction: s.direction, lines: clampSize(s.lines), ...(s.source === undefined ? {} : { source: s.source }), ...(s.column === undefined ? {} : { column: s.column }), ...(s.row === undefined ? {} : { row: s.row }), modifiers: s.modifiers ?? 0 }),
  mouse: (m: TerminalMouse) => ({ type: "terminal.mouse", action: m.action, button: m.button ?? "left", column: m.column, row: m.row, modifiers: m.modifiers ?? 0 }),
  release: () => ({ type: "terminal.release" })
};

export type TerminalCommand =
  | { type: "terminal.input"; text?: string; bytes?: string }
  | { type: "terminal.resize"; cols: number; rows: number }
  | ({ type: "terminal.scroll" } & TerminalScroll)
  | ({ type: "terminal.mouse" } & TerminalMouse)
  | { type: "terminal.release" };
