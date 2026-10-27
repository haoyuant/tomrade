import { useEffect, useMemo, useRef, useState } from "react";
import { CollisionPriority } from "@dnd-kit/abstract";
import { DragDropProvider, useDroppable } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { move } from "@dnd-kit/helpers";
import { CLOSED_STATUSES, EMPTY_KEY, groupKeyOf, type ClosedStatus, type Item, type Patch } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { isClosed } from "~/lib/closedWindow";
import { fieldLabel } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useDoneGuard } from "~/lib/doneGuard";
import { useCreateItem, usePatchItem, useSetViewRank, useSetViewRanks } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { Card } from "./Card";
import { LoadMore } from "./ClosedMore";
import { useWorkspace, type WorkspaceValue } from "./context";
import { EpicPriority, EpicProgressBar, EpicStatus, EpicTitle, type EpicProgress } from "./EpicHeader";
import { mergePatch, seedFromFilter, toCreateInput } from "./patches";
import { useToastUndo } from "~/lib/undo";
import { isCancelKey, isCommitKey } from "~/lib/keys";

/** One drop target is one lane × column pair; the lane key is "" when there are no swimlanes. Keys are ids, words or digits, never "|". */
const SEP = "|";
const cellKey = (lane: string, col: string) => `${lane}${SEP}${col}`;
const splitCell = (key: string) => {
  const i = key.indexOf(SEP);
  return { lane: key.slice(0, i), col: key.slice(i + 1) };
};

type Cells = Record<string, Item[]>;

/**
 * Returns null when a midpoint is impossible — equal or inverted neighbours,
 * which is the common case while every card still sits at the default rank 0.
 * The caller renumbers the cell instead of storing a value that changes nothing.
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

function SortableCard({ item, index, cell, onOpen, onNudge }: { item: Item; index: number; cell: string; onOpen: () => void; onNudge: (d: -1 | 1) => void }) {
  const { ref, isDragging } = useSortable({ id: item.id, index, type: "card", accept: "card", group: cell });
  return <Card item={item} onOpen={onOpen} onNudge={onNudge} dragging={isDragging} dragHandleRef={ref as (node: HTMLElement | null) => void} />;
}

/** Creation in context: the column and the lane supply their fields, the filter the rest. */
function Composer({ seed, onDone }: { seed: Patch; onDone: () => void }) {
  const { t, tx } = useI18n();
  const ws = useWorkspace();
  const create = useCreateItem(ws.project.id);
  const undoWrite = useToastUndo(ws.project.id);
  const toast = useToast();

  const submit = (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return onDone();
    const input = toCreateInput(trimmed, mergePatch(seedFromFilter(ws.query, ws.fieldById), seed), ws.boards[0]?.id ?? "");
    if (!input) return onDone();
    create.mutate(input, {
      onSuccess: (item) => {
        onDone();
        toast({ body: <>{tx("board.createdToast", { key: <span className="num">{item.key}</span> })}</>, onUndo: () => undoWrite({ id: item.id, stamp: item.version }) });
      },
      onError: (err) => toast(errorSpec(err))
    });
  };

  return (
    <div className="card" style={{ gridTemplateColumns: "1fr", padding: 8, cursor: "default" }}>
      <input
        autoFocus
        className="input"
        placeholder={t("board.composerPlaceholder")}
        style={{ fontSize: 14, border: 0, background: "transparent", padding: "2px 4px" }}
        onKeyDown={(e) => {
          if (isCancelKey(e)) {
            e.stopPropagation();
            onDone();
          }
          if (isCommitKey(e)) submit(e.currentTarget.value);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.value.trim()) onDone();
        }}
      />
    </div>
  );
}

