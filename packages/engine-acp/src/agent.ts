import type { z } from "zod";
import type { EngineNeed, EnginePick, EngineSetup, TurnInput } from "@tomradex/agent";
import type { CliLocator, DesktopApp } from "@tomradex/engine-kit";

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
  /** What a session runs with when Tomrade picks nothing: the agent's own setting, so the picks can say what "default" is. */
  defaults?: { model?: string; effort?: string };
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
  /** Picks it declares itself, before the model and effort its sessions offer. */
  picks?: EnginePick[];
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
  /**
   * How a stored session reopens; by default `session/resume` when offered, else `session/load`.
   * "never": its load replays the history after answering, into the turn that follows, so a cold
   * turn opens a new session with the conversation recapped instead.
   */
  reopen?: "resume" | "load" | "never";
  /** A tool call's own name, for an agent whose updates carry none but put it in the call's id. */
  callName?(toolCallId: string): string | undefined;
  /**
   * Where tokens are reported: the prompt's answer for this turn alone
   * ("turn"), the prompt's answer as a running session total ("session"), or
   * per model request inside a usage update (a reader). Absent: only the
   * context size is known.
   */
  usage?: "turn" | "session" | ((update: Record<string, any>) => RequestUsage | null);
  /** The prompt's `inputTokens` leaves out what `cachedReadTokens` and `cachedWriteTokens` count (OpenCode). */
  cacheApart?: boolean;
  /**
   * How it takes a message sent while a turn runs, which ACP itself has no word for: its own
   * `session/steer` method ("method", CodeBuddy), or a `/steer` prompt sent alongside ("slash",
   * Hermes). Absent: such messages wait for the turn to end.
   */
  steer?: "method" | "slash";
  /**
   * Present when its CLI can also be handed a ticket in a terminal (code link has a template for it).
   * `via: "link"`: there it has no per-session MCP flag; its user-level `tomrade` server, named with the session's token, serves.
   */
  terminal?: { via?: "session" | "link" };
  setup?: EngineSetup;
  /** Effort levels to offer before a session has advertised its own. */
  efforts?: string[];
  /**
   * The agent's own words for a turn it ended on "refusal" — some agents end
   * every failed turn that way and put the reason in the answer's `_meta`.
   */
  failure?(response: Record<string, any>): string | undefined;
  /** What gets a signed-out agent going, said after its own error. */
  signIn?: string;
  /** A run that tells whether the agent can work yet; it may also fill in the model list. */
  probe?: { args: string[]; says(output: string, catalog: Catalog): boolean | null; reason: string; need?: EngineNeed };
  /** Whether it is signed in, read without running it (its own settings); null: no clear answer, taken as yes. */
  signedIn?: { ask(): boolean | null | Promise<boolean | null>; reason: string };
  /** It signs in the ACP way — the `authMethods` its `initialize` lists — and is signed in once a session opens without `auth_required`. */
  acpAuth?: boolean;
  /** The agent's own logs and setup facts, for the troubleshooter; the models it offers are added to the facts. */
  diagnostics?: { logs?(): string[]; facts?(catalog: Catalog): Record<string, string> };
  /** Its desktop app, named when the app is installed without the CLI. */
  desktopApp?: DesktopApp;
}

export const PERMISSION_CHOICES = {
  "full-access": { value: "full-access", label: "Full access" },
  ask: { value: "ask", label: "Ask permissions" },
  "read-only": { value: "read-only", label: "Read only" },
  local: { value: "local", label: "Local rules" }
} as const;

/** Under "local" the agent's own rules decide what it asks, and whatever it asks goes to the person. */
export function policyOf(input: Pick<TurnInput, "purpose" | "permissionMode">, agent: Pick<AcpAgent, "permissionModes">): Policy {
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
