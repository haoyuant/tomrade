import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import { createAcpEngine, PERMISSION_CHOICES, type AcpAgent } from "@tomradex/engine-acp";
import { localCli, type BundledCli, type CliHost } from "@tomradex/engine-claude-code";

export const DshOptions = z.object({
  command: z.string().default("dsh"),
  /** A model as dsh lists it (`deepseek-v4-pro`, `provider/model`); empty keeps its acp profile's route. */
  model: z.string().optional(),
  /** dsh's reasoning effort: off, low, high or max. */
  effort: z.string().optional()
});
export type DshOptions = z.infer<typeof DshOptions>;

const APP = "DeepSeek Harness";

/**
 * The `dsh` launcher inside the DeepSeek Harness desktop app, which runs the
 * ordinary CLI with the app's own runtime. Its "Manage dsh Command…" menu only
 * links it onto PATH, so an app nobody registered it from is found here.
 */
export async function dshDesktopApps(host: Pick<CliHost, "platform" | "env" | "home" | "installs">): Promise<BundledCli[]> {
  if (host.platform === "darwin") {
    const p = path.posix;
    return ["/Applications", p.join(host.home, "Applications")].map((root) => ({ file: p.join(root, `${APP}.app`, "Contents/Resources/runtime/cli/bin/dsh") }));
  }
  if (host.platform === "win32") {
    const w = path.win32;
    const env = (key: string) => Object.entries(host.env).find(([name]) => name.toUpperCase() === key)?.[1];
    const local = env("LOCALAPPDATA") ?? w.join(host.home, "AppData", "Local");
    const roots = [w.join(local, "Programs"), env("PROGRAMFILES"), env("PROGRAMFILES(X86)")].filter((dir): dir is string => !!dir);
    const registered = await host.installs(/deepseek harness/i).catch(() => []);
    const dirs = [...registered, ...roots.map((root) => w.join(root, APP))].filter((dir, i, all) => all.findIndex((d) => d.toLowerCase() === dir.toLowerCase()) === i);
    return dirs.map((dir) => ({ file: w.join(dir, "resources", "runtime", "cli", "bin", "dsh.cmd") }));
  }
  return [];
}

export const dsh: AcpAgent<DshOptions> = {
  id: "dsh",
  title: APP,
  cli: localCli("dsh", { bundled: dshDesktopApps }),
  install: "install the DeepSeek Harness desktop app (deepseek.com/en/harness), or its CLI with npm install -g @deepseek-ai/dsh, and sign in or add a DeepSeek API key",
  // The desktop app is the official install and needs no command; a key or account goes under Settings → Models there, as in `dsh web`.
  setup: { install: ["npm install -g @deepseek-ai/dsh"], signIn: "dsh web", signInRuns: true, docs: "https://www.deepseek.com/en/harness/" },
  options: DshOptions,
  // dsh's ACP server has no modes and its own sandbox rules decide what needs asking; it asks for none of a workspace's reads and writes.
  permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.local] },
  // The shipped `acp` profile initializes itself under $DSH_HOME on first use.
  args: () => ["--profile", "acp"],
  efforts: ["off", "low", "high", "max"],
  // A ticket can also run in a terminal: one headless run, which code link shows and reports.
  terminal: true,
  // A saved key lives in $DSH_HOME/.credentials.yaml, outside any one profile.
  signIn: "sign in or add a DeepSeek API key under Settings → Models in the DeepSeek Harness app (or `dsh web`), or set DEEPSEEK_API_KEY"
};

export function createDshEngine(ctx: Context) {
  return createAcpEngine(ctx, dsh);
}

export default {
  name: "engine-dsh",
  inject: ["agent", "mcp", "tools"],
  apply(ctx: Context) { ctx.agent.engine(createDshEngine(ctx)); }
};
