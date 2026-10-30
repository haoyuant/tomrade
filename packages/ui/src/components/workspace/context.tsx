import { createContext, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Badge } from "@tomradex/contributions";
import {
  BUILTIN_FIELDS,
  CHECKED,
  EMPTY_KEY,
  compareItems,
  groupSpaceOf,
  matchesFilter,
  matchesSearch,
  normalizeQuery,
  patchForGroup,
  searchTerms,
  type Board,
  type ClosedStatus,
  type FieldDef,
  type Item,
  type Layout,
  type Patch,
  type Project,
  type QueryContext,
  type View,
  type ViewQuery
} from "@tomradex/domain";
import { PRIORITY_LABEL, PROVENANCE, STATUS, STATUS_KEYS, checkedLabel, emptyGroupLabel, isTicket } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { hiddenCount, mergeById, pageSize } from "~/lib/closedWindow";
import {
  useBadges,
  useBoards,
  useClosedFound,
  useClosedPages,
  useClosedTotals,
  useClosedWindow,
  useCreateView,
  useEpicProgress,
  useFields,
  useItems,
  useLabels,
  useProjects,
  useUpdateView,
  useTicketCounts,
  useViewRanks,
  useViews
} from "~/lib/queries";
import { errorSpec, readableError, useToast } from "~/lib/toast";

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
  /** Why the project's issues could not be read, so a failure never passes for an empty backlog. */
  itemsError: string | null;
  retryItems: () => void;
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
  /** The project's items the renderer holds, epics included: every open one, and the done and cancelled ones the window, a "load more" or the search brought in. */
  items: Item[];
  /** Those of `items` that are tickets, filter ignored. */
  owned: Item[];
  /** Each epic's progress over all its tickets, counted where they all are. */
  epicProgress: Map<string, { done: number; total: number }>;
  /** How many tickets each saved view holds, by view id. */
  viewCounts: Record<string, number>;
  /** How many tickets each workstream holds, by board id. */
  workstreamCounts: Record<string, number>;
  /** How many tickets the project holds; absent until counted. */
  ticketTotal: number | undefined;
  /** The done and cancelled tickets of this view the renderer does not hold yet. */
  closed: ClosedView;
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

  /** The ticket search as applied — it trails the field while typing. Narrows `visible` in every view and layout; never saved with a view. */
  search: string;
  /** Tickets the search matches that this view's filter hides, so an empty result can say where they are. */
  searchElsewhere: number;
  /** Tickets passing the filter and the search, in sort order (sortBy, else manual rank, then recency). Column visibility is not applied. */
  visible: Item[];
  ranks: Record<string, number>;
  /** Plugin badges per item id, computed in the main process. */
  badges: Record<string, Badge[]>;

  /** Opens a ticket in the detail pane; which one is open is read with useSelectedId or useIsSelected. */
  select: (id: string | null) => void;
  openView: (viewId: string) => void;
  /** A workstream is a place too: its page is an unsaved board pinned to it. */
  openWorkstream: (boardId: string) => void;
  /** True on a workstream page — `view` is then synthesized, not saved, and saving means "save as a view". */
  virtual: boolean;
  /** The workstream whose page this is, when `virtual`. */
  workstream: Board | null;
  /** On the Files screen: the open path, "" for the root. Null anywhere else. */
  filePath: string | null;
  openFile: (path: string) => void;
  /** On the Routines screen. */
  routines: boolean;
  openRoutines: () => void;

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

/** A view's done and cancelled columns: their true size, how much of it is held, and the way to more. */
export interface ClosedView {
  /** Under the filter and the search; absent until counted. */
  totals: Partial<Record<ClosedStatus, number>>;
  /** How many of each `visible` holds. */
  hidden: (status: ClosedStatus) => number;
  /** Asks for the next page of each status named. */
  loadMore: (statuses: ClosedStatus[]) => void;
  loading: (status: ClosedStatus) => boolean;
}

const Ctx = createContext<WorkspaceValue | null>(null);

/**
 * The open ticket, kept out of the workspace value: opening one re-renders the
 * detail and the two cards whose highlight changes, not the whole board.
 */
function createSelection() {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (id: string | null) => {
      if (id === current) return;
      current = id;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    }
  };
}
type Selection = ReturnType<typeof createSelection>;

