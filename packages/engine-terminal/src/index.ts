import type { Context } from "cordis";
import { z } from "zod";
import type { Engine, EngineSetup } from "@tomradex/agent";
import { createAcpEngine, PERMISSION_CHOICES, type AcpAgent } from "@tomradex/engine-acp";
import { localAvailability, localCli } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/llm";
import type {} from "@tomradex/mcp";
import { geminiLentModel } from "./lend.js";

export const GeminiOptions = z.object({
  command: z.string().default("gemini"),
  /** A model as Gemini CLI lists it (`auto`, `gemini-2.5-pro`, …); empty keeps its own. */
  model: z.string().optional()
});
export type GeminiOptions = z.infer<typeof GeminiOptions>;

/** Gemini CLI ids a tool call `<tool>__<id>`, and its ACP updates name the call nowhere else. */
export function geminiCallName(toolCallId: string): string | undefined {
  const at = toolCallId.indexOf("__");
  return at > 0 ? toolCallId.slice(0, at) : undefined;
}

export const gemini: AcpAgent<GeminiOptions> = {
  id: "gemini",
  title: "Gemini CLI",
  cli: localCli("gemini"),
  install: "install Gemini CLI (npm install -g @google/gemini-cli) and sign in",
  // Its first run asks how to sign in: a Google account or an API key.
  setup: { install: ["npm install -g @google/gemini-cli"], signIn: "gemini", signInRuns: true, docs: "https://github.com/google-gemini/gemini-cli" },
  options: GeminiOptions,
  permissionModes: { default: "full-access", mainDefault: "ask", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask, PERMISSION_CHOICES["read-only"]] },
  // "default" asks before edits, commands and MCP tools, whatever mode the person set for it, and Tomrade answers for the turn.
  // Never switched later: a switch is announced as "[MODE_UPDATE] …" in the reply.
  args: () => ["--acp", "--approval-mode", "default"],
  // In a folder it does not trust it starts no MCP server, Tomrade's included; this one is Tomrade's own, or the ticket's checkout.
  env: () => ({ GEMINI_CLI_TRUST_WORKSPACE: "true" }),
  reopen: "never",
  callName: geminiCallName,
  // Code link hands it a ticket in a terminal with a session-only settings file.
  terminal: true,
  usage: "turn",
  signIn: "run `gemini`, enter /auth and choose Use Gemini API Key (or Vertex AI)"
};

/** A CLI agent Tomrade knows how to start in a terminal; Code link holds its command template. */
export interface TerminalAgent {
  id: string;
  title: string;
  /** The executable a terminal would run. */
  bin: string;
  /** The English tail of "not found — …". */
  install: string;
  setup: EngineSetup;
}

export const TERMINAL_AGENTS: TerminalAgent[] = [
  {
    id: "opencode", title: "OpenCode", bin: "opencode", install: "install OpenCode (curl -fsSL https://opencode.ai/install | bash) and add a provider",
    setup: {
      install: process.platform === "win32" ? ["npm install -g opencode-ai"] : ["curl -fsSL https://opencode.ai/install | bash", "npm install -g opencode-ai"],
      signIn: "opencode auth login",
      signInRuns: true,
      docs: "https://opencode.ai/docs/"
    }
  }
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
    setup: agent.setup,
    picks: () => [{ key: "model", title: "Model", choices: [], freeText: true }],
    available: localAvailability(ctx, { engineId: agent.id, title: agent.title, cli, install: agent.install }),
    checkCli: (file) => cli.check(file),
    async turn() {
      return { stop: "error", error: `${agent.title} runs only in a terminal — start the ticket "In a terminal"` };
    }
  };
}

export function createGeminiEngine(ctx: Context): Engine {
  return createAcpEngine(ctx, gemini);
}

export default {
  name: "engine-terminal",
  inject: ["agent", "mcp"],
  apply(ctx: Context) {
    const engine = createGeminiEngine(ctx);
    ctx.agent.engine(engine);
    // Gemini CLI answers one prompt headless, so its Google sign-in can do worker calls too; OpenCode is not lent yet.
    ctx.inject(["llm"], (ctx) => ctx.effect(() => ctx.llm.lend(geminiLentModel(ctx, { cli: gemini.cli, found: async () => (await engine.available()).ok }))));
    for (const agent of TERMINAL_AGENTS) ctx.agent.engine(createTerminalEngine(ctx, agent));
  }
};

export { forgetSession, geminiDir, geminiLentModel, ownModel } from "./lend.js";
