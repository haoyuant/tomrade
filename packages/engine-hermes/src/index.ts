import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import { createAcpEngine, PERMISSION_CHOICES, type AcpAgent } from "@tomradex/engine-acp";
import { localCli } from "@tomradex/engine-claude-code";

export const HermesOptions = z.object({
  command: z.string().default("hermes"),
  /** A model id, or `provider:model` to switch provider too; empty keeps Hermes' own default. */
  model: z.string().optional()
});
export type HermesOptions = z.infer<typeof HermesOptions>;

/** `hermes acp --check` imports the ACP adapter, which an install without the `acp` extra lacks. */
export function hermesAcpReady(output: string): boolean | null {
  if (/check ok/i.test(output)) return true;
  if (/ModuleNotFoundError|No module named|ImportError/.test(output)) return false;
  return null;
}

export const hermes: AcpAgent<HermesOptions> = {
  id: "hermes",
  title: "Hermes",
  cli: localCli("hermes"),
  install: "install Hermes Agent (curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash) and run `hermes setup`",
  setup: {
    install: [process.platform === "win32"
      ? "iex (irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1)"
      : "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"],
    signIn: "hermes setup",
    signInRuns: true,
    docs: "https://hermes-agent.nousresearch.com/docs/user-guide/features/acp"
  },
  options: HermesOptions,
  // Non-dangerous commands run without asking whatever the mode, so a read-only turn is not something Hermes can promise.
  permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask] },
  args: () => ["acp"],
  // "default" asks before every edit; dangerous commands are asked about in every mode, and Tomrade answers for the turn.
  mode: (policy) => (policy === "full-access" ? "dont_ask" : "default"),
  // It registers an HTTP server it is handed, though it does not advertise that it can.
  httpMcp: "always",
  // Its `session/resume` opens a fresh session when the old one is gone; `session/load` says so.
  reopen: "load",
  usage: "turn",
  signIn: "run `hermes setup` to choose a provider and add its key",
  probe: {
    args: ["acp", "--check"],
    says: (output) => hermesAcpReady(output),
    reason: "Hermes is installed without its ACP support — run `hermes update`, or reinstall it with the acp extra",
    need: "repair"
  }
};

export function createHermesEngine(ctx: Context) {
  return createAcpEngine(ctx, hermes);
}

export default {
  name: "engine-hermes",
  inject: ["agent", "mcp", "tools"],
  apply(ctx: Context) { ctx.agent.engine(createHermesEngine(ctx)); }
};
