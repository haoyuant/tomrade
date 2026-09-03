import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Badge } from "@tomrade/contributions";
import type { Board, FieldDef, Item, Layout, Patch, Project, QueryContext, View, ViewQuery } from "@tomrade/domain";
import { columnKeyOf, filterCount, filterFromQuery, isTicket, itemsFor, queryFromView, type BoardQuery } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useBadges, useBoards, useItems, useLabels, useProjects, useUpdateView, useViewRanks, useViews } from "~/lib/queries";

/** One option of a groupable / filterable field, in display terms. */
export interface FieldOptionView {
  key: string;
  name: string;
  description?: string | null;
  /** Sprite icon for boards (workstreams); other fields draw their own marks by id. */
  icon?: string;
}

/**
 * The contract between the workspace shell (provider, sidebar, query bar,
 * dialogs) and the layouts (Board, Table, Graph, Card). Layouts read the live
 * query and the field vocabulary from here and never touch the saved view or
 * the field registry directly.
 */
export interface WorkspaceValue {
  project: Project;
  projects: Project[];
  views: View[];
  /** The saved view the route names. */
  view: View;
  /** Workstreams — the built-in `board` field's options. */
  boards: Board[];
  /** Every field the project has, built-ins first, in rank order. */
  fields: FieldDef[];
  fieldById: Map<string, FieldDef>;
  /** Every item in the project, epics included. */
  items: Item[];
  /** Every ticket (epics excluded), filter ignored. */
  owned: Item[];
  epics: Item[];
  epicNames: Map<string, string>;
  labels: string[];

  /** The live draft — the render source of truth. Differs from `view` until saved. */
  query: ViewQuery;
  setQuery: (next: ViewQuery) => void;
  layout: Layout;
  setLayout: (next: Layout) => void;
  /** Whether the draft differs from the saved view. */
  dirty: boolean;
  saveView: () => void;
  discardChanges: () => void;
  saveAsNewView: (name: string) => void;
  filterCount: number;

  /** Tickets passing the filter, in sort order (sortBy, else manual rank, then recency). Column visibility is not applied. */
  visible: Item[];
  ranks: Record<string, number>;
  /** Plugin badges per item id, computed in the main process. */
  badges: Record<string, Badge[]>;

  selectedId: string | null;
  select: (id: string | null) => void;
  openView: (viewId: string) => void;

  /** A field's options in its display order: statuses, priorities urgent-first, epics, workstreams, custom options, the checkbox's one tick. Labels list the project's vocabulary. */
  optionsOf: (fieldId: string) => FieldOptionView[];
  /** Every key a group can take, empty key included where the field allows it. */
  groupSpace: (fieldId: string) => string[];
  /** Display name for a group key; the empty key reads "No <field>" (or "Unchecked"). */
  groupLabel: (fieldId: string, key: string) => string;
  /** Board layout: the columns actually shown — `query.columns` when set (unknown keys dropped), else the whole space. */
  columnKeys: string[];
  /** What a drop into `key` of `fieldId` writes; null when that field cannot be written that way. */
  patchFor: (fieldId: string, key: string) => Patch | null;
  /** For `compareItems`: option order and names resolved from the vocabulary above. */
  queryCtx: QueryContext;
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
  const { t } = useI18n();
  const projects = useProjects();
  const boards = useBoards(projectId);
  const views = useViews(projectId);
  const items = useItems(projectId);
  const labels = useLabels(projectId);
  const ranks = useViewRanks(viewId);
  const badges = useBadges(projectId);
  const updateView = useUpdateView(projectId);
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

  // A facet edit is a live, unsaved query until this settles it onto the view a
  // beat later — there is no separate "save this view" step to forget.
  const filterKey = query ? JSON.stringify(filterFromQuery(query)) : null;
  useEffect(() => {
    if (!view || !query) return;
    const nextFilter = filterFromQuery(query);
    if (JSON.stringify(nextFilter) === JSON.stringify(view.filter ?? {})) return;
    const timer = setTimeout(() => updateView.mutate({ id: view.id, patch: { filter: nextFilter } }), 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, view?.id]);

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
              {gone ? t("workspaceContext.projectDeleted") : missing ? t("workspaceContext.boardGone") : t("workspaceContext.opening")}
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
