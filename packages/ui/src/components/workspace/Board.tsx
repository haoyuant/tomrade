import { useEffect, useMemo, useRef, useState } from "react";
import { CollisionPriority } from "@dnd-kit/abstract";
import { DragDropProvider, useDroppable } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { move } from "@dnd-kit/helpers";
import type { Item } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { columnKeyOf, columnLabel, patchForColumn } from "~/lib/domain";
import { useCreateItem, usePatchItem, useSetViewRank, useUndo } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { Card } from "./Card";
import { useWorkspace } from "./context";

type Columns = Record<string, Item[]>;

/**
 * Returns null when a midpoint is impossible — equal or inverted neighbours,
 * which is the common case while every card still sits at the default rank 0.
 * The caller renumbers the column instead of storing a value that changes nothing.
 */
function rankBetween(prev: number | undefined, next: number | undefined): number | null {
  if (prev === undefined && next === undefined) return 0;
  if (prev === undefined) return (next ?? 0) - 1;
  if (next === undefined) return prev + 1;
  if (next - prev < 1e-6) return null;
  return (prev + next) / 2;
}

/**
 * view_item_rank is sparse, so a neighbour may still be ordered by items.rank.
 * A new rank has to be computed in the same domain the board sorts by, or it
 * lands in the wrong place the moment the two disagree (TOM-77).
 */
const effectiveRank = (item: Item, ranks: Record<string, number>) => ranks[item.id] ?? item.rank;

function SortableCard({ item, index, column, onOpen, onNudge }: { item: Item; index: number; column: string; onOpen: () => void; onNudge: (d: -1 | 1) => void }) {
  const { ref, isDragging } = useSortable({ id: item.id, index, type: "card", accept: "card", group: column });
  return <Card item={item} onOpen={onOpen} onNudge={onNudge} dragging={isDragging} dragHandleRef={ref as (node: HTMLElement | null) => void} />;
}

/** Creation in context: the column supplies whichever field the board groups by. */
function Composer({ columnKey, onDone }: { columnKey: string; onDone: () => void }) {
  const { project, board, query } = useWorkspace();
  const create = useCreateItem(project.id);
  const undo = useUndo(project.id);
  const toast = useToast();

  const submit = (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return onDone();
    const seeded = patchForColumn(columnKey, query.group);
    create.mutate(
      {
        title: trimmed,
        boardId: board.id,
        status: "status" in seeded ? seeded.status : "todo",
        priority: "priority" in seeded ? seeded.priority : query.priorities[0],
        // an armed filter supplies the rest, so a new issue cannot vanish the moment it is created
        parentId: "parentId" in seeded ? seeded.parentId : query.epics.find((e) => e !== "none") ?? null,
        labels: query.labels.slice(0, 1)
      },
      {
        onSuccess: (item) => {
          onDone();
          toast({ body: <>Created <span className="num">{item.key}</span></>, onUndo: () => undo.mutate(item.id) });
        }
      }
    );
  };

  return (
    <div className="card" style={{ gridTemplateColumns: "1fr", padding: 8, cursor: "default" }}>
      <input
        autoFocus
        className="input"
        placeholder="Title, sized for one PR…"
        style={{ fontSize: 14, border: 0, background: "transparent", padding: "2px 4px" }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onDone();
          }
          if (e.key === "Enter") submit(e.currentTarget.value);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.value.trim()) onDone();
        }}
      />
    </div>
  );
}

function Column({
  columnKey,
  index,
  cards,
  onOpen,
  onNudge
}: {
  columnKey: string;
  index: number;
  cards: Item[];
  onOpen: (item: Item) => void;
  onNudge: (item: Item, d: -1 | 1) => void;
}) {
  const { query, epicNames, board, filterCount } = useWorkspace();
  const [composing, setComposing] = useState(false);
  // Low priority lets a card win the collision, so an empty column still accepts a drop.
  const { ref, isDropTarget } = useDroppable({ id: columnKey, type: "column", accept: "card", collisionPriority: CollisionPriority.Low });

  const label = columnLabel(columnKey, query.group, epicNames);
  const cap = query.wip[columnKey];
  const over = cap !== undefined && cards.length > cap;

  const empty =
    query.group === "priority"
      ? `Nothing at ${label.toLowerCase()} priority${filterCount ? " matches these filters" : " on this board"}.`
      : query.group === "epic"
        ? columnKey === "none"
          ? "Every issue here has a parent epic."
          : `Nothing in “${label}”${filterCount ? " matches these filters" : " yet"}. Drag an issue here to link it.`
        : `No issues in ${label.toLowerCase()}${filterCount ? " match these filters" : ""}. Drag one here or add below.`;

  return (
    <section className={`col${isDropTarget ? " drop-target" : ""}`} role="group" aria-label={`${label} — ${cards.length} issue${cards.length === 1 ? "" : "s"}`}>
      <div className="col-head">
        <span className="col-num">{String(index + 1).padStart(2, "0")}</span>
        <span className="col-name">{label}</span>
        <span className={`col-count num${over ? " over" : ""}`}>{cap !== undefined ? `${cards.length} / ${cap}` : cards.length}</span>
      </div>
      <div className="col-body" ref={ref as (node: HTMLElement | null) => void}>
        {cards.length === 0 && !composing && <p className="col-empty">{empty}</p>}
        {cards.map((item, i) => (
          <SortableCard key={item.id} item={item} index={i} column={columnKey} onOpen={() => onOpen(item)} onNudge={(d) => onNudge(item, d)} />
        ))}
        {composing && <Composer columnKey={columnKey} onDone={() => setComposing(false)} />}
        {/* a cross-board space has no one board to write into, so it defers to the New issue sheet */}
        {!board.across && !composing && (
          <button type="button" className="btn btn-ghost" style={{ justifyContent: "flex-start", marginTop: 2 }} onClick={() => setComposing(true)}>
            <Icon name="i-plus" size={13} /> New issue
          </button>
        )}
      </div>
    </section>
  );
}

