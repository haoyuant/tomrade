import type { Context } from "cordis";
import { z } from "zod";
import type { Engine } from "@tomradex/agent";
import { createAcpEngine, PERMISSION_CHOICES, type AcpAgent } from "@tomradex/engine-acp";
import { localCli } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/llm";
import type {} from "@tomradex/mcp";
import { createAgyEngine } from "./agy.js";
import { GEMINI_SIGN_IN, geminiCanSignIn } from "./auth.js";
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
  // Google ended personal Google sign-in for it: individuals use an API key or Vertex AI.
  setup: { install: ["npm install -g @google/gemini-cli"], signIn: "gemini", signInRuns: true, docs: "https://github.com/google-gemini/gemini-cli" },
  options: GeminiOptions,
  permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask, PERMISSION_CHOICES["read-only"]] },
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
  signIn: GEMINI_SIGN_IN,
  signedIn: { ask: () => geminiCanSignIn(), reason: `Gemini CLI cannot sign in with a personal Google account any more — ${GEMINI_SIGN_IN}` }
};

export function createGeminiEngine(ctx: Context): Engine {
  return createAcpEngine(ctx, gemini);
}

export default {
  name: "engine-terminal",
  inject: ["agent", "mcp"],
  apply(ctx: Context) {
    const engine = createGeminiEngine(ctx);
    ctx.agent.engine(engine);
    // Gemini CLI answers one prompt headless, so its sign-in can do worker calls too.
    ctx.inject(["llm"], (ctx) => ctx.effect(() => ctx.llm.lend(geminiLentModel(ctx, { cli: gemini.cli, found: async () => (await engine.available()).ok }))));
    ctx.agent.engine(createAgyEngine(ctx));
  }
};

export { forgetSession, geminiDir, geminiLentModel, ownModel } from "./lend.js";
export { agyMcpFile, createAgyEngine } from "./agy.js";
export { GEMINI_SIGN_IN, geminiCanSignIn } from "./auth.js";
