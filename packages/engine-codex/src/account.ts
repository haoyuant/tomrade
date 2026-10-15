import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnCli, stopCli, type CliLaunch } from "@tomradex/engine-claude-code";

/** Where Codex keeps its sign-in, settings and sessions — what a terminal with this environment would use. */
export const codexHome = (env: NodeJS.ProcessEnv = process.env): string => env.CODEX_HOME || path.join(os.homedir(), ".codex");

export interface CodexAccount {
  /** False when the configured model provider brings its own credentials (a custom base URL, a token, an env key). */
  requiresOpenaiAuth: boolean;
  signedIn: boolean;
  /** Empty when Codex could not list them; the model stays free text. */
  models: { value: string; label?: string }[];
}

type Json = Record<string, any>;

/**
 * Asks Codex itself whether it can run, over one short app-server connection.
 * `codex login status` only knows about OpenAI sign-in, so it says "Not
 * logged in" for a custom provider that needs none. Null when this Codex has
 * no answer (an older version without app-server or account/read).
 */
export function readCodexAccount(launch: CliLaunch, env: NodeJS.ProcessEnv = process.env, timeoutMs = 10_000): Promise<CodexAccount | null> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnCli(launch, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  } catch {
    return Promise.resolve(null);
  }
  const pending = new Map<number, (msg: Json | null) => void>();
  let seq = 0;
  const reader = readline.createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || msg.method) return;
    pending.get(msg.id)?.(msg.error ? null : (msg.result ?? {}));
    pending.delete(msg.id);
  });
  const settleAll = () => { for (const done of pending.values()) done(null); pending.clear(); };
  child.on("error", settleAll);
  child.on("close", settleAll);
  child.stdin.on("error", settleAll);
  child.stderr.resume();
  const request = (method: string, params: Json) => new Promise<Json | null>((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    if (child.stdin.writable) child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    else { pending.delete(id); resolve(null); }
  });

  const ask = async (): Promise<CodexAccount | null> => {
    if (!(await request("initialize", { clientInfo: { name: "tomrade", version: "0.0.0" } }))) return null;
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    // refreshToken false: a readiness check must not rotate the person's ChatGPT token.
    const [account, listed] = await Promise.all([request("account/read", { refreshToken: false }), request("model/list", {})]);
    if (typeof account?.requiresOpenaiAuth !== "boolean") return null;
    const data: Json[] = Array.isArray(listed?.data) ? listed.data : [];
    return {
      requiresOpenaiAuth: account.requiresOpenaiAuth,
      signedIn: !!account.account,
      models: data.filter((m) => !m.hidden && typeof (m.model ?? m.id) === "string")
        .map((m) => ({ value: String(m.model ?? m.id), ...(m.displayName ? { label: String(m.displayName) } : {}) }))
    };
  };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  return Promise.race([ask().catch(() => null), timeout]).finally(() => {
    clearTimeout(timer);
    reader.close();
    settleAll();
    child.stdin.end();
    stopCli(child, "SIGTERM");
    // A wrapper that ignores SIGTERM must not outlive the check.
    const kill = setTimeout(() => stopCli(child, "SIGKILL"), 2000);
    kill.unref();
    child.once("close", () => clearTimeout(kill));
  });
}