const SelectionCtx = createContext<Selection | null>(null);

const useSelection = (): Selection => {
  const selection = useContext(SelectionCtx);
  if (!selection) throw new Error("useSelectedId outside WorkspaceProvider");
  return selection;
};

export function useSelectedId(): string | null {
  const selection = useSelection();
  return useSyncExternalStore(selection.subscribe, selection.get);
}

/** Reads the open ticket when asked, without re-rendering when it changes. */
export function useReadSelectedId(): () => string | null {
  return useSelection().get;
}

/** Re-renders only when this ticket gains or loses the selection. */
export function useIsSelected(id: string): boolean {
  const selection = useSelection();
  return useSyncExternalStore(selection.subscribe, () => selection.get() === id);
}

/** The ticket search, one per project: switching views or workstreams keeps it, since it narrows whichever is open. */
const searches = new Map<string, string>();
const searchListeners = new Set<() => void>();
export const ticketSearch = {
  get: (projectId: string) => searches.get(projectId) ?? "",
  set: (projectId: string, text: string) => {
    if (text === ticketSearch.get(projectId)) return;
    searches.set(projectId, text);
    for (const listener of searchListeners) listener();
  }
};

export function useTicketSearch(projectId: string): string {
  return useSyncExternalStore(
    (listener) => {
      searchListeners.add(listener);
      return () => void searchListeners.delete(listener);
    },
    () => ticketSearch.get(projectId)
  );
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useWorkspace outside a WorkspaceProvider");
  return value;
}

interface Draft {
  layout: Layout;
  query: ViewQuery;
}

/** JSON with sorted keys, so two equal drafts compare equal whatever order their keys were written in. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const draftOf = (view: View): Draft => ({ layout: view.layout, query: normalizeQuery(view.query) });

/** The board view a workstream page shows: everything in that workstream, by status. */
function workstreamView(board: Board): View {
  return {
    id: `ws:${board.id}`,
    projectId: board.projectId,
    name: board.name,
    icon: board.icon,
    layout: "board",
    query: normalizeQuery({ filter: [{ field: "board", op: "in", values: [board.id] }], columnBy: "status" }),
    rank: -1,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt
  };
}

