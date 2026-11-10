import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CommandConfig } from "./tomrade-command.js";
import { DESKTOP_WORDS, type DesktopWords } from "./words.js";

/** What the person asked for on the command line. */
export type TermCommand =
  | { op: "help" }
  | { op: "open"; dir: string | null }
  | { op: "start"; key: string; agent: string | null }
  /** Without a number it lists the panes. */
  | { op: "attach"; cell: number | null }
  /** claim, note, link, create, list, show: the tools Tomrade's MCP server serves, for an agent without that connection. */
  | { op: "ticket"; request: TicketRequest; json: boolean }
  | { op: "bad"; what: string };

/** What `tomrade claim|note|link|create|list|show` sends (code-link's ticket command). */
export interface TicketRequest {
  op: "claim" | "note" | "link" | "create" | "list" | "show";
  key?: string;
  text?: string;
  title?: string;
  body?: string;
  pr?: string;
  branch?: string;
  search?: string;
  status?: string;
  limit?: number;
  parallel?: true;
  scopeChecked?: true;
}

const TICKET_OPS = new Set(["claim", "note", "link", "create", "list", "show"]);
/** Each command's options: a value it takes, or a switch. */
const TICKET_FLAGS: Record<TicketRequest["op"], Record<string, "value" | "switch">> = {
  claim: { "--parallel": "switch" },
  note: { "--key": "value" },
  link: { "--key": "value", "--pr": "value", "--branch": "value", "--scope-checked": "switch" },
  create: { "--body": "value" },
  list: { "--search": "value", "--status": "value", "--limit": "value" },
  show: {}
};

/** What Tomrade answers (code-sessions' `TermAnswer`). */
interface Answer {
  ok: boolean;
  text: string;
  /** The tool's own answer, printed as JSON with --json. */
  result?: unknown;
  cells?: string[];
  attach?: { herdr: string; socket: string; terminal: string };
  projectId?: string;
  cell?: string;
}

const TICKET = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
/** How long a Tomrade the command started has to answer. */
export const START_WAIT_MS = 90_000;
const RETRY_MS = 500;

/** `tomrade claim <KEY>`, `tomrade note [--key K] <text>`, `tomrade link [--key K] [--pr url] [--branch b] [--scope-checked]`, `tomrade create <title> [--body text]`, `tomrade list [--search s] [--status s] [--limit n]`, `tomrade show <KEY>`; --json on any. */
function parseTicket(op: TicketRequest["op"], rest: string[]): TermCommand {
  const flags = TICKET_FLAGS[op];
  const given: Record<string, string | true> = {};
  const plain: string[] = [];
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-h" || arg === "--help") return { op: "help" };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      plain.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const kind = flags[name];
    if (!kind) return { op: "bad", what: name };
    if (kind === "switch") {
      if (eq > 0) return { op: "bad", what: arg };
      given[name] = true;
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : rest[++i];
    if (value === undefined || value === "") return { op: "bad", what: name };
    given[name] = value;
  }
  const value = (name: string) => (typeof given[name] === "string" ? (given[name] as string) : undefined);
  const request: TicketRequest = { op };
  if (op === "claim" || op === "show") {
    if (plain.length !== 1 || !TICKET.test(plain[0]!)) return { op: "bad", what: plain.join(" ") || op };
    request.key = plain[0]!.toUpperCase();
  } else if (op === "note") {
    if (!plain.length) return { op: "bad", what: op };
    request.text = plain.join(" ");
  } else if (op === "create") {
    if (!plain.length) return { op: "bad", what: op };
    request.title = plain.join(" ");
  } else if (plain.length) return { op: "bad", what: plain.join(" ") };
  const key = value("--key");
  if (key !== undefined) {
    if (!TICKET.test(key)) return { op: "bad", what: key };
    request.key = key.toUpperCase();
  }
  const limit = value("--limit");
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1) return { op: "bad", what: `--limit ${limit}` };
    request.limit = Number(limit);
  }
  for (const [flag, field] of [["--body", "body"], ["--pr", "pr"], ["--branch", "branch"], ["--search", "search"], ["--status", "status"]] as const) {
    const v = value(flag);
    if (v !== undefined) request[field] = v;
  }
  if (given["--parallel"]) request.parallel = true;
  if (given["--scope-checked"]) request.scopeChecked = true;
  return { op: "ticket", request, json };
}

