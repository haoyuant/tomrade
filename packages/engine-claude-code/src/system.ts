import { HOUSE_RULES, promptSections, type TurnIO, type TurnInput } from "@tomrade/agent";

/** The appended system prompt an external agent gets: its identity, the shared house rules, the playbook index, the durable state. */
export function buildSystem(input: TurnInput, io: TurnIO, agentName: string): string {
  const identity =
    `You are conducting a thread inside Tomrade, a local-first backlog workbench, as ${agentName}. Operate the backlog ONLY through the "tomrade" MCP tools; every write is attributed to you, run-scoped, and revertible in one click — act, don't ask permission.\n` +
    HOUSE_RULES;
  return [identity, ...promptSections(input, io)].join("\n\n");
}

export const promptOf = (input: TurnInput): string =>
  input.input.kind === "text" ? input.input.text : Array.isArray(input.input.value) ? input.input.value.join(", ") : input.input.value;