function ColumnHead({ index, label, count, cap }: { index: number; label: string; count: number; cap: number | undefined }) {
  const over = cap !== undefined && count > cap;
  return (
    <div className="col-head">
      <span className="col-num">{String(index + 1).padStart(2, "0")}</span>
      <span className="col-name">{label}</span>
      <span className={`col-count num${over ? " over" : ""}`}>{cap !== undefined ? `${count} / ${cap}` : count}</span>
    </div>
  );
}

function Column({
  cell,
  index,
  label,
  cards,
  head,
  seed,
  more,
  onOpen,
  onNudge
}: {
  cell: string;
  index: number;
  label: string;
  cards: Item[];
  /** Shown once per column: at the top of a plain board, or in the shared header row above swimlanes. */
  head: { count: number; cap: number | undefined } | null;
  /** What creating here writes; null hides the composer (the column's field cannot be written). */
  seed: Patch | null;
  /** A done or cancelled column, whose older tickets load on request; shown at its foot. */
  more: ClosedStatus | null;
  onOpen: (item: Item) => void;
  onNudge: (item: Item, d: -1 | 1) => void;
}) {
  const { t } = useI18n();
  const { filterCount, query, search, closed } = useWorkspace();
  const [composing, setComposing] = useState(false);
  // Low priority lets a card win the collision, so an empty column still accepts a drop.
  const { ref, isDropTarget } = useDroppable({ id: cell, type: "column", accept: "card", collisionPriority: CollisionPriority.Low });
  const sorted = query.sortBy.length > 0;

  return (
    <section className={`col${isDropTarget ? " drop-target" : ""}`} role="group" aria-label={t("board.columnAria", { label, n: cards.length })} data-column={splitCell(cell).col}>
      {head && <ColumnHead index={index} label={label} count={head.count} cap={head.cap} />}
      <div className="col-body" ref={ref as (node: HTMLElement | null) => void}>
        {cards.length === 0 && !composing && !(more && closed.hidden(more)) && <p className="col-empty">{search.trim() ? t("board.emptySearch", { label, query: search.trim() }) : t(filterCount ? "board.emptyFiltered" : "board.emptyPlain", { label })}</p>}
        {cards.map((item, i) => (
          <SortableCard key={item.id} item={item} index={i} cell={cell} onOpen={() => onOpen(item)} onNudge={(d) => onNudge(item, d)} />
        ))}
        {more && <LoadMore statuses={[more]} text={(n) => t("board.hiddenMore", { n })} />}
        {composing && seed && <Composer seed={seed} onDone={() => setComposing(false)} />}
        {seed && !composing && (
          <button type="button" className="btn btn-ghost" style={{ justifyContent: "flex-start", marginTop: 2 }} onClick={() => setComposing(true)}>
            <Icon name="i-plus" size={13} /> {t("board.newIssue")}
          </button>
        )}
        {sorted && cards.length > 1 && <p className="sort-lock meta-txt dense">{t("board.sortLock")}</p>}
      </div>
    </section>
  );
}

/** The write a drop or a nudge makes: the column's field, the lane's field, or both, in one patch. */
function patchForMove(ws: WorkspaceValue, from: { lane: string; col: string }, to: { lane: string; col: string }): Patch | null | "refused" {
  const cb = ws.query.columnBy ?? "status";
  let patch: Patch = {};
  if (to.col !== from.col) {
    const p = ws.patchFor(cb, to.col);
    if (!p) return "refused";
    patch = mergePatch(patch, p);
  }
  if (ws.query.groupBy && to.lane !== from.lane) {
    const p = ws.patchFor(ws.query.groupBy, to.lane);
    if (!p) return "refused";
    patch = mergePatch(patch, p);
  }
  return Object.keys(patch).length ? patch : null;
}

function EpicLaneHead({
  epic,
  label,
  count,
  progress,
  collapsed,
  onToggle,
  onOpen
}: {
  epic: Item | undefined;
  label: string;
  count: number;
  progress: EpicProgress | undefined;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className={epic ? "lane-head lane-epic" : "lane-head lane-epic is-none"}>
      <EpicTitle epic={epic} label={label} count={count} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />
      {epic && (
        <span className="lane-epic-facts">
          <EpicStatus epic={epic} />
          <EpicPriority epic={epic} />
          {progress && progress.total > 0 && <EpicProgressBar {...progress} />}
        </span>
      )}
    </div>
  );
}

