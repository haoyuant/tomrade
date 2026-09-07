import type { Context } from "cordis";
import type { Author } from "@tomrade/domain";

/**
 * The slice of ctx.items a workstream needs. Structural on purpose: items
 * already depends on boards (its tools land issues on the default workstream),
 * so boards cannot import it back without a package cycle.
 */
export interface ItemsLike {
  list(filter: { projectId?: string; boardId?: string }): { id: string }[];
  moveToBoard(projectId: string, itemIds: string[], toBoardId: string, by: Author): number;
}

export function itemsOf(ctx: Context): ItemsLike {
  const items = ctx.get("items") as ItemsLike | undefined;
  if (!items) throw new Error("the items service is not loaded");
  return items;
}