/** `tomrade term [folder] | --agent <agent> <KEY> | <KEY> | --attach [n]`; a ticket key is read as one only where no folder has that name. */
export function parseArgs(args: string[], isDir: (dir: string) => boolean): TermCommand {
  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") return { op: "help" };
  if (TICKET_OPS.has(sub)) return parseTicket(sub as TicketRequest["op"], rest);
  if (sub !== "term") return { op: "bad", what: sub };
  let agent: string | null = null;
  let attach: number | null | undefined;
  const plain: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-h" || arg === "--help") return { op: "help" };
    if (arg === "--agent" || arg.startsWith("--agent=")) {
      const value = arg === "--agent" ? rest[++i] : arg.slice("--agent=".length);
      if (!value || value.startsWith("-")) return { op: "bad", what: "--agent" };
      agent = value;
    } else if (arg === "--attach") {
      const next = rest[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        attach = Number(next);
        i++;
      } else attach = null;
    } else if (arg.startsWith("--attach=")) {
      const value = arg.slice("--attach=".length);
      if (!/^\d+$/.test(value)) return { op: "bad", what: arg };
      attach = Number(value);
    } else if (arg.startsWith("-") && arg !== "-") return { op: "bad", what: arg };
    else plain.push(arg);
  }
  if (attach !== undefined) return plain.length || agent ? { op: "bad", what: [...plain, ...(agent ? ["--agent"] : [])].join(" ") } : { op: "attach", cell: attach };
  if (plain.length > 1) return { op: "bad", what: plain.slice(1).join(" ") };
  const one = plain[0] ?? null;
  const key = one !== null && TICKET.test(one) && !isDir(one) ? one.toUpperCase() : null;
  if (key) return { op: "start", key, agent };
  if (agent !== null) return { op: "bad", what: one ?? "--agent" };
  return { op: "open", dir: one };
}

export interface CliDeps {
  /** The config the launcher names, read afresh each time: a Tomrade that just started may have written another port. */
  config(): CommandConfig | null;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  spawn: typeof nodeSpawn;
  out(text: string): void;
  err(text: string): void;
  sleep(ms: number): Promise<void>;
  isDir(dir: string): boolean;
  /** How long a Tomrade it started has to answer. */
  waitMs?: number;
}

/** Nothing listens on the port: Tomrade is not running. Any other failure may have reached it, and is not sent again. */
const refused = (error: unknown) => ((error as { cause?: { code?: unknown } } | null)?.cause?.code ?? (error as { code?: unknown } | null)?.code) === "ECONNREFUSED";

/** Starts Tomrade the way the system does: through LaunchServices on macOS, the app's executable elsewhere. Resolves with what went wrong, if anything. */
function launch(deps: CliDeps, open: string): Promise<string | null> {
  return new Promise((resolve) => {
    const mac = deps.platform === "darwin";
    const child = deps.spawn(mac ? "open" : open, mac ? ["-a", open] : [], { detached: !mac, stdio: "ignore", env: deps.env, windowsHide: false });
    child.once("error", (error) => resolve(error.message));
    if (mac) child.once("exit", (code) => resolve(code === 0 ? null : `open -a exited with ${code}`));
    else
      child.once("spawn", () => {
        child.unref();
        resolve(null);
      });
  });
}

