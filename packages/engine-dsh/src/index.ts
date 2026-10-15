import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import { createAcpEngine, PERMISSION_CHOICES, type AcpAgent } from "@tomradex/engine-acp";
import { localCli } from "@tomradex/engine-claude-code";

export const DshOptions = z.object({
  command: z.string().default("dsh"),
  /** A model as dsh lists it (`deepseek-v4-pro`, `provider/model`); empty keeps its acp profile's route. */
  model: z.string().optional(),
  /** dsh's reasoning effort: off, low, high or max. */
  effort: z.string().optional()
});
export type DshOptions = z.infer<typeof DshOptions>;

export const dsh: AcpAgent<DshOptions> = {
  id: "dsh",
  title: "dsh",
  cli: localCli("dsh"),
  install: "install DeepSeek Harness (npm install -g @deepseek-ai/dsh) and add a DeepSeek API key",
  // Its web app's Models page stores the DeepSeek key.
  setup: { install: ["npm install -g @deepseek-ai/dsh"], signIn: "dsh web", signInRuns: true, docs: "https://github.com/deepseek-ai/deepseek-harness" },
  options: DshOptions,
  // dsh's ACP server has no modes and its own sandbox rules decide what needs asking; it asks for none of a workspace's reads and writes.
  permissionModes: { default: "full-access", mainDefault: "local", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.local] },
  // The shipped `acp` profile initializes itself under $DSH_HOME on first use.
  args: () => ["--profile", "acp"],
  efforts: ["off", "low", "high", "max"],
  signIn: "add a DeepSeek API key in `dsh web` → Models, or set DEEPSEEK_API_KEY"
};

export function createDshEngine(ctx: Context) {
  return createAcpEngine(ctx, dsh);
}

export default {
  name: "engine-dsh",
  inject: ["agent", "mcp", "tools"],
  apply(ctx: Context) { ctx.agent.engine(createDshEngine(ctx)); }
};
