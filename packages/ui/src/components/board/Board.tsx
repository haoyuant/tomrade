// Kanban board (adapted from the legacy dual-axis board to the single-axis model).
// Columns = workflow_status; only TICKETS are draggable cards; EPICS filter the board
// (left rail). A drop is a direct human edit: status change + new rank, with the
// original version echoed — a stale version surfaces the conflict banner.

import { DragDropProvider } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import { move } from "@dnd-kit/helpers";
import { useEffect, useMemo, useRef, useState } from "react";
import { Column } from "./Column";
import { cn } from "~/lib/utils";
import { Loading, ErrorState } from "~/components/ui/States";
import { useItems, usePatchItem } from "~/lib/queries";
import { TYPE_COLORS, WORKFLOW_STATUS_ORDER } from "~/lib/design-system";
import type { Item, ItemStatus } from "@tomrade/core";

type Columns = Record<ItemStatus, Item[]>;

function groupByColumn(cards: Item[]): Columns {
  const m = {} as Columns;
  for (const status of WORKFLOW_STATUS_ORDER) {
    m[status] = cards
      .filter((c) => c.status === status)
      .sort((a, b) => a.rank - b.rank);
  }
  return m;
}

function columnOf(items: Columns, id: string): ItemStatus | undefined {
  return WORKFLOW_STATUS_ORDER.find((s) => items[s].some((c) => c.id === id));
}

function rankBetween(prev: number | undefined, next: number | undefined): number {
  if (prev === undefined && next === undefined) return 0;
  if (prev === undefined) return (next ?? 0) - 1;
  if (next === undefined) return prev + 1;
  return (prev + next) / 2;
}

export function Board({ onCardClick }: { onCardClick: (card: Item) => void }) {
  const { data, isLoading, error, refetch } = useItems();
  const patch = usePatchItem();
  const [conflict, setConflict] = useState<string | null>(null);
  const [filterEpicId, setFilterEpicId] = useState<string | null>(null);

  const cards = data ?? [];
  const tickets = useMemo(() => cards.filter((c) => c.kind === "ticket"), [cards]);
  const epics = useMemo(() => cards.filter((c) => c.kind === "epic"), [cards]);
  const epicTitleById = useMemo(() => new Map(epics.map((e) => [e.id, e.title])), [epics]);
  const cardById = useMemo(() => new Map(tickets.map((c) => [c.id, c])), [tickets]);

  const visibleTickets = useMemo(
    () => (filterEpicId ? tickets.filter((t) => t.parentId === filterEpicId) : tickets),
    [tickets, filterEpicId],
  );

  const serverItems = useMemo(() => groupByColumn(visibleTickets), [visibleTickets]);
  const [items, setItems] = useState<Columns>(serverItems);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const draggingRef = useRef(false);
  const originRef = useRef<{ column: ItemStatus; version: number } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!draggingRef.current) setItems(serverItems);
  }, [serverItems]);

  if (isLoading) return <Loading label="Loading board…" />;
  if (error) return <ErrorState message={(error as Error).message} />;

  const activeColumn = activeId ? columnOf(items, activeId) : undefined;
  const highlightStatus =
    activeColumn && activeColumn !== originRef.current?.column ? activeColumn : null;
  const filteredEpic = filterEpicId ? epics.find((e) => e.id === filterEpicId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {conflict && (
        <div className="m-3 flex items-center justify-between rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
          <span>
            Version conflict moving “{conflict}”. The board re-fetched the latest — try the
            move again (optimistic concurrency).
          </span>
          <button type="button" onClick={() => setConflict(null)} className="ml-3 underline hover:text-amber-200">
            Dismiss
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Left rail: epics filter the board (hidden on narrow windows) */}
        <div className="hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-slate-800 bg-slate-900/50 p-3 lg:flex">
          <button
            type="button"
            onClick={() => setFilterEpicId(null)}
            className={cn(
              "rounded px-3 py-2 text-left text-sm",
              filterEpicId === null ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:bg-slate-800/60",
            )}
          >
            All tickets
            <span className="ml-2 text-xs text-slate-500">{tickets.length}</span>
          </button>
          {epics.map((epic) => (
            <button
              key={epic.id}
              type="button"
              onClick={() => setFilterEpicId(epic.id)}
              className={cn(
                "rounded px-3 py-2 text-left text-sm",
                filterEpicId === epic.id ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:bg-slate-800/60",
              )}
            >
              <span className={cn("text-[10px] font-semibold uppercase", TYPE_COLORS.epic.color)}>Epic</span>
              <span className="block truncate">{epic.title}</span>
            </button>
          ))}
          {epics.length === 0 && (
            <p className="px-3 py-2 text-xs text-slate-500">No epics yet</p>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {filteredEpic && (
            <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900/60 px-4 py-2 text-xs">
              <span className="text-slate-500">Filtered to</span>
              <span className={cn("text-[10px] font-semibold uppercase", TYPE_COLORS.epic.color)}>Epic</span>
              <span className="min-w-0 truncate font-medium text-slate-200">{filteredEpic.title}</span>
              <button
                type="button"
                onClick={() => setFilterEpicId(null)}
                className="ml-auto shrink-0 rounded px-2 py-0.5 font-medium text-sky-400 hover:bg-slate-800 hover:text-sky-300"
              >
                Clear
              </button>
            </div>
          )}
          <DragDropProvider
            onDragStart={(event) => {
              const sourceId = event.operation.source?.id;
              if (sourceId == null) return;
              const id = String(sourceId);
              const card = cardById.get(id);
              draggingRef.current = true;
              setActiveId(id);
              originRef.current = card ? { column: card.status, version: card.version } : null;
            }}
            onDragOver={(event) => {
              setItems((current) => move(current, event));
            }}
            onDragEnd={(event) => {
              draggingRef.current = false;
              setActiveId(null);
              const origin = originRef.current;
              originRef.current = null;
              const source = event.operation.source;
              if (event.canceled || !source || !origin || !isSortable(source)) {
                setItems(serverItems);
                return;
              }
              const id = String(source.id);
              const targetColumn = source.group as ItemStatus;
              const arr = itemsRef.current[targetColumn] ?? [];
              const pos = arr.findIndex((c) => c.id === id);
              if (pos === -1) {
                setItems(serverItems);
                return;
              }
              const statusChanged = targetColumn !== origin.column;
              const originIndex = serverItems[origin.column]?.findIndex((c) => c.id === id) ?? -1;
              if (!statusChanged && pos === originIndex) {
                setItems(serverItems);
                return;
              }
              const rank = rankBetween(arr[pos - 1]?.rank, arr[pos + 1]?.rank);
              patch.mutate(
                { id, patch: { rank, ...(statusChanged ? { status: targetColumn } : {}) }, baseVersion: origin.version },
                {
                  onError: (err) => {
                    if (err instanceof Error && /conflict/i.test(err.message)) {
                      setConflict(cardById.get(id)?.title ?? "this card");
                      void refetch();
                    }
                    setItems(serverItems);
                  }
                }
              );
            }}
          >
            <div className="board-scroll flex flex-1 min-w-0 gap-4 overflow-x-auto p-4">
              {WORKFLOW_STATUS_ORDER.map((status) => (
                <Column
                  key={status}
                  status={status}
                  cards={items[status] ?? []}
                  epicTitleById={epicTitleById}
                  isTarget={status === highlightStatus}
                  onCardClick={onCardClick}
                />
              ))}
            </div>
          </DragDropProvider>
        </div>
      </div>
    </div>
  );
}