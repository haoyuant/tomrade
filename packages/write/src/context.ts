import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Fiber } from "cordis";
import type { Author } from "@tomradex/domain";

export interface WriteScope {
  runId: string;
  author: Author;
}

/**
 * Ambient run attribution. `ctx.tools.execute` opens a scope when the
 * invocation belongs to an agent run; `write()` and `oplog.append` read it, so
 * repositories and tool signatures never carry the run id themselves.
 */
export const writeContext = new AsyncLocalStorage<WriteScope>();

export interface ExtensionScope {
  /** The extension's namespace: what `via` records and what undo-by-plugin selects on. */
  pluginId: string;
  /** A person asked for this: a palette command, or a renderer call to the extension's channel. */
  human: boolean;
}

/**
 * Which extension is running. The host opens it around every call an SDK
 * plugin makes and every callback the host makes into one, so attribution is
 * the host's statement, never the plugin's claim.
 */
export const extensionScope = new AsyncLocalStorage<ExtensionScope>();

/** Full-mode extensions, by the function cordis runs for each: its own, or its `apply`. */
const fullPlugins = new WeakMap<object, string>();
let anyFull = false;

/** A plugin that runs with the whole Context: what it writes carries its namespace, as an SDK plugin's does. */
export function claimFullPlugin(plugin: object, namespace: string): void {
  const callback = typeof plugin === "function" ? plugin : (plugin as { apply?: unknown }).apply;
  if (typeof callback !== "function") return;
  fullPlugins.set(callback, namespace);
  anyFull = true;
}

/**
 * The full-mode extension a context belongs to. A service method sees its
 * caller's context, so walking out through the fibers that loaded it finds the
 * plugin — and any plugin that one loaded in turn.
 */
export function fullPluginOf(ctx: Context): string | undefined {
  if (!anyFull) return undefined;
  const seen = new Set<number>();
  let fiber: Fiber | undefined = ctx.fiber;
  while (fiber?.uid != null && !seen.has(fiber.uid)) {
    const callback = fiber.runtime?.callback;
    const namespace = callback ? fullPlugins.get(callback) : undefined;
    if (namespace) return namespace;
    seen.add(fiber.uid);
    fiber = fiber.parent?.fiber;
  }
  return undefined;
}
