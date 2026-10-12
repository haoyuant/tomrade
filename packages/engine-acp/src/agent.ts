import type { z } from "zod";
import type { EngineNeed, EnginePick, EngineSetup, TurnInput } from "@tomradex/agent";
import type { CliLocator } from "@tomradex/engine-claude-code";

/** How much the agent may do without asking, as Tomrade settles it for one turn. */
export type Policy = "full-access" | "ask" | "read-only";

export interface AcpOptions {
  command: string;
  model?: string;
  effort?: string;
}

/** One model request's tokens; `input` counts every prompt token, cached ones included. */
export interface RequestUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** What the agent offered the last time a session opened, for the Model and Effort picks. */
export interface Catalog {
  models: EnginePick["choices"];
  efforts: EnginePick["choices"];
}

/**
 * One local agent that speaks the Agent Client Protocol on stdio. The protocol
 * is shared; what differs is how each one starts, how much it asks before it
 * acts, and where it reports the tokens it spent.
 */
export interface AcpAgent<O extends AcpOptions = AcpOptions> {
  id: string;
  title: string;
  cli: CliLocator;
  /** The English tail of "not found — …". */
  install: string;
  options: z.ZodType<O>;
  permissionModes: { default: string; choices: { value: string; label: string }[] };
  /** What starts its ACP server on stdio. */
  args(input: TurnInput, options: O): string[];
  env?(input: TurnInput, options: O): Record<string, string>;
  /** The agent's own session mode for a policy; Tomrade answers whatever it still asks. */
  mode?(policy: Policy): string | undefined;
  /** "always": it registers HTTP MCP servers without advertising that it can. */
  httpMcp?: "advertised" | "always";
  /** How a stored session reopens; by default `session/resume` when offered, else `session/load`. */
  reopen?: "resume" | "load";
  /**
   * Where tokens are reported: the prompt's answer for this turn alone
   * ("turn"), the prompt's answer as a running session total ("session"), or
   * per model request inside a usage update (a reader). Absent: only the
   * context size is known.
   */
  usage?: "turn" | "session" | ((update: Record<string, any>) => RequestUsage | null);
  /** Whether its CLI can also be handed a ticket in a terminal (code link has a template for it). */
  terminal?: boolean;
  setup?: EngineSetup;
  /** Effort levels to offer before a session has advertised its own. */
  efforts?: string[];
  /** What gets a signed-out agent going, said after its own error. */
  signIn?: string;
  /** A run that tells whether the agent can work yet; it may also fill in the model list. */
  probe?: { args: string[]; says(output: string, catalog: Catalog): boolean | null; reason: string; need?: EngineNeed };
}

export const PERMISSION_CHOICES = {
  "full-access": { value: "full-access", label: "Full access" },
  ask: { value: "ask", label: "Ask permissions" },
  "read-only": { value: "read-only", label: "Read only" },
  local: { value: "local", label: "Local rules" }
} as const;

/**
 * A backlog turn works through Tomrade's tools alone, so the agent's own
 * changes are refused. Under "local" the agent's own rules decide what it
 * asks, and whatever it asks goes to the person.
 */
export function policyOf(input: Pick<TurnInput, "purpose" | "permissionMode">, agent: Pick<AcpAgent, "permissionModes">): Policy {
  if (input.purpose === "backlog") return "read-only";
  const mode = input.permissionMode ?? agent.permissionModes.default;
  return mode === "ask" || mode === "local" ? "ask" : mode === "read-only" ? "read-only" : "full-access";
}

/** A call to a deferred tool through a wrapper (CodeBuddy's DeferExecuteTool) names the real tool in its input. */
export const wrappedTool = (args: unknown): string | undefined => {
  const name = args && typeof args === "object" ? (args as { toolName?: unknown }).toolName : undefined;
  return typeof name === "string" && name ? name : undefined;
};

/** An MCP tool of the server Tomrade hands over, as agents name them: `mcp__tomrade__x`, Hermes' `mcp_tomrade_x`. */
const TOMRADE_TOOL = /^mcp__?tomrade__?[a-z0-9_]+$/i;
const ACTS = new Set(["execute", "edit", "delete", "move"]);

/**
 * Tomrade's own tools are run-scoped and revertible, so they never wait for a
 * person. Only the tool's own name counts — a title is free text, and a
 * command or path that merely mentions tomrade must still be asked about.
 */
export const isTomradeTool = (call: { name?: unknown; title?: unknown; kind?: unknown; args?: unknown }): boolean => {
  const named = (value: unknown) => typeof value === "string" && TOMRADE_TOOL.test(value.trim());
  if (named(call.name) || named(wrappedTool(call.args))) return true;
  // Agents without a `name` field title an MCP call with the tool's name alone.
  return named(call.title) && !ACTS.has(String(call.kind ?? ""));
};
