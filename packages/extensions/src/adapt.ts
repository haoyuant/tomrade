import type { Plugin } from "cordis";
import { namespaceOf, type Manifest, type SdkPlugin, type ServiceName } from "@tomradex/plugin-sdk";
import { Host, cordisName, type ExtensionIdentity } from "./host.js";
import { within } from "./scope.js";

/**
 * An SDK plugin as a row cordis can load: it waits for the services it
 * injects, and its `apply` sees only the host's facade over them.
 */
export function adaptSdkPlugin(plugin: SdkPlugin<unknown>, identity: ExtensionIdentity): Plugin.Object {
  const allowed = new Set<ServiceName>([...(plugin.inject ?? []), ...(plugin.optional ?? [])]);
  return {
    name: identity.id,
    inject: (plugin.inject ?? []).map(cordisName),
    Config: plugin.config as Plugin.Object["Config"],
    async apply(ctx, config) {
      const host = new Host(ctx, identity, allowed);
      await within(identity.namespace, () => plugin.apply(host.context, config));
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
