import type { GroupBy, ViewKind } from "./types.js";

/**
 * The `views` table still carries legacy `name`/`icon`/`group_by` columns
 * (kept for schema stability — see packages/db). These are the values written
 * into them for each built-in kind; the app itself never reads them back.
 */
export const VIEW_KIND_META: Record<ViewKind, { name: string; icon: string; groupBy: GroupBy; rank: number }> = {
  status: { name: "Status", icon: "s-doing", groupBy: "status", rank: 0 },
  priority: { name: "Priority", icon: "i-bars", groupBy: "priority", rank: 1 },
  epic: { name: "Epic", icon: "i-stack", groupBy: "epic", rank: 2 },
  dependencies: { name: "Dependencies", icon: "i-graph", groupBy: "status", rank: 3 }
};