/** The command's whole run: what it prints and the exit code. Tomrade answers over the MCP port; one that is not running is started first. */
export async function runCli(args: string[], deps: CliDeps): Promise<number> {
  const first = deps.config();
  const w: DesktopWords = DESKTOP_WORDS(first?.locale ?? "en");
  const command = parseArgs(args, (dir) => deps.isDir(path.resolve(deps.cwd, dir)));
  if (command.op === "help") {
    deps.out(w("cliUsage"));
    return 0;
  }
  if (command.op === "bad") {
    deps.err(`${w("cliUnknown", { what: command.what })}\n\n${w("cliUsage")}`);
    return 2;
  }
  let cwd = deps.cwd;
  if (command.op === "open" && command.dir) {
    cwd = path.resolve(deps.cwd, command.dir);
    if (!deps.isDir(cwd)) {
      deps.err(w("cliNoFolder", { dir: command.dir }));
      return 1;
    }
  }

  const ask = async (body: Record<string, unknown>, mayStart = true, name: "term" | "ticket" = "term"): Promise<Answer> => {
    let launched = false;
    let until = 0;
    for (;;) {
      const config = deps.config();
      if (!config) return { ok: false, text: w("cliNotRunning") };
      try {
        const res = await deps.fetch(`${config.url}/cli/${name}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tomrade-Cli": "1" }, body: JSON.stringify(body) });
        // A Tomrade still starting has its port before the Terminal window answers on it.
        if (res.status === 503 && launched && Date.now() < until) {
          await deps.sleep(RETRY_MS);
          continue;
        }
        const data = (await res.json().catch(() => null)) as (Answer & { error?: string }) | null;
        if (res.status === 503) return { ok: false, text: name === "term" ? w("cliNoTerminalWindow") : w("cliTomradeError", { reason: data?.error ?? "HTTP 503" }) };
        if (!res.ok || !data || typeof data.text !== "string") return { ok: false, text: w("cliTomradeError", { reason: data?.error ?? `HTTP ${res.status}` }) };
        return data;
      } catch (error) {
        if (!refused(error)) return { ok: false, text: w("cliTomradeError", { reason: error instanceof Error ? error.message : String(error) }) };
        if (!launched) {
          if (!config.open || !mayStart) return { ok: false, text: w("cliNotRunning") };
          launched = true;
          until = Date.now() + (deps.waitMs ?? START_WAIT_MS);
          deps.err(w("starting"));
          const problem = await launch(deps, config.open);
          if (problem) return { ok: false, text: w("cliLaunchFailed", { reason: problem }) };
        }
        if (Date.now() >= until) return { ok: false, text: w("cliNoAnswer") };
        await deps.sleep(RETRY_MS);
      }
    }
  };

  if (command.op === "ticket") {
    // An agent asks this when its MCP connection is missing: it says Tomrade is not running rather than start it.
    const token = deps.env.TOMRADE_MCP_TOKEN?.trim();
    const answer = await ask({ ...command.request, cwd, ...(token ? { token } : {}) }, false, "ticket");
    if (!answer.ok) {
      deps.err(command.json && answer.result !== undefined ? JSON.stringify(answer.result, null, 2) : answer.text);
      return 1;
    }
    deps.out(command.json ? JSON.stringify(answer.result ?? null, null, 2) : answer.text);
    return 0;
  }
  const body =
    command.op === "open" ? { op: "open", cwd } : command.op === "start" ? { op: "start", cwd, key: command.key, agent: command.agent } : { op: "attach", cwd, ...(command.cell !== null ? { cell: command.cell } : {}) };
  if (command.op === "start") deps.err(w("cliStartingTicket", { key: command.key }));
  const answer = await ask(body);
  const said = [answer.text, ...(answer.cells ?? []).map((line) => `  ${line}`)].filter(Boolean).join("\n");
  if (!answer.ok) {
    deps.err(said);
    return 1;
  }
  if (said) deps.out(said);
  if (!answer.attach) return 0;

  // herdr's own client takes this terminal over; once it lets go, the pane goes back to its cell in Tomrade.
  const { herdr, socket, terminal } = answer.attach;
  const code = await new Promise<number>((resolve) => {
    const child = deps.spawn(herdr, ["terminal", "attach", terminal, "--takeover"], { stdio: "inherit", env: { ...deps.env, HERDR_SOCKET_PATH: socket } });
    // The keys belong to the pane meanwhile; a signal to this process waits for herdr to end.
    const hold = () => {};
    process.on("SIGINT", hold);
    const done = (n: number) => {
      process.off("SIGINT", hold);
      resolve(n);
    };
    child.once("error", (error) => {
      deps.err(w("cliHerdrFailed", { reason: error.message }));
      done(1);
    });
    child.once("exit", (n) => done(n ?? 1));
  });
  await ask({ op: "detached", projectId: answer.projectId, cell: answer.cell }, false);
  return code;
}

/** The config the launcher points at. */
export function readConfig(file: string | undefined): CommandConfig | null {
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CommandConfig>;
    return typeof parsed.url === "string" ? { url: parsed.url, open: typeof parsed.open === "string" ? parsed.open : "", locale: typeof parsed.locale === "string" ? parsed.locale : "en" } : null;
  } catch {
    return null;
  }
}
