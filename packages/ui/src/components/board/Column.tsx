// One kanban column = one workflow_status. The cards container is a useDroppable so an
// EMPTY column can still receive a drop (collisionPriority Low lets cards win).

import { useDroppable } from "@dnd-kit/react";
import { CollisionPriority } from "@dnd-kit/abstract";
import { cn } from "~/lib/utils";
import { BoardCard } from "./BoardCard";
import { WORKFLOW_STATUS } from "~/lib/design-system";
import type { Item, ItemStatus } from "@tomrade/core";

export function Column({
  status,
  cards,
  epicTitleById,
  isTarget = false,
  onCardClick,
}: {
  status: ItemStatus;
  cards: Item[];
  epicTitleById: Map<string, string>;
  isTarget?: boolean;
  onCardClick: (card: Item) => void;
}) {
  const { ref } = useDroppable({
    id: status,
    type: "column",
    accept: "card",
    collisionPriority: CollisionPriority.Low,
  });
  const meta = WORKFLOW_STATUS[status];

  return (
    <div
      className={cn(
        "flex h-full w-72 shrink-0 flex-col rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 transition-shadow",
        isTarget && "ring-2 ring-sky-500",
      )}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className={cn("text-sm font-semibold", meta?.color)}>
          {meta?.label ?? status}
        </h2>
        <span className="rounded-full bg-slate-200 dark:bg-slate-800 px-2 py-0.5 text-xs text-slate-500 dark:text-slate-400">
          {cards.length}
        </span>
      </div>
      {/* flex-1 min-h-0: column fills the screen height; too many cards scroll inside */}
      <div ref={ref} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {cards.map((card, index) => (
          <BoardCard
            key={card.id}
            card={card}
            index={index}
            column={status}
            epicTitle={card.parentId ? epicTitleById.get(card.parentId) : undefined}
            onClick={() => onCardClick(card)}
          />
        ))}
        {cards.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-slate-500">
            No items
          </p>
        )}
      </div>
    </div>
  );
}