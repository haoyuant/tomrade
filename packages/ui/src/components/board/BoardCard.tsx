// A draggable kanban card (new dnd-kit engine, @dnd-kit/react). Renders kind,
// provenance (human/AI/locked) and the parent epic — adapted from the legacy board.

import { useSortable } from "@dnd-kit/react/sortable";
import { cn } from "~/lib/utils";
import { Badge } from "~/components/ui/Badge";
import { TYPE_COLORS, PROVENANCE } from "~/lib/design-system";
import { provenanceOf } from "~/lib/queries";
import type { Item, ItemStatus } from "@tomrade/core";

export function BoardCard({
  card,
  index,
  column,
  epicTitle,
  onClick,
}: {
  card: Item;
  index: number;
  column: ItemStatus;
  epicTitle?: string;
  onClick?: () => void;
}) {
  const { ref, isDragging } = useSortable({
    id: card.id,
    index,
    group: column,
    type: "card",
    accept: "card",
  });
  const t = TYPE_COLORS[card.kind];
  const prov = PROVENANCE[provenanceOf(card)];

  return (
    <div
      ref={ref}
      onClick={onClick}
      className={cn(
        "cursor-grab rounded-md border border-slate-700 bg-slate-900 p-3 shadow-sm hover:border-slate-600 active:cursor-grabbing",
        isDragging && "z-50 opacity-60 shadow-lg",
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className={cn("text-[10px] font-medium uppercase", t?.color)}>
          {t?.label ?? card.kind}
        </span>
        {prov && (
          <Badge
            className={prov.badge}
            title={`Last edit: ${card.updatedBy} · v${card.version}`}
          >
            {prov.label === "Locked" ? "🔒 " : ""}
            {prov.label}
          </Badge>
        )}
      </div>

      <p className="text-sm text-slate-200">{card.title}</p>

      {epicTitle && (
        <div className="mt-2 border-t border-slate-800 pt-1.5">
          <span className="text-[10px] font-medium text-violet-400">
            {epicTitle}
          </span>
        </div>
      )}
    </div>
  );
}
