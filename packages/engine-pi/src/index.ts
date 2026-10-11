import { execFile } from "node:child_process";
import type { Context } from "cordis";
import type { Engine, EngineAvailability } from "@tomradex/agent";
import { binaryOk, RuntimePool, runtimeFingerprint } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/settings";
import { listedModels, PERMISSION_MODES, PiOptions, piSignedIn } from "./options.js";
import { PiRuntime } from "./rpc.js";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `--offline` keeps the probe from refreshing model catalogs over the network. */
const listModels = (command: string): Promise<string> =>
  new Promise((resolve) => {
    execFile(command, ["--list-models", "--offline"], { timeout: 8000 }, (_err, stdout, stderr) => resolve(`${stdout}\n${stderr}`));
  });

export function createPiEngine(ctx: Context): Engine {
  const pool = new RuntimePool<PiRuntime>();
  ctx.effect(() => () => pool.close());
  let probe: { at: number; state: EngineAvailability } | null = null;
  let models: string[] = [];
  return {
    id: "pi",
    title: "Pi",
    author: "ai:pi",
    capabilities: ["backlog", "code", "general"],
    options: PiOptions,
    media: () => ({ input: ["image/png", "image/jpeg", "image/webp", "image/gif"], output: [] }),
    permissionModes: PERMISSION_MODES,
    picks: () => [
      // Pi spans many providers; the list is whatever its credentials unlock.
      { key: "model", title: "Model", choices: models.map((value) => ({ value })), freeText: true },
      { key: "effort", title: "Effort", choices: EFFORTS.map((value) => ({ value })) }
    ],
    async available() {
      if (probe && Date.now() - probe.at < 30_000) return probe.state;
      const saved = (ctx.get("settings")?.get().agent as { engines?: Record<string, unknown> } | undefined)?.engines?.pi;
      const command = PiOptions.safeParse(saved ?? {}).data?.command ?? "pi";
      const bin = await binaryOk(command);
      let state: EngineAvailability;
      if (!bin.ok) state = { ok: false, reason: "pi CLI not found — install the Pi coding agent and sign in", need: "install" };
      else if (!ctx.get("mcp")?.url) state = { ok: false, reason: "the MCP server is not running — enable the mcp plugin", need: "service" };
      else {
        const listing = await listModels(command);
        models = listedModels(listing);
        state = piSignedIn(listing) === false ? { ok: false, reason: "Pi has no model it can use — run `pi` and /login, or set a provider's API key", need: "sign-in" } : { ok: true };
      }
      probe = { at: Date.now(), state };
      return state;
    },
    async turn(input, io) {
      if (!ctx.mcp.url) return { stop: "error", error: "The MCP server is not running" };
      return pool.run(`${input.projectId}:${input.threadId}`, runtimeFingerprint(input, io, ctx.mcp.url),
        () => new PiRuntime(ctx, input), input, io);
    }
  };
}

export default {
  name: "engine-pi",
  inject: ["agent", "mcp", "tools"],
  apply(ctx: Context) { ctx.agent.engine(createPiEngine(ctx)); }
};

export { PiOptions, listedModels, piSignedIn, toolSelection } from "./options.js";
export { bridgeSource } from "./bridge.js";
