import type { AgentRequest } from "@tomradex/agent";
import type { AgentApi, LocalAgentOptions, LocalAgentSpec, ModelRequest, ModelRequestChange } from "@tomradex/plugin-sdk";
import type { Host } from "../host.js";
import { localAgentOf } from "./local-agent.js";
import { CLI_HOOK_MS, HOOK_MS, copy, type Facade } from "./shared.js";
import { errorMessage } from "@tomradex/contracts";

/** The app's conductor for local agents (`@tomradex/engine-acp`), reached by its service name. */
interface LocalAgentsService {
  register(spec: LocalAgentSpec<LocalAgentOptions>): () => void;
}

/** A request as a plugin's hook sees it: plain data, its own copy. */
const modelRequest = (request: AgentRequest): ModelRequest => copy({ system: request.system, tools: request.tools, messages: request.messages, turn: request.turn }) as ModelRequest;

/** Only the parts a hook may change, and only when they are the right shape. */
const changeOf = (change: ModelRequestChange): Partial<Pick<AgentRequest, "system" | "tools" | "messages">> => ({
  ...(typeof change.system === "string" ? { system: change.system } : {}),
  ...(Array.isArray(change.tools) ? { tools: change.tools } : {}),
  ...(Array.isArray(change.messages) ? { messages: change.messages as AgentRequest["messages"] } : {})
});

/** A hook's answer, or none when it threw or ran out of time: a plugin's hook never ends the agent's turn. */
const hooked = async <T>(host: Host, fn: () => Promise<T>, label: string): Promise<T | undefined> => {
  try {
    return await fn();
  } catch (error) {
    host.logger.warn(`${host.identity.id} ${label}: ${errorMessage(error)}`);
    return undefined;
  }
};

export const agentApi = ({ host }: Facade): AgentApi => {
  const agent = () => host.svc("agent");
  return {
    playbook: (spec) =>
      host.call(() => {
        host.own(spec.id, "playbook");
        return host.disposerOf(agent().playbook({ id: spec.id, title: spec.title, when: spec.when, body: spec.body, tools: spec.tools }));
      }),
    request: (hook) =>
      host.call(() => {
        agent(); // refused, like every agent call, unless the plugin named "agent"
        const run = host.back(hook, "request hook", { ms: HOOK_MS });
        return host.disposerOf(
          host.ctx.on("agent/request", async (request, next) => {
            const change = await hooked(host, () => run(modelRequest(request)), "request hook");
            if (change) Object.assign(request, changeOf(change));
            return next();
          })
        );
      }),
    requestError: (hook) =>
      host.call(() => {
        agent();
        const run = host.back(hook, "request error hook", { ms: HOOK_MS });
        return host.disposerOf(
          host.ctx.on("agent/request-error", async (failure) => {
            const message = errorMessage(failure.error);
            const answer = await hooked(host, () => run({ message, request: modelRequest(failure.request), attempt: failure.attempt }), "request error hook");
            if (!answer || (!answer.request && !answer.profile)) return undefined;
            return { ...(answer.request ? { request: changeOf(answer.request) } : {}), ...(typeof answer.profile === "string" ? { profile: answer.profile } : {}) };
          })
        );
      }),
    turnEnding: (hook) =>
      host.call(() => {
        agent();
        const run = host.back(hook, "turn ending hook", { ms: HOOK_MS });
        return host.disposerOf(
          host.ctx.on("agent/turn-stopping", async (ending) => {
            const answer = await hooked(host, () => run(copy(ending)), "turn ending hook");
            return typeof answer?.continue === "string" && answer.continue.trim() ? { continue: answer.continue } : undefined;
          })
        );
      }),
    localAgent: (spec) =>
      host.call(() => {
        agent();
        host.own(spec.id, "local agent");
        const adapted = localAgentOf(host, spec as unknown as LocalAgentSpec<LocalAgentOptions>);
        // Run by the app's conductor while it is on; the agent goes with the plugin.
        const fiber = host.ctx.inject(["localAgents"], (ctx) => {
          (ctx.get("localAgents") as LocalAgentsService).register(adapted);
        });
        return host.disposerOf(() => void fiber.dispose());
      }),
    cliHook: (spec) =>
      host.call(() => {
        agent();
        const events = spec.events?.length ? new Set<string>(spec.events) : null;
        const agents = spec.agents?.length ? new Set(spec.agents) : null;
        const tools = spec.tools ? new RegExp(spec.tools) : null;
        const run = host.back(spec.handle.bind(spec), "CLI hook", { ms: CLI_HOOK_MS });
        const said = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
        return host.disposerOf(
          host.ctx.on("agent/cli-hook", async (call) => {
            if ((events && !events.has(call.event)) || (agents && !agents.has(call.agent)) || (tools && !(call.tool && tools.test(call.tool.name)))) return undefined;
            const answer = await hooked(host, () => run(copy(call)), "CLI hook");
            if (!answer || !call.answerable) return undefined;
            const deny = said(answer.deny), context = said(answer.context), more = said(answer.continue);
            return deny || context || more ? { ...(deny ? { deny } : {}), ...(context ? { context } : {}), ...(more ? { continue: more } : {}) } : undefined;
          })
        );
      })
  };
};
