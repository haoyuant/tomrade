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
