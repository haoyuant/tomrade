import net from "node:net";
import type { TerminalFrame, TerminalMode, TerminalStream } from "@tomradex/contracts";
import { clampSize, line, lineReader, parseTerminalLine, PtyHostError, terminalCommand, type AttachParams } from "./protocol.js";

/** One request to the host: a line of JSON in, a line back. */
export function hostCall<T = Record<string, unknown>>(pipe: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const connection = net.createConnection(pipe);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new PtyHostError("timeout", `the terminal host did not answer ${method} within ${timeoutMs / 1000} s`))), timeoutMs);
    connection.setEncoding("utf8");
    connection.once("connect", () => connection.write(line({ id: "1", method, params })));
    connection.on("data", lineReader((text) => {
      let reply: { result?: T; error?: { code?: string; message?: string } };
      try {
        reply = JSON.parse(text) as typeof reply;
      } catch {
        return finish(() => reject(new PtyHostError("bad_reply", `the terminal host answered ${method} with something that is not JSON`)));
      }
      if (reply.error) {
        const error = reply.error;
        return finish(() => reject(new PtyHostError(error.code ?? "error", error.message ?? `the terminal host refused ${method}`)));
      }
      finish(() => resolve(reply.result as T));
    }));
    connection.once("error", (err) => finish(() => reject(new PtyHostError("unreachable", `the terminal host is not reachable: ${err.message}`))));
    connection.once("close", () => finish(() => reject(new PtyHostError("closed", `the terminal host closed the connection before answering ${method}`))));
  });
}

/** A subscription to the host's events; `onEnd` hears why it stopped, so the caller can subscribe again. */
export function hostStream(pipe: string, subscriptions: Record<string, unknown>[], onEvent: (event: { event: string; data: Record<string, unknown> }) => void, onEnd: (error: PtyHostError | null) => void, onStart?: () => void): { close(): void } {
  let started = false;
  let ended = false;
  const connection = net.createConnection(pipe);
  const end = (error: PtyHostError | null) => {
    if (ended) return;
    ended = true;
    connection.destroy();
    onEnd(error);
  };
  connection.setEncoding("utf8");
  connection.once("connect", () => connection.write(line({ id: "1", method: "events.subscribe", params: { subscriptions } })));
  connection.on("data", lineReader((text) => {
    let parsed: { error?: { code?: string; message?: string }; event?: string; data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.error) return end(new PtyHostError(parsed.error.code ?? "error", parsed.error.message ?? "the terminal host ended the subscription"));
    if (!started) {
      started = true;
      onStart?.();
      return;
    }
    if (typeof parsed.event === "string") onEvent({ event: parsed.event, data: parsed.data ?? {} });
  }));
  connection.once("error", (err) => end(new PtyHostError("unreachable", `the terminal host is not reachable: ${err.message}`)));
  connection.once("close", () => end(null));
  return { close: () => end(null) };
}

/** A terminal as it is opened: `attached` resolves once the host took it, and rejects with why it would not. */
export interface OpenedTerminal extends TerminalStream {
  readonly attached: Promise<void>;
}

/** A live terminal of one pane over its own connection: frames in, commands out. */
export function openTerminal(pipe: string, input: { paneId: string; mode: TerminalMode; cols: number; rows: number }): OpenedTerminal {
  const frames = new Set<(frame: TerminalFrame) => void>();
  const closes = new Set<(reason: string | null) => void>();
  let closed = false;
  let reason: string | null = null;
  let answered = false;
  let attach: { resolve: () => void; reject: (err: PtyHostError) => void } = { resolve: () => undefined, reject: () => undefined };
  const attached = new Promise<void>((resolve, reject) => (attach = { resolve, reject }));
  // Nobody may await it; a refusal still reaches onClose.
  attached.catch(() => undefined);
  const connection = net.createConnection(pipe);

  const finish = (why: string | null) => {
    if (closed) return;
    closed = true;
    reason = why;
    connection.destroy();
    for (const listener of closes) listener(why);
    frames.clear();
    closes.clear();
  };
  const write = (command: Record<string, unknown>) => {
    if (closed || input.mode !== "control" || !answered || !connection.writable) return;
    connection.write(line(command));
  };
  const params: AttachParams = { pane_id: input.paneId, mode: input.mode, cols: clampSize(input.cols), rows: clampSize(input.rows) };
  connection.setEncoding("utf8");
  connection.once("connect", () => connection.write(line({ id: "1", method: "terminal.attach", params })));
  connection.on("data", lineReader((text) => {
    if (!answered) {
      answered = true;
      let reply: { error?: { code?: string; message?: string } } = {};
      try {
        reply = JSON.parse(text) as typeof reply;
      } catch {
        // not an error line: taken as attached
      }
      if (reply.error) {
        const error = new PtyHostError(reply.error.code ?? "error", reply.error.message ?? "the terminal host would not attach");
        attach.reject(error);
        return finish(error.message);
      }
      return attach.resolve();
    }
    const parsed = parseTerminalLine(text);
    if (parsed?.type === "frame") for (const listener of frames) listener(parsed.frame);
    else if (parsed?.type === "closed") finish(parsed.reason);
  }));
  connection.once("error", (err) => {
    const error = new PtyHostError("unreachable", `the terminal host is not reachable: ${err.message}`);
    attach.reject(error);
    finish(error.message);
  });
  connection.once("close", () => {
    attach.reject(new PtyHostError("closed", "the terminal host closed the terminal"));
    // The host going away is not a reason of the pane's own: the caller asks whether it is still there.
    finish(reason ?? (answered ? "server_shutdown" : null));
  });

  return {
    paneId: input.paneId,
    mode: input.mode,
    attached,
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
      if (closed) return;
      if (answered && connection.writable) connection.end(line(terminalCommand.release()));
      finish(null);
    }
  };
}
