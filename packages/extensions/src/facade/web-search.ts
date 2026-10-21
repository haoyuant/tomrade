import type { WebSearchApi } from "@tomradex/plugin-sdk";
import type { Facade } from "./shared.js";

export const webSearchApi = ({ host }: Facade): WebSearchApi => ({
  register: (spec) =>
    host.call(() => {
      host.own(spec.id, "web search provider");
      const label = `web search provider ${spec.id}`;
      const search = host.back(spec.search.bind(spec), `${label} search`);
      const read = spec.read ? host.back(spec.read.bind(spec), `${label} read`) : null;
      return host.disposerOf(
        host.svc("webSearch").register({
          id: spec.id,
          title: spec.title,
          ...(spec.settings ? { settings: spec.settings } : {}),
          unavailable: () => host.now(() => spec.unavailable(), `${label} unavailable`, (message) => `${spec.title} could not say whether it is set up: ${message}`),
          search: (request, signal) => search(request, signal),
          ...(read ? { read: (request, signal) => read(request, signal) } : {})
        })
      );
    })
});
