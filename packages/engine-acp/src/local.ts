import os from "node:os";
import { Context, Service } from "cordis";
import { errorMessage } from "@tomradex/contracts";
import type { Engine, EngineMcpLink, EngineSetup, McpLinkView } from "@tomradex/agent";
import {
  chosenCommand,
  cliLentModel,
  localAvailability,
  localCli,
  NotSignedIn,
  runJsonl,
  spawnCli,
  stopCli,
  userMcpLink,
  type CliLaunch,
  type CliLocator
} from "@tomradex/engine-kit";
import { transcriptOf } from "@tomradex/llm";
import type {} from "@tomradex/mcp";
import type { LocalAgentInstaller, LocalAgentIo, LocalAgentOptions, LocalAgentSpec, LocalCli, LocalCliResult, LocalCliRunOptions, McpLinkState } from "@tomradex/plugin-sdk";
import type { AcpAgent, AcpOptions, Catalog } from "./agent.js";
import { createAcpEngine } from "./index.js";

declare module "cordis" {
  interface Context {
    localAgents: LocalAgents;
  }
}

type Spec = LocalAgentSpec<LocalAgentOptions>;
/** A spec whose setup the app has written out as the commands it runs. */
type Written = Omit<Spec, "setup"> & { setup?: EngineSetup };

/** Tomrade's own environment with the agent's additions; `undefined` takes a variable out. */
function envOf(add: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(add ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** One run to its end, stopped when the caller gives up or its time is out. */
function runToEnd(launch: CliLaunch, args: string[], opts: LocalCliRunOptions): Promise<LocalCliResult> {
  return new Promise((resolve) => {
    const child = spawnCli(launch, args, { cwd: opts.cwd, env: envOf(opts.env), stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.stdin);
    }
    let stdout = "";
    let stderr = "";
    let failed: Error | undefined;
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", (error) => {
      failed = error;
      stderr = `${stderr}${error.message}`.slice(-4000);
    });
    const stop = () => stopCli(child);
    opts.signal?.addEventListener("abort", stop, { once: true });
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs) : null;
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", stop);
      if (timer) clearTimeout(timer);
      if (opts.signal?.aborted) resolve({ code: null, stdout, stderr: "stopped", error: { message: "stopped", killed: true } });
      else if (timedOut) resolve({ code: null, stdout, stderr, error: { message: `timed out after ${opts.timeoutMs} ms`, killed: true } });
      else if (failed) resolve({ code: null, stdout, stderr, error: { message: failed.message, code: (failed as NodeJS.ErrnoException).code ?? null } });
      else resolve({ code, stdout, stderr });
    });
  });
}