export function Board({ onConflict }: { onConflict: (title: string) => void }) {
  const { project, view, board, query, visible, select, ranks, epicNames } = useWorkspace();
  const patch = usePatchItem(project.id);
  const setRank = useSetViewRank(project.id);
  const toast = useToast();
  const undo = useUndo(project.id);

  const server = useMemo<Columns>(() => {
    const out: Columns = {};
    for (const key of query.columns) out[key] = [];
    for (const item of visible) {
      const key = columnKeyOf(item, query.group);
      if (out[key]) out[key].push(item);
    }
    return out;
  }, [visible, query.columns, query.group]);

  const [columns, setColumns] = useState<Columns>(server);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const dragging = useRef(false);
  const origin = useRef<{ column: string; version: number; item: Item } | null>(null);
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    if (!dragging.current) setColumns(server);
  }, [server]);

  /** One pass over the column when a midpoint is not available. */
  const renumber = (column: string) => {
    (columnsRef.current[column] ?? []).forEach((card, i) => setRank.mutate({ viewId: view.id, itemId: card.id, rank: i }));
  };

  const write = (item: Item, targetColumn: string, order: { column: string; rank: number | null } | null, fromColumn: string) => {
    const changed = targetColumn !== fromColumn;
    // A recency-sorted space orders by last write, so a manual rank there would
    // be stored and never honoured.
    const manual = board.sort === "recent" ? null : order;
    if (!changed && !manual) return;
    // The order write waits on the field write: a refused move must not leave a
    // rank behind for a card that never went anywhere.
    const commitOrder = () => {
      if (!manual) return;
      if (manual.rank === null) renumber(manual.column);
      else setRank.mutate({ viewId: view.id, itemId: item.id, rank: manual.rank });
    };
    if (!changed) return commitOrder();
    patch.mutate(
      { id: item.id, patch: patchForColumn(targetColumn, query.group), baseVersion: item.version },
      {
        onError: (err) => {
          setColumns(server);
          if (err instanceof Error && /conflict/i.test(err.message)) onConflict(item.title);
        },
        onSuccess: () => (
          commitOrder(),
          toast({
            body: (
              <>
                Moved <span className="num">{item.key}</span> to {columnLabel(targetColumn, query.group, epicNames)}
              </>
            ),
            onUndo: () => undo.mutate(item.id)
          })
        )
      }
    );
  };

  /** The keyboard equivalent of a drag: one column left or right, same write path. */
  const nudge = (item: Item, direction: -1 | 1) => {
    const from = query.columns.indexOf(columnKeyOf(item, query.group));
    const to = from + direction;
    if (from < 0) return;
    if (to < 0 || to >= query.columns.length) {
      toast({ body: <><span className="num">{item.key}</span> is already in the {direction < 0 ? "first" : "last"} column</> });
      return;
    }
    write(item, query.columns[to], null, query.columns[from]);
    // the card is remounted in its new column, so focus has to be handed back
    refocus.current = item.id;
  };

  // Focus follows the card across the re-render, which is what makes ← → usable
  // without the mouse.
  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    const node = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
    if (node) {
      node.focus();
      refocus.current = null;
    }
  }, [columns]);

  return (
    <DragDropProvider
      onDragStart={(event) => {
        const id = event.operation.source?.id;
        if (id == null) return;
        const item = visible.find((i) => i.id === String(id));
        dragging.current = true;
        origin.current = item ? { column: columnKeyOf(item, query.group), version: item.version, item } : null;
      }}
      onDragOver={(event) => setColumns((current) => move(current, event))}
      onDragEnd={(event) => {
        dragging.current = false;
        const start = origin.current;
        origin.current = null;
        if (event.canceled || !start) return setColumns(server);
        const target = Object.keys(columnsRef.current).find((key) => columnsRef.current[key].some((c) => c.id === start.item.id));
        if (!target) return setColumns(server);
        const arr = columnsRef.current[target];
        const pos = arr.findIndex((c) => c.id === start.item.id);
        const before = arr[pos - 1] ? effectiveRank(arr[pos - 1], ranks) : undefined;
        const after = arr[pos + 1] ? effectiveRank(arr[pos + 1], ranks) : undefined;
        write(start.item, target, { column: target, rank: rankBetween(before, after) }, start.column);
      }}
    >
      <div className="col-track">
        {query.columns.map((key, i) => (
          <Column key={key} columnKey={key} index={i} cards={columns[key] ?? []} onOpen={(item) => select(item.id)} onNudge={nudge} />
        ))}
      </div>
    </DragDropProvider>
  );
}
