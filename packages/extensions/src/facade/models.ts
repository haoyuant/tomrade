import { listModels } from "@tomradex/llm";
import type { ModelsApi } from "@tomradex/plugin-sdk";
import { compatible, modelProvider, strings } from "./model-provider.js";
import type { Facade } from "./shared.js";

export const modelsApi = ({ host }: Facade): ModelsApi => ({
  registerProvider: (spec) =>
    host.call(() => {
      host.own(spec.id, "model provider");
      for (const preset of spec.presets ?? []) host.own(preset.id, "model preset");
      return host.disposerOf(host.svc("models").registerProvider(modelProvider(host, spec)));
    }),
  compatible: (options) => compatible(host, options),
  listCompatible: (endpoint, signal) =>
    host.call(async () => {
      host.svc("models");
      const listed = await listModels({ provider: "openai-compatible", baseURL: String(endpoint.baseURL) }, String(endpoint.apiKey ?? ""), 15_000, signal, endpoint.headers ? strings(endpoint.headers) : undefined);
      return listed.ok ? { ok: true as const, models: listed.models, capabilities: listed.capabilities } : listed;
    })
});
