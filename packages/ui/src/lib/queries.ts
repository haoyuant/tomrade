import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AppSettings,
  Board,
  CreatedBoard,
  BoardPatch,
  CreateBoardInput,
  CreateItemInput,
  CreateProjectInput,
  CreateViewInput,
  Item,
  Patch,
  Project,
  View,
  ViewPatch
} from "@tomrade/core";

const api = () => window.tomrade;

export const keys = {
  projects: ["projects"] as const,
  boards: (projectId: string) => ["boards", projectId] as const,
  views: (projectId: string) => ["views", projectId] as const,
  items: (projectId: string) => ["items", projectId] as const,
  labels: (projectId: string) => ["labels", projectId] as const,
  ranks: (viewId: string) => ["ranks", viewId] as const,
  history: (itemId: string) => ["history", itemId] as const,
  oplog: ["oplog"] as const,
  settings: ["settings"] as const,
  mcp: ["mcp"] as const,
  dbPath: ["dbPath"] as const
};

/** Everything a board write can invalidate, in one call. */
export function invalidateWorkspace(qc: QueryClient, projectId: string): void {
  void qc.invalidateQueries({ queryKey: keys.items(projectId) });
  void qc.invalidateQueries({ queryKey: keys.labels(projectId) });
  void qc.invalidateQueries({ queryKey: keys.oplog });
  void qc.invalidateQueries({ queryKey: ["history"] });
}

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => api().projectsList() });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => api().settingsGet() });
export const useMcpUrl = () => useQuery({ queryKey: keys.mcp, queryFn: () => api().mcpUrl() });
export const useDbPath = () => useQuery({ queryKey: keys.dbPath, queryFn: () => api().dbPath() });

export const useBoards = (projectId: string) =>
  useQuery({ queryKey: keys.boards(projectId), queryFn: () => api().boardsList(projectId) });

export const useViews = (projectId: string) =>
  useQuery({ queryKey: keys.views(projectId), queryFn: () => api().viewsList(projectId) });

export const useItems = (projectId: string) =>
  useQuery({ queryKey: keys.items(projectId), queryFn: () => api().list({ projectId }) });

export const useLabels = (projectId: string) =>
  useQuery({ queryKey: keys.labels(projectId), queryFn: () => api().labels(projectId) });

export const useViewRanks = (viewId: string | undefined) =>
  useQuery({ queryKey: keys.ranks(viewId ?? ""), queryFn: () => api().viewRanks(viewId!), enabled: !!viewId });

export const useHistory = (itemId: string | undefined) =>
  useQuery({ queryKey: keys.history(itemId ?? ""), queryFn: () => api().historyFor(itemId!), enabled: !!itemId });

export const useOplog = (limit = 5) => useQuery({ queryKey: keys.oplog, queryFn: () => api().recentOplog(limit) });

export function useCreateItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateItemInput, "by">) => api().create({ ...input, projectId }),
    onSuccess: () => invalidateWorkspace(qc, projectId)
  });
}

export function usePatchItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: Patch; baseVersion: number }) => api().update(args.id, args.patch, args.baseVersion),
    // A refusal has to re-fetch too: the banner says the board re-read, and the
    // retry needs a fresh version or it is refused for ever.
    onSettled: () => invalidateWorkspace(qc, projectId)
  });
}

export function useDeleteItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api().remove(id),
    onSuccess: () => invalidateWorkspace(qc, projectId)
  });
}

/**
 * The permanent one. `useDeleteItem` leaves a snapshot undo can restore; this
 * leaves nothing, so the caller must have confirmed first and must never offer
 * an Undo on the toast.
 */
export function usePurgeItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; baseVersion: number }) => api().purge(args.id, args.baseVersion),
    // onSettled, not onSuccess: a refused purge means the sheet was rendered
    // from a stale read, so the re-read has to happen before the user can
    // confirm again — the same reason usePatchItem re-fetches either way.
    onSettled: () => invalidateWorkspace(qc, projectId)
  });
}

export function useUndo(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entityId?: string) => api().undo(entityId),
    onSuccess: () => {
      invalidateWorkspace(qc, projectId);
      void qc.invalidateQueries({ queryKey: keys.boards(projectId) });
      void qc.invalidateQueries({ queryKey: keys.views(projectId) });
    }
  });
}

export function useSetViewRank(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { viewId: string; itemId: string; rank: number }) => api().viewSetRank(args.viewId, args.itemId, args.rank),
    onSuccess: (_r, args) => void qc.invalidateQueries({ queryKey: keys.ranks(args.viewId) })
  });
}

export function useCreateBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateBoardInput, "projectId">): Promise<CreatedBoard> => api().boardsCreate({ ...input, projectId }),
    onSuccess: (board) => {
      // the caller navigates straight to board.defaultViewId, so both caches have
      // to know about it before the refetch lands
      qc.setQueryData<Board[]>(keys.boards(projectId), (prev) => (prev ? [...prev, board] : prev));
      void qc.invalidateQueries({ queryKey: keys.boards(projectId) });
      void qc.invalidateQueries({ queryKey: keys.views(projectId) });
      void qc.invalidateQueries({ queryKey: keys.oplog });
    }
  });
}

export function useUpdateBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: BoardPatch }) => api().boardsUpdate(args.id, args.patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.boards(projectId) })
  });
}

export function useRemoveBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api().boardsRemove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.boards(projectId) });
      void qc.invalidateQueries({ queryKey: keys.views(projectId) });
    }
  });
}

export function useMoveItemsToBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { from: string; to: string; itemIds: string[] }) => api().boardsMoveItems(args.from, args.to, args.itemIds),
    onSuccess: () => invalidateWorkspace(qc, projectId)
  });
}

export function useCreateView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateViewInput): Promise<View> => api().viewsCreate(input),
    onSuccess: (view) => {
      qc.setQueryData<View[]>(keys.views(projectId), (prev) => (prev ? [...prev, view] : prev));
      void qc.invalidateQueries({ queryKey: keys.views(projectId) });
    }
  });
}

export function useUpdateView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: ViewPatch }) => api().viewsUpdate(args.id, args.patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.views(projectId) })
  });
}

export function useRemoveView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api().viewsRemove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.views(projectId) })
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput): Promise<Project> => api().projectsCreate(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.projects })
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (next: AppSettings) => api().settingsSet(next),
    onSuccess: (saved) => qc.setQueryData(keys.settings, saved)
  });
}

export type { Board, Item, Project, View };
