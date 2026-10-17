import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Where herdr's server listens: the pane's own variable first, then the named or default session's socket. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const base = path.join(home, ".config", "herdr");
  return env.HERDR_SESSION ? path.join(base, "sessions", env.HERDR_SESSION, "herdr.sock") : path.join(base, "herdr.sock");
}

/** herdr answered with an error (`not_found`, `invalid_request`…), or could not be reached (`unreachable`, `timeout`). */
export class HerdrError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

/**
 * One request over herdr's socket: a line of JSON in, a line of JSON back,
 * then the connection closes. herdr is not at 1.0 — fields it adds are left
 * to the caller to ignore, and a method it does not know is an ordinary error.
 */
export function herdrCall<T = Record<string, unknown>>(socket: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const connection = net.createConnection(socket);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new HerdrError("timeout", `herdr did not answer ${method} within ${timeoutMs / 1000} s`))), timeoutMs);
    connection.setEncoding("utf8");
    connection.once("connect", () => connection.write(`${JSON.stringify({ id: "1", method, params })}\n`));
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let reply: { result?: T; error?: { code?: string; message?: string } };
      try {
        reply = JSON.parse(buffer.slice(0, end)) as typeof reply;
      } catch {
        return finish(() => reject(new HerdrError("bad_reply", `herdr answered ${method} with something that is not JSON`)));
      }
      if (reply.error) {
        const error = reply.error;
        return finish(() => reject(new HerdrError(error.code ?? "error", error.message ?? `herdr refused ${method}`)));
      }
      finish(() => resolve(reply.result as T));
    });
    connection.once("error", (err: NodeJS.ErrnoException) => finish(() => reject(new HerdrError("unreachable", `herdr is not reachable at ${socket}: ${err.message}`))));
    connection.once("close", () => finish(() => reject(new HerdrError("closed", `herdr closed the connection before answering ${method}`))));
  });
}
