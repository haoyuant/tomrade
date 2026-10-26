import type { LocalAgentOptions, LocalAgentSpec } from "@tomradex/plugin-sdk";
import type { Host } from "../host.js";
import { copy } from "./shared.js";

/**
 * A plugin's local agent as the app's conductor reads one: what the core asks
 * at once runs in the plugin's scope and falls back on a throw, what it awaits
 * is held to its time, and a step that cannot go on without an answer fails.
 */
export const localAgentOf = (host: Host, spec: LocalAgentSpec<LocalAgentOptions>): LocalAgentSpec<LocalAgentOptions> => {
  const label = `local agent ${spec.id}`;
  const now = <T>(fn: () => T, what: string, fallback: T) => host.now(fn, `${label} ${what}`, () => fallback);
  const must = <T>(fn: () => T, what: string) => host.now<T>(fn, `${label} ${what}`, (message) => { throw new Error(`${spec.title}: ${message}`); });
  const { acp, probe, signedIn, diagnostics, mcpLink, lend, record } = spec;
  const bundled = spec.cli.bundled;
  const usage = acp?.usage;
  return {
    id: spec.id,
    title: spec.title,
    cli: {
      name: spec.cli.name,
      ...(bundled ? { bundled: host.back(bundled.bind(spec.cli), `${label} bundled apps`, { ms: 30_000 }) } : {}),
      ...(spec.cli.desktopApp ? { desktopApp: copy(spec.cli.desktopApp) } : {})
    },
    install: spec.install,
    ...(spec.setup ? { setup: copy(spec.setup) } : {}),
    ...(spec.options ? { options: spec.options } : {}),
    ...(spec.signIn ? { signIn: spec.signIn } : {}),
    ...(probe ? { probe: { args: [...probe.args], says: (output, catalog) => now(() => probe.says(output, catalog), "probe", null), reason: probe.reason, ...(probe.need ? { need: probe.need } : {}) } } : {}),
    ...(signedIn ? { signedIn: { ask: host.back(signedIn.ask.bind(signedIn), `${label} sign-in check`, { ms: 30_000 }), reason: signedIn.reason } } : {}),
    ...(diagnostics ? { diagnostics: {
      logs: () => (diagnostics.logs ? now(() => diagnostics.logs!(), "logs", []) : []),
      facts: (catalog) => (diagnostics.facts ? now(() => diagnostics.facts!(catalog), "facts", {}) : {})
    } } : {}),
    ...(acp ? { acp: {
      permissionModes: copy(acp.permissionModes),
      args: (options) => must(() => acp.args(options), "args"),
      ...(acp.env ? { env: (options: LocalAgentOptions) => must(() => acp.env!(options), "env") } : {}),
      // Without its own mode the agent keeps the one it has, which asks more, not less.
      ...(acp.mode ? { mode: (policy: Parameters<NonNullable<typeof acp.mode>>[0]) => now(() => acp.mode!(policy), "mode", undefined) } : {}),
      ...(acp.httpMcp ? { httpMcp: acp.httpMcp } : {}),
      ...(acp.reopen ? { reopen: acp.reopen } : {}),
      ...(acp.callName ? { callName: (id: string) => now(() => acp.callName!(id), "call name", undefined) } : {}),
      ...(usage ? { usage: typeof usage === "function" ? (update: Record<string, any>) => now(() => usage(update), "usage", null) : usage } : {}),
      ...(acp.cacheApart ? { cacheApart: true } : {}),
      ...(acp.steer ? { steer: acp.steer } : {}),
      ...(acp.efforts ? { efforts: [...acp.efforts] } : {}),
      ...(acp.failure ? { failure: (response: Record<string, any>) => now(() => acp.failure!(response), "failure", undefined) } : {}),
      ...(acp.terminal ? { terminal: typeof acp.terminal === "object" ? copy(acp.terminal) : true } : {}),
      ...(acp.terminalViaLink ? { terminalViaLink: true } : {})
    } } : {}),
    ...(spec.picks ? { picks: copy(spec.picks) } : {}),
    ...(mcpLink ? { mcpLink: "cli" in mcpLink
      ? { cli: {
          file: () => now(() => mcpLink.cli.file(), "link file", ""),
          configuredUrl: () => must(() => mcpLink.cli.configuredUrl(), "configured address"),
          add: (url: string) => must(() => mcpLink.cli.add(url), "link add"),
          remove: () => must(() => mcpLink.cli.remove(), "link remove")
        } }
      : {
          // Connecting may run the agent's CLI a few times, each held to half a minute.
          status: host.back(mcpLink.status.bind(mcpLink), `${label} link status`, { ms: 30_000 }),
          connect: host.back(mcpLink.connect.bind(mcpLink), `${label} link connect`, { ms: 180_000 }),
          disconnect: host.back(mcpLink.disconnect.bind(mcpLink), `${label} link disconnect`, { ms: 180_000 })
        } } : {}),
    ...(record ? { record: {
      find: (sessionId, opts) => now(() => record.find(sessionId, { cwd: opts.cwd }), "record find", null),
      read: (file) => now(() => record.read(file), "record read", null),
      ...(record.title ? { title: (file: string) => now(() => record.title!(file), "record title", null) } : {})
    } } : {}),
    // A lent call is bounded by its caller's signal, as the app's own are.
    ...(lend ? { lend: { ...(lend.rank !== undefined ? { rank: lend.rank } : {}), ask: host.back(lend.ask.bind(lend), `${label} lent call`) } } : {})
  };
};