export function WorkspaceProvider({
  projectId,
  viewId,
  boardId,
  filePath,
  routines = false,
  children
}: {
  projectId: string;
  /** One of the three names the place: a saved view, a workstream, or a path in the project's files. */
  viewId?: string;
  boardId?: string;
  filePath?: string;
  /** The Routines screen, which names no view either. */
  routines?: boolean;
  children: (value: WorkspaceValue) => ReactNode;
}) {
  const navigate = useNavigate();
  const { t, locale } = useI18n();
  const toast = useToast();
  const projects = useProjects();
  const boards = useBoards(projectId);
  const views = useViews(projectId);
  const items = useItems(projectId);
  const closedWindow = useClosedWindow(projectId);
  const epicProgress = useEpicProgress(projectId);
  const labels = useLabels(projectId);
  const fieldsQuery = useFields(projectId);
  // A workstream page keeps no manual order of its own.
  const ranks = useViewRanks(projectId, viewId);
  const badges = useBadges(projectId);
  const updateView = useUpdateView(projectId);
  const createView = useCreateView(projectId);
  const [selection] = useState(createSelection);
  const select = selection.set;
  const [draft, setDraft] = useState<Draft | null>(null);
  // Typing re-renders the field at once and the layouts when React has a moment.
  const search = useDeferredValue(useTicketSearch(projectId));

  const project = projects.data?.find((p) => p.id === projectId);
  const workstream = boardId ? (boards.data?.find((b) => b.id === boardId) ?? null) : null;
  const virtual = !!boardId;
  const inFiles = filePath !== undefined;
  // Files and Routines show no view, but the sidebar still counts them; they borrow the first.
  const savedView = views.data?.find((v) => v.id === viewId) ?? (inFiles || routines ? [...(views.data ?? [])].sort((a, b) => a.rank - b.rank)[0] : undefined);
  const view = useMemo(() => (virtual ? (workstream ? workstreamView(workstream) : undefined) : savedView), [virtual, workstream, savedView]);
  const placeKey = inFiles ? "files" : routines ? "routines" : (viewId ?? `ws:${boardId}`);

  const saved = useMemo(() => (view ? draftOf(view) : null), [view]);
  const savedCanon = saved ? canon(saved) : null;

  // Switching views, or the saved layout/query changing underneath (a save,
  // an undo, another window), rebinds the draft to what is saved. A rename
  // changes neither, so it never costs an unsaved filter.
  const lastView = useRef<string | null>(null);
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    const arriving = lastView.current === null;
    const switched = lastView.current !== placeKey;
    const changed = lastSaved.current !== savedCanon;
    lastView.current = placeKey;
    lastSaved.current = savedCanon;
    if (switched) {
      setDraft(null);
      // Arriving there is nothing to clear, and the screen may already have opened a ticket.
      if (!arriving) select(null);
    } else if (changed) setDraft(null);
  }, [placeKey, savedCanon, select]);
  const live = draft ?? saved;
  const dirty = !!saved && !!draft && canon(draft) !== canon(saved);

  // "Load more" lasts while the view, its filter and the search stay what they were.
  const filter = live?.query.filter;
  const moreKey = `${placeKey}\u0000${canon(filter ?? [])}\u0000${search}`;
  const [more, setMore] = useState<{ key: string; limits: Partial<Record<ClosedStatus, number>> }>({ key: "", limits: {} });
  const limits = useMemo(() => (more.key === moreKey ? more.limits : {}), [more, moreKey]);
  const stableFilter = useMemo(() => filter ?? [], [filter]);
  const pages = useClosedPages(projectId, stableFilter, search, limits);
  const found = useClosedFound(projectId, search);
  const closedTotals = useClosedTotals(projectId, stableFilter, search);
  // The window holds only part of the project, so every count beside a name is asked of the main process.
  const countSpecs = useMemo(
    () => [
      { id: "*", filter: [] },
      ...(views.data ?? []).map((v) => ({ id: `v:${v.id}`, filter: v.query.filter })),
      ...(boards.data ?? []).map((b) => ({ id: `w:${b.id}`, filter: [{ field: "board", op: "in" as const, values: [b.id] }] }))
    ],
    [views.data, boards.data]
  );
  const counts = useTicketCounts(projectId, countSpecs);
  const [viewCounts, workstreamCounts] = useMemo(() => {
    const pick = (prefix: string) => Object.fromEntries(Object.entries(counts).flatMap(([id, n]) => (id.startsWith(prefix) ? [[id.slice(prefix.length), n]] : [])));
    return [pick("v:"), pick("w:")];
  }, [counts]);
  const [donePage, cancelledPage] = [pages[0]?.data, pages[1]?.data];
  const all = useMemo(() => mergeById([items.data, donePage, cancelledPage, found.data]), [items.data, donePage, cancelledPage, found.data]);
  const progressMap = useMemo(() => new Map(Object.entries(epicProgress.data ?? {})), [epicProgress.data]);
  const [doneLoading, cancelledLoading] = [!!pages[0]?.isFetching, !!pages[1]?.isFetching];
  const fields = fieldsQuery.data ?? (BUILTIN_FIELDS as FieldDef[]);
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const epics = useMemo(() => all.filter((i) => i.kind === "epic"), [all]);
  const epicNames = useMemo(() => new Map(epics.map((e) => [e.id, e.title])), [epics]);
  const boardList = useMemo(() => boards.data ?? [], [boards.data]);
  const labelList = useMemo(() => labels.data ?? [], [labels.data]);

  // `locale` is a dependency on purpose: the tables below are localized in place.
  const optionsOf = useCallback(
    (fieldId: string): FieldOptionView[] => {
      void locale;
      const def = fieldById.get(fieldId);
      if (!def) return [];
      switch (fieldId) {
        case "status":
          return STATUS_KEYS.map((s) => ({ key: s, name: STATUS[s].label }));
        case "workType":
          return [{ key: "coding", name: t("fields.coding") }, { key: "general", name: t("fields.general") }];
        case "priority":
          return ["4", "3", "2", "1", "0"].map((p) => ({ key: p, name: PRIORITY_LABEL[Number(p)] }));
        case "provenance":
          return (["human", "ai", "sync", "locked"] as const).map((p) => ({ key: p, name: PROVENANCE[p] }));
        case "epic":
          return epics.map((e) => ({ key: e.id, name: e.title }));
        case "board":
          return boardList.map((b) => ({ key: b.id, name: b.name, icon: b.icon }));
        case "labels":
          return labelList.map((l) => ({ key: l, name: l }));
        default:
          if (def.type === "checkbox") return [{ key: String(CHECKED), name: checkedLabel() }];
          return def.options.map((o) => ({ key: o.id, name: o.name, description: o.description }));
      }
    },
    [fieldById, epics, boardList, labelList, locale, t]
  );

  const groupSpace = useCallback(
    (fieldId: string): string[] => {
      const def = fieldById.get(fieldId);
      return def ? groupSpaceOf(def, optionsOf(fieldId).map((o) => ({ id: o.key }))) : [];
    },
    [fieldById, optionsOf]
  );

  const groupLabel = useCallback(
    (fieldId: string, key: string): string => {
      const def = fieldById.get(fieldId);
      if (!def) return key;
      if (key === EMPTY_KEY) return emptyGroupLabel(def);
      return optionsOf(fieldId).find((o) => o.key === key)?.name ?? key;
    },
    [fieldById, optionsOf]
  );

  const queryCtx = useMemo<QueryContext>(
    () => ({
      defs: fieldById,
      optionRank: (fieldId, key) => optionsOf(fieldId).findIndex((o) => o.key === key),
      optionName: (fieldId, key) => optionsOf(fieldId).find((o) => o.key === key)?.name ?? ""
    }),
    [fieldById, optionsOf]
  );

  // A read that failed says nothing about whether the project or the view is still there.
  const failed = [projects, views, boards].filter((q) => q.isError);
  const settled = !failed.length && !projects.isLoading && !views.isLoading && !boards.isLoading;

  const openView = useCallback(
    (nextViewId: string) => void navigate({ to: "/p/$projectId/v/$viewId", params: { projectId, viewId: nextViewId } }),
    [navigate, projectId]
  );
  const openWorkstream = useCallback(
    (nextBoardId: string) => void navigate({ to: "/p/$projectId/w/$boardId", params: { projectId, boardId: nextBoardId } }),
    [navigate, projectId]
  );
  const openFile = useCallback((path: string) => void navigate({ to: "/p/$projectId/f/$", params: { projectId, _splat: path } }), [navigate, projectId]);
  const openRoutines = useCallback(() => void navigate({ to: "/p/$projectId/r", params: { projectId } }), [navigate, projectId]);

  const refetchItems = items.refetch;
  const value = useMemo<WorkspaceValue | null>(() => {
    if (!project || !view || !saved || !live) return null;
    const rankMap = ranks.data ?? {};
    const rankOf = (i: Item) => rankMap[i.id] ?? i.rank;
    const owned = all.filter(isTicket);
    const terms = searchTerms(search);
    const matched = terms.length ? owned.filter((i) => matchesSearch(i, terms)) : owned;
    const visible = matched.filter((i) => matchesFilter(i, live.query.filter)).sort((a, b) => compareItems(a, b, live.query.sortBy, queryCtx, rankOf));
    const shown = (status: ClosedStatus) => visible.reduce((n, i) => n + (i.status === status ? 1 : 0), 0);
    const closed: ClosedView = {
      totals: closedTotals,
      hidden: (status) => hiddenCount(closedTotals[status], shown(status)),
      loadMore: (statuses) => {
        const next = { ...limits };
        for (const status of statuses) next[status] = shown(status) + pageSize(closedWindow);
        setMore({ key: moreKey, limits: next });
      },
      loading: (status) => (status === "done" ? doneLoading : cancelledLoading)
    };
    const columnBy = live.query.columnBy ?? "status";
    const space = groupSpace(columnBy);
    const chosen = live.query.columns.filter((k) => space.includes(k));
    const setQuery = (next: ViewQuery) => setDraft({ layout: live.layout, query: normalizeQuery(next) });
    const setLayout = (next: Layout) => setDraft({ layout: next, query: live.query });
    const saveAsNewView = (name: string) =>
      createView.mutate(
        { name, icon: view.icon, layout: live.layout, query: live.query },
        {
          onSuccess: (created) => {
            setDraft(null);
            openView(created.id);
          },
          onError: (err) => toast(errorSpec(err))
        }
      );
    return {
      itemsError: items.isError ? readableError(items.error) : null,
      retryItems: () => void refetchItems(),
      project,
      projects: projects.data ?? [],
      views: views.data ?? [],
      view,
      boards: boardList,
      fields,
      fieldById,
      items: all,
      owned,
      epicProgress: progressMap,
      viewCounts,
      workstreamCounts,
      ticketTotal: counts["*"],
      closed,
      epics,
      epicNames,
      labels: labelList,
      query: live.query,
      setQuery,
      layout: live.layout,
      setLayout,
      dirty,
      saveView: () => {
        if (!dirty) return;
        // A workstream page has nothing saved to write back to; saving it makes a view.
        if (virtual) return saveAsNewView(view.name);
        updateView.mutate({ id: view.id, patch: { layout: live.layout, query: live.query } }, { onSuccess: () => setDraft(null), onError: (err) => toast(errorSpec(err)) });
      },
      discardChanges: () => setDraft(null),
      saveAsNewView,
      openWorkstream,
      virtual,
      workstream,
      filePath: inFiles ? filePath : null,
      openFile,
      routines,
      openRoutines,
      filterCount: live.query.filter.length,
      search,
      searchElsewhere: terms.length ? matched.length - visible.length : 0,
      visible,
      ranks: rankMap,
      badges: badges.data ?? {},
      select,
      openView,
      optionsOf,
      groupSpace,
      groupLabel,
      columnKeys: chosen.length ? chosen : space,
      patchFor: (fieldId: string, key: string): Patch | null => patchForGroup(fieldId, key, fieldById.get(fieldId)),
      queryCtx
    };
  }, [
    project,
    projects.data,
    view,
    views.data,
    saved,
    live,
    dirty,
    search,
    boardList,
    fields,
    fieldById,
    all,
    epics,
    epicNames,
    progressMap,
    viewCounts,
    workstreamCounts,
    counts,
    closedTotals,
    closedWindow,
    limits,
    moreKey,
    doneLoading,
    cancelledLoading,
    labelList,
    ranks.data,
    badges.data,
    select,
    openView,
    openWorkstream,
    openFile,
    routines,
    openRoutines,
    virtual,
    workstream,
    inFiles,
    filePath,
    optionsOf,
    groupSpace,
    groupLabel,
    queryCtx,
    updateView,
    createView,
    toast,
    items.isError,
    items.error,
    refetchItems
  ]);

  // Deleting the open view strands this route; the project loader knows how to
  // pick a surviving one. Deleting the project strands that loader too, and
  // then only home is left.
  useEffect(() => {
    if (!settled) return;
    if (!project) void navigate({ to: "/", replace: true });
    else if (!view) void navigate({ to: "/p/$projectId", params: { projectId }, replace: true });
  }, [settled, project, view, navigate, projectId]);

  if (!value) {
    const gone = settled && !project;
    const missing = settled && !view;
    return (
      <div className="app">
        <header className="titlebar" />
        <main className="sheet">
          {failed.length ? (
            <div className="route-error" role="alert" data-testid="workspace-read-failed">
              <p className="meta-txt">{t("workspaceContext.readFailed")}</p>
              <code className="route-error-detail">{readableError(failed[0].error)}</code>
              <div className="row" style={{ gap: "var(--space-2)" }}>
                <button type="button" className="btn btn-primary" disabled={failed.some((q) => q.isFetching)} onClick={() => failed.forEach((q) => void q.refetch())}>
                  {t("common.tryAgain")}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => void navigate({ to: "/" })}>
                  {t("common.backToProjects")}
                </button>
              </div>
            </div>
          ) : (
            <div className="wrap">
              <p className="meta-txt">{gone ? t("workspaceContext.projectDeleted") : missing ? t("workspaceContext.viewGone") : t("workspaceContext.opening")}</p>
            </div>
          )}
        </main>
        <footer className="statusbar" />
      </div>
    );
  }
  return (
    <SelectionCtx.Provider value={selection}>
      <Ctx.Provider value={value}>{children(value)}</Ctx.Provider>
    </SelectionCtx.Provider>
  );
}
