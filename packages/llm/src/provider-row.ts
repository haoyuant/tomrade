import type { Context } from "cordis";
import { z } from "zod";
import { BUILTIN_PROVIDERS } from "./builtin-providers.js";
import type {} from "./index.js";

export const BuiltinProviderConfig = z.object({
  provider: z.enum(BUILTIN_PROVIDERS.map((p) => p.id) as [string, ...string[]])
});
export type BuiltinProviderConfig = z.infer<typeof BuiltinProviderConfig>;

/** One of the app's own model providers on a row of its own, switched off like any plugin. */
export default {
  name: "model-provider",
  inject: ["llm"],
  Config: BuiltinProviderConfig,
  apply(ctx: Context, config: BuiltinProviderConfig) {
    ctx.llm.registerProvider(BUILTIN_PROVIDERS.find((p) => p.id === config.provider)!);
  }
};
