import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import type {} from "@tomradex/code-link";
import { localAvailability, localCli, pooledEngine } from "@tomradex/engine-kit";
import type {} from "@tomradex/llm";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/settings";
import { piLentModel } from "./lend.js";
import { listedModels, PERMISSION_MODES, PiOptions, piSignedIn } from "./options.js";
import { piConnector, piMcpLink } from "./outside.js";
import { PiRuntime } from "./rpc.js";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function createPiEngine(ctx: Context): Engine {
  const cli = localCli("pi");
  let models: string[] = [];
  return {
    id: "pi",
    title: "Pi",
    author: "ai:pi",
    capabilities: ["backlog", "code", "general"],
    // pi queues messages sent mid-turn itself (RPC steer)
    steering: "forward",
    options: PiOptions,
    media: () => ({ input: ["image/png", "image/jpeg", "image/webp", "image/gif"], output: [] }),
    permissionModes: PERMISSION_MODES,
    available: localAvailability(ctx, {
      engineId: "pi",
      title: "Pi",
      cli,
      install: "install the Pi coding agent and sign in",
      // `--offline` keeps the probe from refreshing model catalogs over the network; the same listing fills the Model pick.
      signIn: {
        args: ["--list-models", "--offline"],
        says: (listing) => {
          models = listedModels(listing);
          return piSignedIn(listing);
        },
        reason: "Pi has no model it can use — run `pi` and /login, or set a provider's API key"
      }
    }),
    local: {
      picks: () => [
        // Pi spans many providers; the list is whatever its credentials unlock.
        { key: "model", title: "Model", choices: models.map((value) => ({ value })), freeText: true },
        { key: "effort", title: "Effort", choices: EFFORTS.map((value) => ({ value })) }
      ],
      checkCli: (file) => cli.check(file),
      mcpLink: piMcpLink(ctx),
      // Inside pi, /login picks a provider; an API key in the environment works too. The built-in agent needs neither.
      setup: { install: ["npm install -g @earendil-works/pi-coding-agent"], signIn: "pi", signInRuns: true, docs: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent" }
    },
    turn: pooledEngine(ctx, { create: (input) => new PiRuntime(ctx, input) })
  };
}

export default {
  name: "engine-pi",
  inject: ["agent", "mcp", "tools"],
  apply(ctx: Context) {
    const engine = createPiEngine(ctx);
    ctx.agent.engine(engine);
    ctx.inject(["llm"], (ctx) => ctx.effect(() => ctx.llm.lend(piLentModel(ctx, { cli: localCli("pi"), found: async () => (await engine.available()).ok }))));
    // Connecting a repository writes Pi's project extension with this engine's writer, whenever code-link comes up.
    ctx.inject(["codeLink"], (ctx) => ctx.effect(() => ctx.codeLink.registerConnector("pi", piConnector)));
  }
};

export { PiOptions, listedModels, piSignedIn, toolSelection } from "./options.js";
export { default as builtinPi, BuiltinPiConfig, BuiltinPiOptions, createBuiltinPiEngine } from "./builtin.js";
export { modelsFile, piTarget, type PiTarget } from "./target.js";
export { bridgeSource } from "./bridge.js";
export { piLentModel } from "./lend.js";
export { outsideExtension, outsideExtensionUrl, piAgentDir, piConnector, piMcpLink, piUserExtension } from "./outside.js";
