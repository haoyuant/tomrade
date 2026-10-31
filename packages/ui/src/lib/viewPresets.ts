import type { IconId } from "~/components/icons";
import type { MessageKey } from "~/lib/i18n";

/** The grouped tables a new project is seeded with (db seed.ts), offered when a view is made; urgent first within a group. */
export const GROUPED_TABLE_PRESETS: readonly { groupBy: string; icon: IconId; name: MessageKey }[] = [
  { groupBy: "status", icon: "i-cards", name: "sidebar.presetByStatus" },
  { groupBy: "epic", icon: "i-stack", name: "sidebar.presetByEpic" },
  { groupBy: "priority", icon: "i-alarm", name: "sidebar.presetByPriority" },
  { groupBy: "board", icon: "i-split", name: "sidebar.presetByWorkstream" }
];

export const groupedTableQuery = (groupBy: string) => ({
  groupBy,
  sortBy: [
    { field: "priority", dir: "asc" as const },
    { field: "updated", dir: "desc" as const }
  ]
});
