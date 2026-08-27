import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Badge } from "@tomrade/contributions";
import type { Board, Item, Project, View } from "@tomrade/domain";
import {
  columnKeyOf,
  filterCount,
  isDirty,
  isTicket,
  itemsFor,
  queryFromView,
  type BoardQuery
} from "~/lib/domain";
import { useBadges, useBoards, useItems, useLabels, useProjects, useViewRanks, useViews } from "~/lib/queries";

export interface WorkspaceValue {
  project: Project;
  projects: Project[];
  boards: Board[];
  views: View[];
  items: Item[];
  labels: string[];
  board: Board;
  view: View;
  /** Views saved on the active board, in roster order. */
  boardViews: View[];
  /** Epics are items; the epic grouping's column space is their ids. */
  epics: Item[];
  epicNames: Map<string, string>;
  /** The live query — the render source of truth, a clone of the saved view. */
  query: BoardQuery;
  setQuery: (next: BoardQuery) => void;
  savedQuery: BoardQuery;
  dirty: boolean;
  filterCount: number;
  /** Issues on this board that pass the query and land in a shown column. */
  visible: Item[];
  /** Every issue the board owns, filter ignored. */
  owned: Item[];
  ranks: Record<string, number>;
  /** Plugin badges per item id, computed in the main process. */
  badges: Record<string, Badge[]>;
  selectedId: string | null;
  select: (id: string | null) => void;
  openSpace: (boardId: string, viewId?: string) => void;
}

const Ctx = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useWorkspace outside a WorkspaceProvider");
  return value;
}

export function WorkspaceProvider({
  projectId,
  boardId,
  viewId,
  children
}: {
  projectId: string;
  boardId: string;
  viewId: string;
  children: (value: WorkspaceValue) => ReactNode;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const boards = useBoards(projectId);
  const views = useViews(projectId);
  const items = useItems(projectId);
  const labels = useLabels(projectId);
  const ranks = useViewRanks(viewId);
  const badges = useBadges(projectId);
  const [selectedId, select] = useState<string | null>(null);

  const project = projects.data?.find((p) => p.id === projectId);
  const board = boards.data?.find((b) => b.id === boardId);
  const view = views.data?.find((v) => v.id === viewId);

  const epics = useMemo(() => (items.data ?? []).filter((i) => i.kind === "epic"), [items.data]);
  const epicColumns = useMemo(() => [...epics.map((e) => e.id), "none"], [epics]);

  const savedQuery = useMemo(() => (view ? queryFromView(view, epicColumns) : null), [view, epicColumns]);
  const [query, setQuery] = useState<BoardQuery | null>(savedQuery);

  // Switching board or view rebinds the live query to whatever was saved.
  useEffect(() => {
    setQuery(savedQuery);
    select(null);
  }, [viewId, boardId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!query && savedQuery) setQuery(savedQuery);
  }, [query, savedQuery]);

  // Epic columns are epic ids, so creating or deleting an epic changes the key
  // space a live epic-grouped query is written against.
  const epicKey = epicColumns.join();
  useEffect(() => {
    setQuery((current) => {
      if (!current || current.group !== "epic") return current;
      const known = new Set(epicColumns);
      const kept = current.columns.filter((c) => known.has(c));
      const added = epicColumns.filter((c) => !current.columns.includes(c));
      return kept.length === current.columns.length && !added.length ? current : { ...current, columns: [...kept, ...added] };
    });
  }, [epicKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const settled = !projects.isLoading && !boards.isLoading && !views.isLoading;

  const openSpace = useCallback(
    (nextBoardId: string, nextViewId?: string) => {
      const target = nextViewId ?? (views.data ?? []).filter((v) => v.boardId === nextBoardId).sort((a, b) => a.rank - b.rank)[0]?.id;
      if (!target) return;
      void navigate({ to: "/p/$projectId/b/$boardId/v/$viewId", params: { projectId, boardId: nextBoardId, viewId: target } });
    },
    [navigate, projectId, views.data]
  );

  const value = useMemo<WorkspaceValue | null>(() => {
    if (!project || !board || !view || !savedQuery || !query) return null;
    const all = items.data ?? [];
    const owned = all.filter((i) => isTicket(i) && (board.across || i.boardId === board.id));
    const rankMap = ranks.data ?? {};
    return {
      project,
      projects: projects.data ?? [],
      boards: boards.data ?? [],
      views: views.data ?? [],
      items: all,
      labels: labels.data ?? [],
      board,
      view,
      boardViews: (views.data ?? []).filter((v) => v.boardId === board.id).sort((a, b) => a.rank - b.rank),
      epics,
      epicNames: new Map(epics.map((e) => [e.id, e.title])),
      query,
      setQuery: (next: BoardQuery) => setQuery(next),
      savedQuery,
      dirty: isDirty(query, savedQuery),
      filterCount: filterCount(query),
      visible: itemsFor(all, board, query, rankMap),
      owned,
      ranks: rankMap,
      badges: badges.data ?? {},
      selectedId,
      select,
      openSpace
    };
  }, [project, projects.data, board, boards.data, view, views.data, items.data, labels.data, epics, savedQuery, query, ranks.data, badges.data, selectedId, openSpace]);

  // Deleting the open board or view strands this route; the project loader knows
  // how to pick a surviving one. Deleting the project strands that loader too,
  // and then only home is left.
  useEffect(() => {
    if (!settled) return;
    if (!project) void navigate({ to: "/", replace: true });
    else if (!board || !view) void navigate({ to: "/p/$projectId", params: { projectId }, replace: true });
  }, [settled, project, board, view, navigate, projectId]);

  if (!value) {
    const gone = settled && !project;
    const missing = settled && (!board || !view);
    return (
      <div className="app">
        <header className="titlebar" />
        <main className="sheet">
          <div className="wrap">
            <p className="meta-txt">
              {gone ? "That project has been deleted." : missing ? "That board is no longer in this project." : "Opening the workspace…"}
            </p>
          </div>
        </main>
        <footer className="statusbar" />
      </div>
    );
  }
  return <Ctx.Provider value={value}>{children(value)}</Ctx.Provider>;
}

/** How many issues a board holds, ignoring every filter. */
export const boardCount = (items: Item[], board: Board) => items.filter((i) => isTicket(i) && (board.across || i.boardId === board.id)).length;

/** How many issues a saved view resolves to on its board. */
export function viewCount(items: Item[], board: Board, view: View, epicColumns: string[]): number {
  return itemsFor(items, board, queryFromView(view, epicColumns)).length;
}

export { columnKeyOf };
