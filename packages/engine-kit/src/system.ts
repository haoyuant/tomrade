import { HOUSE_RULES, focusSuffix, promptSections, type Engine, type TurnIO, type TurnInput } from "@tomradex/agent";

// The tools stay listed: its own search may be off, refused, or missing on a third-party API.
const OWN_WEB_SEARCH = "Search and read the web with your own tools first. Tomrade's web_search and web_fetch, when you have them, are only for when yours fail or are unavailable.";

export function staticSystem(agentName: string): string {
  return (
    `You are conducting a thread inside Tomrade, a local-first backlog workbench, as ${agentName}. Operate the backlog ONLY through the "tomrade" MCP tools; every write is attributed to you, run-scoped, and revertible in one click — act, don't ask permission.\n` +
    HOUSE_RULES
  );
}

/**
 * What an external agent is told once, when its session opens: its identity,
 * the house rules, whose web search comes first when it has its own, and the
 * index of the project's files. The index belongs here and not in the per-turn
 * prompt — this text is cached by the provider, while everything in a user
 * message is paid for again on every turn.
 */
export function sessionSystem(input: TurnInput, agent: Pick<Engine, "title" | "nativeWebSearch">): string {
  return [staticSystem(agent.title), ...(agent.nativeWebSearch ? [OWN_WEB_SEARCH] : []), ...(input.filesIndex ? [input.filesIndex.markdown] : [])].join("\n\n");
}

/**
 * The per-turn state. `staleIndex` is set when the files have moved on since
 * the session's index was written, which is one line rather than a fresh copy.
 */
export const turnPrompt = (input: TurnInput, io: TurnIO, opts: { staleIndex?: boolean } = {}): string =>
  ["Current Tomrade state (supersedes earlier snapshots):", ...promptSections(input, io, { filesIndex: false }),
    ...(opts.staleIndex ? ["The project's files have changed since the index in your system prompt was written; list_files or search_files for anything it does not show."] : []),
    ...(input.pending ? [] : ["No workflow is currently waiting for an answer."]),
    "USER MESSAGE:", promptOf(input)].join("\n\n");

export const promptOf = (input: TurnInput): string =>
  input.input.kind === "text" ? input.input.text + focusSuffix(input.input.focus) : Array.isArray(input.input.value) ? input.input.value.join(", ") : input.input.value;
