import type { Context } from "cordis";
import type { EngineSignIn, EngineSignInMethod, TurnInput } from "@tomradex/agent";
import { RpcError, type CliLaunch } from "@tomradex/engine-kit";
import type { AcpAgent, AcpOptions } from "./agent.js";
import { CLIENT_INFO, oneShot } from "./catalog.js";
import { AUTH_REQUIRED } from "./connection.js";

type Json = Record<string, any>;

/** One way an ACP agent signs in, as its `initialize` answer lists it. */
export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string;
  /** `agent`: `authenticate` runs it; `terminal`: the agent's own command with `args`, run by the person; `env_var`: a variable they set. */
  type: "agent" | "terminal" | "env_var";
  args: string[];
  env: Record<string, string>;
  /** The older `_meta["terminal-auth"]` form, which names its own command. */
  command?: { command: string; args: string[]; env: Record<string, string> };
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** A map in v1, a list of `{ name, value }` in v2. */
const envOf = (value: unknown): Record<string, string> =>
  Array.isArray(value)
    ? Object.fromEntries(value.filter((entry) => typeof entry?.name === "string").map((entry) => [entry.name, String(entry.value ?? "")]))
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};

/** The methods as the agent lists them; one without an id is dropped, and no `type` means `agent`. */
export function authMethodsOf(raw: unknown): AcpAuthMethod[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((method: Json): AcpAuthMethod[] => {
    const id = method?.id ?? method?.methodId;
    if (typeof id !== "string" || !id) return [];
    const meta: Json = method._meta && typeof method._meta === "object" ? method._meta : {};
    const legacy: Json | undefined = meta["terminal-auth"];
    const declared = method.type ?? meta.type ?? (legacy ? "terminal" : "agent");
    const type = declared === "terminal" || declared === "env_var" ? declared : "agent";
    return [{
      id,
      name: typeof method.name === "string" && method.name ? method.name : id,
      ...(typeof method.description === "string" && method.description ? { description: method.description } : {}),
      type,
      args: strings(method.args ?? meta.args),
      env: envOf(method.env ?? meta.env),
      ...(legacy && typeof legacy.command === "string" ? { command: { command: legacy.command, args: strings(legacy.args), env: envOf(legacy.env) } } : {})
    }];
  });
}

const posixWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
const powershellWord = (word: string) => `'${word.replace(/'/g, "''")}'`;

/** A command as the person's terminal reads it: a POSIX shell, or PowerShell on Windows. */
export function commandLine(argv: string[], env: Record<string, string>, platform: NodeJS.Platform = process.platform): string {
  const vars = Object.entries(env);
  if (platform === "win32") return [...vars.map(([key, value]) => `$env:${key}=${powershellWord(value)};`), "&", ...argv.map(powershellWord)].join(" ");
  return [...vars.map(([key, value]) => `${key}=${posixWord(value)}`), ...argv.map(posixWord)].join(" ");
}

/**
 * The program a terminal runs for a launch: a script bin through the runtime it
 * runs on (Windows would open a `.js` in Script Host), but a `.cmd` itself, not
 * the cmd.exe line that starts it from Node.
 */
export function terminalArgv(launch: CliLaunch, args: string[]): { argv: string[]; env: Record<string, string> } {
  const spec = launch.argv(args);
  const asNode = launch.env({}).ELECTRON_RUN_AS_NODE;
  return { argv: spec.verbatim ? [launch.file, ...args] : [spec.command, ...spec.args], env: asNode ? { ELECTRON_RUN_AS_NODE: asNode } : {} };
}

/** It lists terminal methods only to a client that says it can run them. */
const INITIALIZE = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true }, _meta: { "terminal-auth": true } },
  clientInfo: CLIENT_INFO
};

const kindOf = (method: AcpAuthMethod): EngineSignInMethod["kind"] => (method.type === "env_var" ? "other" : method.type);

/**
 * Signing in the ACP way: the `authMethods` the agent's `initialize` lists,
 * `authenticate` for a method the agent runs itself, a terminal for one the
 * person runs. Whether it is signed in is what the protocol says: a session
 * opens without `auth_required`. A "yes" is kept until a turn hears otherwise.
 */
