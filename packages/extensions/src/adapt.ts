import type { Context, Plugin } from "cordis";
import type {} from "@tomradex/settings";
import { namespaceOf, type LanguagePack, type Manifest, type SdkPlugin, type ServiceName } from "@tomradex/plugin-sdk";
import { Host, cordisName, type ExtensionIdentity } from "./host.js";
import { within } from "./scope.js";

/** A plugin's languages, added while it runs; nothing of the plugin's own code takes part. */
function addLanguages(ctx: Context, identity: ExtensionIdentity, languages: readonly LanguagePack[]): void {
  if (!languages.length) return;
  ctx.inject(["settings"], (inner) => {
    for (const pack of languages) inner.settings.addLanguage({ ...pack, plugin: identity.id });
  });
}

/**
 * An SDK plugin as a row cordis can load: it waits for the services it
 * injects, and its `apply` sees only the host's facade over them.
 */
export function adaptSdkPlugin(plugin: SdkPlugin<unknown>, identity: ExtensionIdentity, languages: readonly LanguagePack[] = []): Plugin.Object {
  const allowed = new Set<ServiceName>([...(plugin.inject ?? []), ...(plugin.optional ?? [])]);
  return {
    name: identity.id,
    inject: (plugin.inject ?? []).map(cordisName),
    Config: plugin.config as Plugin.Object["Config"],
    async apply(ctx, config) {
      const host = new Host(ctx, identity, allowed);
      await within(identity.namespace, () => plugin.apply(host.context, config));
      addLanguages(ctx, identity, languages);
    }
  };
}

/** A plugin that is data only — `main: null` — as a row: its languages, and nothing that runs. */
export function adaptLanguagePacks(identity: ExtensionIdentity, languages: readonly LanguagePack[]): Plugin.Object {
  return {
    name: identity.id,
    apply(ctx) {
      addLanguages(ctx, identity, languages);
    }
  };
}

export function identityOf(manifest: Manifest, where: { root: string; dataDir: string }): ExtensionIdentity {
  return { id: manifest.id, namespace: namespaceOf(manifest), origin: "extension", root: where.root, dataDir: where.dataDir };
}

/** A built-in row written against the SDK: named by its row, trusted like the rest of the app. */
export const builtinIdentity = (rowId: string, root: string | null = null): ExtensionIdentity => ({
  id: rowId,
  namespace: rowId.replace(/-/g, "_"),
  origin: "builtin",
  root,
  dataDir: null
});