/** The agent's CLI as the person chose it in Settings, else as the locator found it. */
function cliHandle(ctx: Context, engineId: string, locator: CliLocator): LocalCli {
  const launch = () => locator.launch(chosenCommand(ctx, engineId));
  return {
    name: locator.name,
    async run(args, opts = {}) {
      // A bare timed run is the locator's own, as built-in agents' configuration commands are.
      if (opts.cwd === undefined && opts.env === undefined && opts.stdin === undefined && !opts.signal) {
        return locator.run(chosenCommand(ctx, engineId), args, opts.timeoutMs ?? 30_000);
      }
      return runToEnd(await launch(), args, opts);
    },
    async jsonl(args, opts) {
      const signals = [opts.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
      const signal = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
      return runJsonl(await launch(), args, { cwd: opts.cwd ?? os.tmpdir(), env: envOf(opts.env), stdin: opts.stdin, signal, onLine: opts.onLine }).done;
    }
  };
}


/** The plugin's link, answered as the app's are: a throw becomes the view's error. */
function pluginLink(ctx: Context, link: Extract<NonNullable<Spec["mcpLink"]>, { status: unknown }>, io: () => LocalAgentIo<LocalAgentOptions>): EngineMcpLink {
  const failed = (error: unknown): McpLinkView => ({ state: "unavailable", url: ctx.mcp.url, configuredUrl: null, file: null, manual: { connect: "", disconnect: "" }, error: errorMessage(error) });
  const ask = async (step: (io: LocalAgentIo<LocalAgentOptions>) => McpLinkState | Promise<McpLinkState>): Promise<McpLinkView> => {
    try {
      return { ...(await step(io())) };
    } catch (error) {
      return failed(error);
    }
  };
  return {
    status: () => ask((io) => link.status(io)),
    connect: () => ask((io) => link.connect(io)),
    disconnect: () => ask((io) => link.disconnect(io))
  };
}

/** In a terminal it reaches Tomrade through its own connection: `terminal: { via: "link" }`, or the flat `terminalViaLink` of SDK 0.2.22 and before. */
const viaLink = (acp: NonNullable<Spec["acp"]>) => (typeof acp.terminal === "object" ? acp.terminal.via === "link" : !!acp.terminalViaLink);

function acpAgentOf(spec: Written, locator: CliLocator): AcpAgent<AcpOptions> {
  const acp = spec.acp!;
  const options = spec.options as unknown as AcpAgent<AcpOptions>["options"];
  return {
    id: spec.id,
    title: spec.title,
    cli: locator,
    install: spec.install,
    options,
    permissionModes: acp.permissionModes,
    args: (_input, opts) => acp.args(opts),
    ...(acp.env ? { env: (_input: unknown, opts: AcpOptions) => acp.env!(opts) } : {}),
    ...(acp.mode ? { mode: acp.mode } : {}),
    ...(acp.httpMcp ? { httpMcp: acp.httpMcp } : {}),
    ...(acp.reopen ? { reopen: acp.reopen } : {}),
    ...(acp.callName ? { callName: acp.callName } : {}),
    ...(acp.usage ? { usage: acp.usage } : {}),
    ...(acp.cacheApart ? { cacheApart: true } : {}),
    ...(acp.steer ? { steer: acp.steer } : {}),
    ...(acp.terminal ? { terminal: { ...(viaLink(acp) ? { via: "link" as const } : {}) } } : {}),
    ...(spec.setup ? { setup: spec.setup } : {}),
    ...(acp.efforts ? { efforts: acp.efforts } : {}),
    ...(acp.failure ? { failure: acp.failure } : {}),
    ...(spec.signIn ? { signIn: spec.signIn } : {}),
    ...(spec.probe ? { probe: spec.probe } : {}),
    ...(spec.signedIn ? { signedIn: spec.signedIn } : {}),
    ...(spec.diagnostics ? { diagnostics: spec.diagnostics } : {}),
    ...(spec.cli.desktopApp ? { desktopApp: spec.cli.desktopApp } : {})
  };
}

/** A CLI Tomrade only hands a ticket in a terminal: never driven turn by turn here. */
function terminalEngine(ctx: Context, spec: Written, locator: CliLocator): Engine {
  const probe = spec.probe;
  const empty: Catalog = { models: [], efforts: [] };
  return {
    id: spec.id,
    title: spec.title,
    author: `ai:${spec.id}`,
    capabilities: ["code", "general"],
    terminal: { mode: "only", via: "link", claims: true },
    ...(spec.options ? { options: spec.options as Engine["options"] } : {}),
    available: localAvailability(ctx, {
      engineId: spec.id,
      title: spec.title,
      cli: locator,
      install: spec.install,
      ...(probe ? { signIn: { args: probe.args, says: (output: string) => probe.says(output, empty), reason: probe.reason, need: probe.need } }
        : spec.signedIn ? { signIn: { ask: async () => spec.signedIn!.ask(), reason: spec.signedIn.reason } } : {}),
      ...(spec.cli.desktopApp ? { desktopApp: spec.cli.desktopApp } : {})
    }),
    local: {
      ...(spec.setup ? { setup: spec.setup } : {}),
      picks: () => (spec.picks ?? []).map((pick) => ({ ...pick, choices: pick.choices.map((choice) => ({ ...choice })) })),
      checkCli: (file) => locator.check(file),
      ...(spec.diagnostics ? { diagnostics: { logs: () => spec.diagnostics?.logs?.() ?? [], facts: () => spec.diagnostics?.facts?.(empty) ?? {} } } : {})
    },
    async turn() {
      return { stop: "error", error: `${spec.title} runs only in a terminal — start the ticket "In a terminal"` };
    }
  };
}

/** An installer script as the command the app runs for the person; the plugin names only its address. */
const installCommand = (step: string | LocalAgentInstaller): string =>
  typeof step === "string" ? step : "script" in step ? `curl -fsSL ${step.script} | bash` : `irm ${step.powershell} | iex`;

/** The spec with its setup written out as commands, and `{install}` in the not-found words as the first of them. */
function written(spec: Spec): Written {
  const { setup, ...rest } = spec;
  const install = (setup?.install ?? []).map(installCommand);
  return { ...rest, install: spec.install.replace("{install}", install[0] ?? ""), ...(setup ? { setup: { ...setup, install } } : {}) };
}

/** Everything one spec stands for, on a context that has the agent and the MCP server. */
function apply(ctx: Context, given: Spec): void {
  const spec = written(given);
  const locator = localCli(spec.cli.name, spec.cli.bundled ? { bundled: (host) => spec.cli.bundled!(host) } : {});
  const cli = cliHandle(ctx, spec.id, locator);
  const optionsOf = (): LocalAgentOptions => {
    const raw = ctx.get("agent")?.settingsOf().engines[spec.id] ?? {};
    if (!spec.options) return raw as LocalAgentOptions;
    const read = spec.options.safeParse(raw);
    return read.success ? read.data : (raw as LocalAgentOptions);
  };
  const io = (): LocalAgentIo<LocalAgentOptions> => ({ cli, mcp: { url: ctx.mcp.url ?? null, eventUrl: ctx.mcp.eventUrl ?? null }, options: optionsOf() });
  const link = spec.mcpLink;
  const mcpLink: EngineMcpLink | undefined = !link
    ? undefined
    : "cli" in link
      ? userMcpLink(ctx, { engineId: spec.id, cli: locator, file: () => link.cli.file(), configuredUrl: () => link.cli.configuredUrl(), add: (url) => link.cli.add(url), remove: () => link.cli.remove() })
      : pluginLink(ctx, link, io);
  const base = spec.acp ? createAcpEngine(ctx, acpAgentOf(spec, locator)) : terminalEngine(ctx, spec, locator);
  const engine: Engine = { ...base, local: { ...base.local, ...(mcpLink ? { mcpLink } : {}) } };
  ctx.agent.engine(engine);
  const lend = spec.lend;
  if (!lend) return;
  const lent = cliLentModel({
    id: spec.id,
    title: spec.title,
    ...(lend.rank !== undefined ? { rank: lend.rank } : {}),
    found: async () => (await engine.available()).ok,
    async ask(request, signal) {
      try {
        return await lend.ask({ system: request.system, transcript: transcriptOf(request.messages) }, { ...io(), ...(signal ? { signal } : {}) });
      } catch (error) {
        // The plugin's own NotSignedIn is the SDK's class; the lending wants the app's.
        if (error instanceof Error && error.name === "NotSignedIn") throw new NotSignedIn(error.message);
        throw error;
      }
    }
  });
  ctx.inject(["llm"], (ctx) => ctx.effect(() => ctx.llm.lend(lent)));
}

/**
 * Coding agents a plugin describes rather than implements: this module finds
 * their CLI, runs them over ACP or hands them a ticket in a terminal, keeps
 * their connection to Tomrade and lends their sign-in to the worker — what the
 * app's own agents get.
 */
export class LocalAgents extends Service {
  static provide = "localAgents";

  constructor(ctx: Context) {
    super(ctx, "localAgents");
  }

  /** Goes with the plugin that registered it, or when the answer is called. */
  register(spec: Spec): () => void {
    if (spec.acp && !spec.options) throw new Error(`local agent "${spec.id}" talks ACP but has no options schema (its settings, with \`command\`)`);
    const fork = this.ctx.plugin({
      name: `local-agent:${spec.id}`,
      inject: ["agent", "mcp"],
      apply: (ctx: Context) => {
        // One the app still ships keeps its place; the plugin's copy waits until the app's goes.
        if (ctx.agent.engineOf(spec.id)) {
          ctx.logger("local-agents").warn(`${spec.title} is built into this Tomrade, so the plugin's "${spec.id}" stays off`);
          return;
        }
        apply(ctx, spec);
      }
    });
    return () => void fork.dispose();
  }
}