export function Board({ onConflict }: { onConflict: (title: string) => void }) {
  const { t, tx } = useI18n();
  const ws = useWorkspace();
  const { project, view, query, visible, select, ranks, columnKeys, groupSpace, groupLabel, patchFor, fieldById, closed } = ws;
  const patch = usePatchItem(project.id);
  const guard = useDoneGuard();
  const setRank = useSetViewRank(project.id);
  const setRanks = useSetViewRanks(project.id);
  const toast = useToast();
  const undoWrite = useToastUndo(project.id);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasMoreColumns, setHasMoreColumns] = useState(false);
  const cb = query.columnBy ?? "status";
  const groupBy = query.groupBy;

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const update = () => setHasMoreColumns(scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 1);
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    for (const child of scroller.children) observer.observe(child);
    scroller.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", update);
    };
  }, [groupBy, columnKeys]);

  const scrollRight = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollBy({
      left: scroller.clientWidth,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
    });
  };
  const lanes = useMemo(() => (groupBy ? groupSpace(groupBy) : [""]), [groupBy, groupSpace]);
  const epicById = useMemo(() => new Map(ws.epics.map((e) => [e.id, e])), [ws.epics]);
  const progress = groupBy === "epic" ? ws.epicProgress : null;

  const server = useMemo<Cells>(() => {
    const out: Cells = {};
    for (const lane of lanes) for (const col of columnKeys) out[cellKey(lane, col)] = [];
    for (const item of visible) {
      const key = cellKey(groupBy ? groupKeyOf(item, groupBy) : "", groupKeyOf(item, cb));
      if (out[key]) out[key].push(item);
    }
    return out;
  }, [visible, lanes, columnKeys, groupBy, cb]);

  const [cells, setCells] = useState<Cells>(server);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const dragging = useRef(false);
  const origin = useRef<{ cell: string; item: Item } | null>(null);
  const refocus = useRef<string | null>(null);
  /** Lanes the user shut, plus `!key` for empty lanes the user opened (an empty lane starts shut). */
  const [toggled, setToggled] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!dragging.current) setCells(server);
  }, [server]);

  /** A done or cancelled status column: it holds only part of itself, so it heads with the true count. */
  const closedColumn = (col: string): ClosedStatus | null => (cb === "status" && isClosed(col) ? col : null);
  const held = (col: string) => lanes.reduce((n, lane) => n + (cells[cellKey(lane, col)]?.length ?? 0), 0);
  const columnCount = (col: string) => {
    const status = closedColumn(col);
    return status ? held(col) + closed.hidden(status) : held(col);
  };
  // Columns by another field mix closed tickets into every column, so the board says once what it left out.
  const closedElsewhere = cb !== "status";
  const laneCount = (lane: string) => columnKeys.reduce((n, col) => n + (cells[cellKey(lane, col)]?.length ?? 0), 0);

  const rankFailed = (err: Error) => {
    setCells(server);
    toast(errorSpec(err));
  };
  /** One write for the whole cell when a midpoint is not available — only the cards whose place changes. */
  const renumber = (cell: string) => {
    const moved = Object.fromEntries((cellsRef.current[cell] ?? []).flatMap((card, i) => (effectiveRank(card, ranks) === i ? [] : [[card.id, i]])));
    if (Object.keys(moved).length) setRanks.mutate({ viewId: view.id, ranks: moved }, { onError: rankFailed });
  };

  const write = (item: Item, fromCell: string, toCell: string, order: { rank: number | null } | null) => {
    const from = splitCell(fromCell);
    const to = splitCell(toCell);
    const fieldPatch = patchForMove(ws, from, to);
    if (fieldPatch === "refused") {
      setCells(server);
      const field = fieldById.get(to.col !== from.col ? cb : (groupBy ?? cb));
      toast({ body: t("board.cannotDropToast", { field: field ? fieldLabel(field) : cb }) });
      return;
    }
    // A sorted board orders by its sort keys, so a manual rank there would be stored and never
    // honoured; a workstream page is not a saved view, so it keeps no order of its own.
    const manual = query.sortBy.length || ws.virtual ? null : order;
    if (!fieldPatch && !manual) return;
    // The order write waits on the field write: a refused move must not leave a
    // rank behind for a card that never went anywhere.
    const commitOrder = () => {
      if (!manual) return;
      if (manual.rank === null) renumber(toCell);
      else setRank.mutate({ viewId: view.id, itemId: item.id, rank: manual.rank }, { onError: rankFailed });
    };
    if (!fieldPatch) return commitOrder();
    void guard(item, fieldPatch).then((verdict) => {
      if (verdict === "cancel") return setCells(server);
      // Accepting the delivery finished the ticket; the board refetches on its own.
      if (verdict === "accepted") return commitOrder();
      patch.mutate(
        { id: item.id, patch: fieldPatch, baseVersion: item.version },
        {
          onError: (err) => {
            setCells(server);
            if (err instanceof Error && /conflict/i.test(err.message)) onConflict(item.title);
            else toast(errorSpec(err));
          },
          onSuccess: (written) => (
            commitOrder(),
            toast({
              body: (
                <>
                  {tx("board.movedToast", {
                    key: <span className="num">{item.key}</span>,
                    column: to.col !== from.col ? groupLabel(cb, to.col) : groupLabel(groupBy ?? cb, to.lane)
                  })}
                </>
              ),
              onUndo: () => undoWrite({ id: item.id, stamp: written.version })
            })
          )
        }
      );
    });
  };

  /** The keyboard equivalent of a drag: one column left or right in the same lane, same write path. */
  const nudge = (item: Item, direction: -1 | 1) => {
    const lane = groupBy ? groupKeyOf(item, groupBy) : "";
    const from = columnKeys.indexOf(groupKeyOf(item, cb));
    const to = from + direction;
    if (from < 0) return;
    if (to < 0 || to >= columnKeys.length) {
      toast({ body: <>{tx(direction < 0 ? "board.alreadyFirst" : "board.alreadyLast", { key: <span className="num">{item.key}</span> })}</> });
      return;
    }
    write(item, cellKey(lane, columnKeys[from]), cellKey(lane, columnKeys[to]), null);
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
  }, [cells]);

  const isShut = (lane: string, n: number) => (n === 0 ? !toggled.has(`!${lane}`) : toggled.has(lane));
  const toggleLane = (lane: string, n: number) =>
    setToggled((current) => {
      const next = new Set(current);
      const key = n === 0 ? `!${lane}` : lane;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const seedFor = (lane: string, col: string): Patch | null => {
    const colPatch = patchFor(cb, col);
    if (!colPatch) return null;
    if (!groupBy) return colPatch;
    const lanePatch = patchFor(groupBy, lane);
    return lanePatch ? mergePatch(colPatch, lanePatch) : null;
  };

  const renderColumn = (lane: string, col: string, i: number, withHead: boolean) => {
    const cell = cellKey(lane, col);
    return (
      <Column
        key={cell}
        cell={cell}
        index={i}
        label={groupLabel(cb, col)}
        cards={cells[cell] ?? []}
        head={withHead ? { count: columnCount(col), cap: query.wip[col] } : null}
        seed={seedFor(lane, col)}
        more={withHead ? closedColumn(col) : null}
        onOpen={(item) => select(item.id)}
        onNudge={nudge}
      />
    );
  };

  return (
    <DragDropProvider
      onDragStart={(event) => {
        const id = event.operation.source?.id;
        if (id == null) return;
        const item = visible.find((i) => i.id === String(id));
        const cell = Object.keys(cellsRef.current).find((key) => cellsRef.current[key].some((c) => c.id === String(id)));
        dragging.current = true;
        origin.current = item && cell ? { cell, item } : null;
      }}
      onDragOver={(event) => setCells((current) => move(current, event))}
      onDragEnd={(event) => {
        dragging.current = false;
        const start = origin.current;
        origin.current = null;
        if (event.canceled || !start) return setCells(server);
        const target = Object.keys(cellsRef.current).find((key) => cellsRef.current[key].some((c) => c.id === start.item.id));
        if (!target) return setCells(server);
        const arr = cellsRef.current[target];
        const pos = arr.findIndex((c) => c.id === start.item.id);
        const before = arr[pos - 1] ? effectiveRank(arr[pos - 1], ranks) : undefined;
        const after = arr[pos + 1] ? effectiveRank(arr[pos + 1], ranks) : undefined;
        write(start.item, start.cell, target, { rank: rankBetween(before, after) });
      }}
    >
      {closedElsewhere && (
        <div className="board-more">
          <LoadMore statuses={[...CLOSED_STATUSES]} text={(n) => t("board.hiddenClosed", { n })} />
        </div>
      )}
      <div className="board-scroll-area" data-has-more={hasMoreColumns}>
        {groupBy ? (
          <div className="lanes" data-group-by={groupBy} ref={scrollRef}>
            <div className="lane-cols lane-cols-head" role="row">
              {columnKeys.map((col, i) => (
                <div className="col" key={col} data-column={col}>
                  <ColumnHead index={i} label={groupLabel(cb, col)} count={columnCount(col)} cap={query.wip[col]} />
                </div>
              ))}
            </div>
            {lanes.map((lane) => {
              const n = laneCount(lane);
              const shut = isShut(lane, n);
              return (
                <section className={`lane${shut ? " collapsed" : ""}`} key={lane || EMPTY_KEY} data-lane={lane || EMPTY_KEY} aria-label={t("board.laneAria", { label: groupLabel(groupBy, lane), n })}>
                  {groupBy === "epic" ? (
                    <EpicLaneHead epic={epicById.get(lane)} label={groupLabel(groupBy, lane)} count={n} progress={progress?.get(lane)} collapsed={shut} onToggle={() => toggleLane(lane, n)} onOpen={select} />
                  ) : (
                    <button type="button" className="lane-head" aria-expanded={!shut} title={t(shut ? "board.expandLane" : "board.collapseLane")} onClick={() => toggleLane(lane, n)}>
                      <Icon className="lane-chev" name="i-chev" size={12} />
                      <span className="lane-name">{groupLabel(groupBy, lane)}</span>
                      <span className="lane-count num">{n}</span>
                    </button>
                  )}
                  {!shut && <div className="lane-cols">{columnKeys.map((col, i) => renderColumn(lane, col, i, false))}</div>}
                </section>
              );
            })}
            {columnKeys.some((col) => closedColumn(col)) && (
              <div className="lane-cols lane-cols-foot" role="row">
                {columnKeys.map((col) => {
                  const status = closedColumn(col);
                  return (
                    <div className="col" key={col} data-column={col}>
                      {status && <LoadMore statuses={[status]} text={(n) => t("board.hiddenMore", { n })} />}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="col-track" ref={scrollRef}>{columnKeys.map((col, i) => renderColumn("", col, i, true))}</div>
        )}
        {hasMoreColumns && (
          <>
            <div className="board-scroll-fade" aria-hidden="true" />
            <button type="button" className="board-scroll-hint" onClick={scrollRight}>
              {t("board.scrollRight")} <span aria-hidden="true">→</span>
            </button>
          </>
        )}
      </div>
    </DragDropProvider>
  );
}
