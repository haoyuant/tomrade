import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import { localAvailability, RuntimePool, runtimeFingerprint } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/mcp";
import type { AcpAgent, AcpOptions, Catalog } from "./agent.js";
import { AcpRuntime } from "./runtime.js";

/**
 * An engine for a local agent that speaks ACP: one agent process per hot
 * thread, Tomrade's tools handed to it as an HTTP MCP server, its session
 * resumed from the agent's own store on the next cold turn.
 */
export function createAcpEngine<O extends AcpOptions>(ctx: Context, agent: AcpAgent<O>): Engine {
  const pool = new RuntimePool<AcpRuntime>();
  ctx.effect(() => () => pool.close());
  const catalog: Catalog = { models: [], efforts: (agent.efforts ?? []).map((value) => ({ value })) };
  const probe = agent.probe;
  return {
    id: agent.id,
    title: agent.title,
    author: `ai:${agent.id}`,
    capabilities: ["backlog", "code", "general"],
    options: agent.options,
    media: () => ({ input: ["image/png", "image/jpeg", "image/webp", "image/gif"], output: [] }),
    permissionModes: agent.permissionModes,
    terminal: agent.terminal ?? false,
    ...(agent.terminalViaLink ? { terminalViaLink: true } : {}),
    ...(agent.steer ? { steers: true } : {}),
    ...(agent.setup ? { setup: agent.setup } : {}),
    picks: () => [
      // What the agent can use depends on its own sign-in; the list is what its last session offered.
      { key: "model", title: "Model", choices: catalog.models, freeText: true },
      ...(catalog.efforts.length ? [{ key: "effort", title: "Effort", choices: catalog.efforts }] : [])
    ],
    available: localAvailability(ctx, {
      engineId: agent.id,
      title: agent.title,
      cli: agent.cli,
      install: agent.install,
      ...(probe ? { signIn: { args: probe.args, says: (output: string) => probe.says(output, catalog), reason: probe.reason, need: probe.need } }
        : agent.signedIn ? { signIn: { ask: async () => agent.signedIn!.ask(), reason: agent.signedIn.reason } } : {})
    }),
    checkCli: (file) => agent.cli.check(file),
    diagnostics: {
      logs: () => agent.diagnostics?.logs?.() ?? [],
      facts: () => ({ models: catalog.models.slice(0, 40).map((m) => m.value).join(",") || "unknown", ...agent.diagnostics?.facts?.(catalog) })
    },
    async turn(input, io) {
      if (!ctx.mcp.url) return { stop: "error", error: "The MCP server is not running" };
      return pool.run(`${input.projectId}:${input.threadId}`, runtimeFingerprint(input, io, ctx.mcp.url),
        () => new AcpRuntime(ctx, agent, catalog, input), input, io);
    }
  };
}

export { PERMISSION_CHOICES, isTomradeTool, policyOf, wrappedTool, type AcpAgent, type AcpOptions, type Catalog, type Policy, type RequestUsage } from "./agent.js";
export { AcpConnection, AcpError, AUTH_REQUIRED, type AcpPeer } from "./connection.js";
export { AcpRuntime } from "./runtime.js";
