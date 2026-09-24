import { AsyncLocalStorage } from "node:async_hooks";
import type { Author } from "@tomrade/domain";

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
