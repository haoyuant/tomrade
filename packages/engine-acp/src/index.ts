import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import { errorMessage } from "@tomradex/contracts";
import { localAvailability, pooledEngine } from "@tomradex/engine-kit";
import type {} from "@tomradex/mcp";
import type { AcpAgent, AcpOptions, Catalog } from "./agent.js";
import { AcpSignIn } from "./auth.js";
import { askCatalog, keptCatalogs } from "./catalog.js";
import { AcpRuntime } from "./runtime.js";

/**
 * An engine for a local agent that speaks ACP: one agent process per hot
 * thread, Tomrade's tools handed to it as an HTTP MCP server, its session
 * resumed from the agent's own store on the next cold turn. What its sessions
 * offer is kept across restarts; with nothing kept, one short session asks.
 */
export function createAcpEngine<O extends AcpOptions>(ctx: Context, agent: AcpAgent<O>): Engine {
  const catalog: Catalog = { models: [], efforts: (agent.efforts ?? []).map((value) => ({ value })) };
  const kept = keptCatalogs(ctx);
  Object.assign(catalog, kept.read(agent.id));
  const remember = () => kept.write(agent.id, catalog);
  const auth = agent.acpAuth ? new AcpSignIn(ctx, agent) : null;
  const turn = pooledEngine(ctx, { create: (input) => new AcpRuntime(ctx, agent, catalog, input, remember, auth ? () => auth.signedOut() : undefined) });
  const probe = agent.probe;
  const check = localAvailability(ctx, {
    engineId: agent.id,
    title: agent.title,
    cli: agent.cli,
    install: agent.install,
    ...(agent.desktopApp ? { desktopApp: agent.desktopApp } : {}),
    ...(auth ? { signIn: { ask: () => auth.signedIn(), reason: `${agent.title} is not signed in` } }
      : probe ? { signIn: { args: probe.args, says: (output: string) => probe.says(output, catalog), reason: probe.reason, need: probe.need } }
      : agent.signedIn ? { signIn: { ask: async () => agent.signedIn!.ask(), reason: agent.signedIn.reason } } : {})
  });
  const quit = new AbortController();
  ctx.effect(() => () => quit.abort());
  let asking = false;
  let failedAt = 0;
  // Why the agent could not open a session to say what it offers: it cannot run a turn either.
  let failure: string | null = null;
  // In the background, once at a time, and not again for a while after a failure.
  const ask = () => {
    if (catalog.models.length || asking || quit.signal.aborted || Date.now() - failedAt < 10 * 60_000) return;
    asking = true;
    void Promise.resolve()
      .then(() => askCatalog(ctx, agent, agent.options.parse(ctx.get("agent")?.settingsOf().engines[agent.id] ?? {}), quit.signal))
      .then((offered) => {
        failure = null;
        if (!offered.models) { failedAt = Date.now(); return; }
        if (catalog.models.length) return;
        Object.assign(catalog, offered);
        remember();
      }, (error) => {
        failedAt = Date.now();
        failure = errorMessage(error);
      })
      .finally(() => { asking = false; });
  };
  return {
    id: agent.id,
    title: agent.title,
    author: `ai:${agent.id}`,
    capabilities: ["backlog", "code", "general"],
    options: agent.options,
    media: () => ({ input: ["image/png", "image/jpeg", "image/webp", "image/gif"], output: [] }),
    permissionModes: agent.permissionModes,
    terminal: agent.terminal ? { mode: "handoff", ...agent.terminal } : { mode: "none" },
    ...(agent.steer ? { steering: "forward" as const } : {}),
    async available(opts) {
      // A recheck is the person's own: once they have installed or signed in, the list is asked for again at once.
      if (opts?.fresh) {
        failedAt = 0;
        auth?.recheck();
      }
      const state = await check(opts);
      if (state.ok) ask();
      // Its terminal sign-in is the command the agent itself lists, known only once it was asked.
      const signIn = auth && state.need === "sign-in" && agent.setup ? await auth.terminalCommand() : undefined;
      return signIn ? { ...state, setup: { ...agent.setup!, signIn } } : state;
    },
    local: {
      ...(agent.setup ? { setup: agent.setup } : {}),
      picks: () => [
        // Its own knobs first (a machine-wide one like the CodeBuddy edition), then what its sessions offer.
        ...(agent.picks ?? []),
        // What the agent can use depends on its own sign-in; the list is what its last session offered.
        { key: "model", title: "Model", choices: catalog.models, freeText: true, ...(asking && !catalog.models.length ? { pending: true } : {}),
          ...(!asking && !catalog.models.length && failure ? { failed: failure } : {}) },
        ...(catalog.efforts.length ? [{ key: "effort", title: "Effort", choices: catalog.efforts }] : [])
      ],
      checkCli: (file) => agent.cli.check(file),
      ...(auth ? { signIn: auth } : {}),
      diagnostics: {
        logs: () => agent.diagnostics?.logs?.() ?? [],
        facts: () => ({ models: catalog.models.slice(0, 40).map((m) => m.value).join(",") || "unknown", ...agent.diagnostics?.facts?.(catalog) })
      }
    },
    turn
  };
}

export { PERMISSION_CHOICES, isTomradeTool, policyOf, wrappedTool, type AcpAgent, type AcpOptions, type Catalog, type Policy, type RequestUsage } from "./agent.js";
export { AcpSignIn, authMethodsOf, commandLine, type AcpAuthMethod } from "./auth.js";
export { acpConnection, AUTH_REQUIRED } from "./connection.js";
export { AcpRuntime } from "./runtime.js";
export { LocalAgents, LocalAgents as default, type OwnAgent } from "./local.js";