export class AcpSignIn implements EngineSignIn {
  private known: { at: number; signedIn: boolean | null; methods: AcpAuthMethod[] } | null = null;
  private reading: Promise<{ signedIn: boolean | null; methods: AcpAuthMethod[] }> | null = null;
  private picked?: string;
  private stale = false;
  /** A "no" is read again after this long, so a sign-in finished in a terminal is noticed without a spawn every poll. */
  againMs = 10_000;

  constructor(private ctx: Context, private agent: AcpAgent<any>) {}

  private options(): AcpOptions {
    return this.agent.options.parse(this.ctx.get("agent")?.settingsOf().engines[this.agent.id] ?? {});
  }

  private read(signal: AbortSignal = new AbortController().signal) {
    this.reading ??= oneShot(this.ctx, this.agent, this.options(), AbortSignal.any([signal, AbortSignal.timeout(90_000)]), "how it signs in", async (conn, _child, cwd) => {
      const init = await conn.request("initialize", INITIALIZE, 60_000);
      const methods = authMethodsOf(init?.authMethods);
      try {
        await conn.request("session/new", { cwd, mcpServers: [] }, 60_000);
        return { signedIn: true, methods };
      } catch (error) {
        return { signedIn: error instanceof RpcError && error.code === AUTH_REQUIRED ? false : null, methods };
      }
    })
      // It did not start or answer: no clear answer, asked again only on a fresh look.
      .catch(() => ({ signedIn: null, methods: this.known?.methods ?? [] }))
      .then((read) => {
        this.known = { at: Date.now(), ...read };
        return read;
      })
      .finally(() => { this.reading = null; });
    return this.reading;
  }

  /** The person asked for a fresh look: a "no" may be read again. */
  recheck(): void {
    this.stale = true;
  }

  /** Signed in as far as can be told; null: no clear answer. */
  async signedIn(): Promise<boolean | null> {
    const known = this.known;
    const again = !known || (known.signedIn !== true && this.stale && Date.now() - known.at >= this.againMs);
    this.stale = false;
    return again ? (await this.read()).signedIn : known.signedIn;
  }

  /** A turn was told to sign in first. */
  signedOut(): void {
    this.known = { at: Date.now(), signedIn: false, methods: this.known?.methods ?? [] };
  }

  async methods(signal: AbortSignal): Promise<EngineSignInMethod[]> {
    const methods = this.known?.methods.length ? this.known.methods : (await this.read(signal)).methods;
    return methods.map((method) => ({ id: method.id, name: method.name, ...(method.description ? { description: method.description } : {}), kind: kindOf(method) }));
  }

  async start(methodId: string, opts: { signal: AbortSignal; onOutput(text: string): void }): Promise<void> {
    const method = this.known?.methods.find((m) => m.id === methodId);
    if (method?.type === "terminal") {
      this.picked = methodId;
      return;
    }
    await oneShot(this.ctx, this.agent, this.options(), opts.signal, "to sign in", async (conn, child) => {
      child.stderr.on("data", (chunk: Buffer) => opts.onOutput(chunk.toString()));
      await conn.request("initialize", INITIALIZE, 60_000);
      // The agent's own flow runs at the person's pace: a browser, a code.
      await conn.request("authenticate", { methodId }, 10 * 60_000);
    });
    this.known = { at: Date.now(), signedIn: true, methods: this.known?.methods ?? [] };
  }

  /** What the person runs in a terminal for the method picked, else the first terminal one: the agent's command with the method's args. */
  async terminalCommand(): Promise<string | undefined> {
    const methods = this.known?.methods.filter((m) => m.type === "terminal") ?? [];
    const method = methods.find((m) => m.id === this.picked) ?? methods[0];
    if (!method) return undefined;
    if (method.command && !method.args.length) return commandLine([method.command.command, ...method.command.args], method.command.env);
    const options = this.options();
    const input = { cwd: process.cwd() } as TurnInput;
    const launch = await this.agent.cli.launch(options.command);
    const run = terminalArgv(launch, [...this.agent.args(input, options), ...method.args]);
    return commandLine(run.argv, { ...run.env, ...this.agent.env?.(input, options), ...method.env });
  }
}
