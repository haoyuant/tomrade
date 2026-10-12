import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import { localAvailability, localCli } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/mcp";

/** A CLI agent Tomrade knows how to start in a terminal; Code link holds its command template. */
export interface TerminalAgent {
  id: string;
  title: string;
  /** The executable a terminal would run. */
  bin: string;
  /** The English tail of "not found — …". */
  install: string;
}

export const TERMINAL_AGENTS: TerminalAgent[] = [
  { id: "gemini", title: "Gemini CLI", bin: "gemini", install: "install Gemini CLI (npm install -g @google/gemini-cli) and sign in" },
  { id: "opencode", title: "OpenCode", bin: "opencode", install: "install OpenCode (curl -fsSL https://opencode.ai/install | bash) and add a provider" }
];

/**
 * Started only where the person can see it: Start hands it the ticket in a
 * terminal with Tomrade's MCP server configured for that one session. There is
 * no in-app turn to take — every run of it is the person's terminal.
 */
export function createTerminalEngine(ctx: Context, agent: TerminalAgent): Engine {
  const cli = localCli(agent.bin);
  return {
    id: agent.id,
    title: agent.title,
    author: `ai:${agent.id}`,
    capabilities: ["code", "general"],
    terminalOnly: true,
    picks: () => [{ key: "model", title: "Model", choices: [], freeText: true }],
    available: localAvailability(ctx, { engineId: agent.id, title: agent.title, cli, install: agent.install }),
    checkCli: (file) => cli.check(file),
    async turn() {
      return { stop: "error", error: `${agent.title} runs only in a terminal — start the ticket "In a terminal"` };
    }
  };
}

export default {
  name: "engine-terminal",
  inject: ["agent", "mcp"],
  apply(ctx: Context) {
    for (const agent of TERMINAL_AGENTS) ctx.agent.engine(createTerminalEngine(ctx, agent));
  }
};
