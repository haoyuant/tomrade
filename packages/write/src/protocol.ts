import type { Context } from "cordis";
import type { Author, OplogEntity, OplogOp } from "@tomradex/domain";
import { extensionScope, writeContext } from "./context.js";

/** What a repository is about to commit. Policy listeners read it and either throw or call next(). */
export interface WriteIntent<T = unknown> {
  /** The project whose file this lands in; listeners reach it with ctx.db.for(projectId). */
  projectId: string;
  entity: OplogEntity;
  op: OplogOp;
  id: string;
  by: Author;
  /** The version the caller read, when it asserts one. */
  baseVersion?: number;
  before: T | null;
  after: T | null;
  /** For an update: only the fields the caller asked to change. */
  patch?: Record<string, unknown>;
  /** The agent run this write belongs to; stamped from the ambient WriteContext. */
  runId?: string;
  /** The extension that made the write; stamped from the ambient extension scope. */
  via?: string;
}

declare module "cordis" {
  interface Events {
    "write/pre-commit"(intent: WriteIntent, next: () => unknown): unknown;
    "write/committed"(intent: WriteIntent): void;
  }
}

/**
 * Every mutation goes through here: the waterfall decides, `commit` lands the
 * rows and the oplog entry, and `write/committed` announces the durable fact.
 * A listener that neither refuses nor delegates is a bug, and is reported as one.
 */
export function write<R>(ctx: Context, intent: WriteIntent, commit: () => R): R {
  if (intent.runId === undefined) intent.runId = writeContext.getStore()?.runId;
  if (intent.via === undefined) intent.via = extensionScope.getStore()?.pluginId;
  let committed = false;
  const result = ctx.waterfall("write/pre-commit", intent, () => {
    committed = true;
    return commit();
  }) as R;
  if (!committed) throw new Error(`write/pre-commit listener for ${intent.entity} ${intent.op} neither refused nor called next()`);
  ctx.emit("write/committed", intent);
  return result;
}
