import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Badge } from "@tomrade/contributions";
import {
  BUILTIN_FIELDS,
  CHECKED,
  EMPTY_KEY,
  compareItems,
  groupSpaceOf,
  matchesFilter,
  normalizeQuery,
  patchForGroup,
  type Board,
  type FieldDef,
  type Item,
  type Layout,
  type Patch,
  type Project,
  type QueryContext,
  type View,
  type ViewQuery
} from "@tomrade/domain";
import { PRIORITY_LABEL, PROVENANCE, STATUS, STATUS_KEYS, checkedLabel, emptyGroupLabel, isTicket } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useBadges, useBoards, useCreateView, useFields, useItems, useLabels, useProjects, useUpdateView, useViewRanks, useViews } from "~/lib/queries";
import { useToast } from "~/lib/toast";

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
  /** A workstream is a place too: its page is an unsaved board pinned to it. */
  openWorkstream: (boardId: string) => void;
  /** True on a workstream page — `view` is then synthesized, not saved, and saving means "save as a view". */
  virtual: boolean;
  /** The workstream whose page this is, when `virtual`. */
  workstream: Board | null;
  /** On the Files screen: the open path, "" for the root. Null anywhere else. */
  filePath: string | null;
  openFile: (path: string) => void;

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

/** Tickets a saved view resolves to, ignoring column visibility — the count beside its name. */
export const viewCount = (items: Item[], view: View): number => items.filter((i) => isTicket(i) && matchesFilter(i, view.query.filter)).length;

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
  children
}: {
  projectId: string;
  /** One of the three names the place: a saved view, a workstream, or a path in the project's files. */
  viewId?: string;
  boardId?: string;
  filePath?: string;
  children: (value: WorkspaceValue) => ReactNode;
}) {
  const navigate = useNavigate();
  const { t, locale } = useI18n();
  const toast = useToast();
  const projects = useProjects();
  const boards = useBoards(projectId);
  const views = useViews(projectId);
  const items = useItems(projectId);
  const labels = useLabels(projectId);
  const fieldsQuery = useFields(projectId);
  // A workstream page keeps no manual order of its own.
  const ranks = useViewRanks(projectId, viewId);
  const badges = useBadges(projectId);
  const updateView = useUpdateView(projectId);
  const createView = useCreateView(projectId);
  const [selectedId, select] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const project = projects.data?.find((p) => p.id === projectId);
  const workstream = boardId ? (boards.data?.find((b) => b.id === boardId) ?? null) : null;
  const virtual = !!boardId;
  const inFiles = filePath !== undefined;
  // The Files screen shows no view, but the sidebar still counts them; it borrows the first.
  const savedView = views.data?.find((v) => v.id === viewId) ?? (inFiles ? [...(views.data ?? [])].sort((a, b) => a.rank - b.rank)[0] : undefined);
  const view = useMemo(() => (virtual ? (workstream ? workstreamView(workstream) : undefined) : savedView), [virtual, workstream, savedView]);
  const placeKey = inFiles ? "files" : (viewId ?? `ws:${boardId}`);

  const saved = useMemo(() => (view ? draftOf(view) : null), [view]);
  const savedCanon = saved ? canon(saved) : null;

  // Switching views, or the saved layout/query changing underneath (a save,
  // an undo, another window), rebinds the draft to what is saved. A rename
  // changes neither, so it never costs an unsaved filter.
  const lastView = useRef<string | null>(null);
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    const switched = lastView.current !== placeKey;
    const changed = lastSaved.current !== savedCanon;
    lastView.current = placeKey;
    lastSaved.current = savedCanon;
    if (switched) {
      setDraft(null);
      select(null);
    } else if (changed) setDraft(null);
  }, [placeKey, savedCanon]);
  const live = draft ?? saved;
  const dirty = !!saved && !!draft && canon(draft) !== canon(saved);

  const all = items.data ?? [];
  const fields = fieldsQuery.data ?? (BUILTIN_FIELDS as FieldDef[]);
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const epics = useMemo(() => all.filter((i) => i.kind === "epic"), [all]);
  const epicNames = useMemo(() => new Map(epics.map((e) => [e.id, e.title])), [epics]);
  const boardList = boards.data ?? [];
  const labelList = labels.data ?? [];

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
    [fieldById, epics, boardList, labelList, locale]
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

  const settled = !projects.isLoading && !views.isLoading && !boards.isLoading;

  const openView = useCallback(
    (nextViewId: string) => void navigate({ to: "/p/$projectId/v/$viewId", params: { projectId, viewId: nextViewId } }),
    [navigate, projectId]
  );
  const openWorkstream = useCallback(
    (nextBoardId: string) => void navigate({ to: "/p/$projectId/w/$boardId", params: { projectId, boardId: nextBoardId } }),
    [navigate, projectId]
  );
  const openFile = useCallback((path: string) => void navigate({ to: "/p/$projectId/f/$", params: { projectId, _splat: path } }), [navigate, projectId]);

  const value = useMemo<WorkspaceValue | null>(() => {
    if (!project || !view || !saved || !live) return null;
    const rankMap = ranks.data ?? {};
    const rankOf = (i: Item) => rankMap[i.id] ?? i.rank;
    const owned = all.filter(isTicket);
    const visible = owned.filter((i) => matchesFilter(i, live.query.filter)).sort((a, b) => compareItems(a, b, live.query.sortBy, queryCtx, rankOf));
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
          onError: (err) => toast({ body: err.message })
        }
      );
    return {
      project,
      projects: projects.data ?? [],
      views: views.data ?? [],
      view,
      boards: boardList,
      fields,
      fieldById,
      items: all,
      owned,
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
        updateView.mutate({ id: view.id, patch: { layout: live.layout, query: live.query } }, { onSuccess: () => setDraft(null), onError: (err) => toast({ body: err.message }) });
      },
      discardChanges: () => setDraft(null),
      saveAsNewView,
      openWorkstream,
      virtual,
      workstream,
      filePath: inFiles ? filePath : null,
      openFile,
      filterCount: live.query.filter.length,
      visible,
      ranks: rankMap,
      badges: badges.data ?? {},
      selectedId,
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
    boardList,
    fields,
    fieldById,
    all,
    epics,
    epicNames,
    labelList,
    ranks.data,
    badges.data,
    selectedId,
    openView,
    openWorkstream,
    openFile,
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
    toast
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
          <div className="wrap">
            <p className="meta-txt">{gone ? t("workspaceContext.projectDeleted") : missing ? t("workspaceContext.viewGone") : t("workspaceContext.opening")}</p>
          </div>
        </main>
        <footer className="statusbar" />
      </div>
    );
  }
  return <Ctx.Provider value={value}>{children(value)}</Ctx.Provider>;
}
