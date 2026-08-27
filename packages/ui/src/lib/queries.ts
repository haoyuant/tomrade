import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CommandScope } from "@tomrade/contributions";
import type {
  AppSettings,
  Board,
  BoardPatch,
  CreateBoardInput,
  CreatedBoard,
  CreateItemInput,
  CreateProjectInput,
  CreateViewInput,
  Item,
  Patch,
  Project,
  View,
  ViewPatch
} from "@tomrade/domain";
import { invoke } from "./api";

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
  settingsSections: ["settings", "sections"] as const,
  mcp: ["mcp"] as const,
  dbPath: ["dbPath"] as const,
  contributions: ["contributions"] as const,
  commands: ["contributions", "commands"] as const,
  badges: (projectId: string) => ["contributions", "badges", projectId] as const,
  statusItems: (projectId?: string) => ["contributions", "status", projectId ?? ""] as const,
  sections: (itemId: string) => ["contributions", "sections", itemId] as const
};

/** Everything a board write can invalidate, in one call. */
export function invalidateWorkspace(qc: QueryClient, projectId: string): void {
  void qc.invalidateQueries({ queryKey: keys.items(projectId) });
  void qc.invalidateQueries({ queryKey: keys.labels(projectId) });
  void qc.invalidateQueries({ queryKey: keys.oplog });
  void qc.invalidateQueries({ queryKey: ["history"] });
  void qc.invalidateQueries({ queryKey: keys.contributions });
}

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => invoke("projects.list") });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => invoke("settings.get") });
export const useSettingsSections = () => useQuery({ queryKey: keys.settingsSections, queryFn: () => invoke("settings.sections") });
export const useMcpUrl = () => useQuery({ queryKey: keys.mcp, queryFn: () => invoke("mcp.url"), retry: false });
export const useDbPath = () => useQuery({ queryKey: keys.dbPath, queryFn: () => invoke("db.path") });

export const useBoards = (projectId: string) => useQuery({ queryKey: keys.boards(projectId), queryFn: () => invoke("boards.list", projectId) });
export const useViews = (projectId: string) => useQuery({ queryKey: keys.views(projectId), queryFn: () => invoke("views.list", projectId) });
export const useItems = (projectId: string) => useQuery({ queryKey: keys.items(projectId), queryFn: () => invoke("items.list", { projectId }) });
export const useLabels = (projectId: string) => useQuery({ queryKey: keys.labels(projectId), queryFn: () => invoke("items.labels", projectId) });

export const useViewRanks = (viewId: string | undefined) =>
  useQuery({ queryKey: keys.ranks(viewId ?? ""), queryFn: () => invoke("views.ranks", viewId!), enabled: !!viewId });

export const useHistory = (itemId: string | undefined) =>
  useQuery({ queryKey: keys.history(itemId ?? ""), queryFn: () => invoke("oplog.history", "item", itemId!), enabled: !!itemId });

export const useOplog = (limit = 5) => useQuery({ queryKey: keys.oplog, queryFn: () => invoke("oplog.recent", limit) });

export const useCommands = () => useQuery({ queryKey: keys.commands, queryFn: () => invoke("contributions.commands") });
export const useBadges = (projectId: string) => useQuery({ queryKey: keys.badges(projectId), queryFn: () => invoke("contributions.badges", projectId) });
export const useStatusItems = (projectId?: string) =>
  useQuery({ queryKey: keys.statusItems(projectId), queryFn: () => invoke("contributions.statusItems", { projectId }) });
export const useSections = (itemId: string | undefined) =>
  useQuery({ queryKey: keys.sections(itemId ?? ""), queryFn: () => invoke("contributions.sections", itemId!), enabled: !!itemId });

export function useRunCommand(projectId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; scope: CommandScope }) => invoke("contributions.run", args.id, args.scope),
    onSettled: () => projectId && invalidateWorkspace(qc, projectId)
  });
}

export function useCreateItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateItemInput, "by">) => invoke("items.create", { ...input, projectId }),
    onSuccess: () => invalidateWorkspace(qc, projectId)
  });
}

/** A refusal re-fetches too: the retry needs a fresh version or it is refused for ever. */
export function usePatchItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: Patch; baseVersion: number }) => invoke("items.update", args.id, args.patch, args.baseVersion),
    onSettled: () => invalidateWorkspace(qc, projectId)
  });
}

export function useDeleteItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("items.delete", id),
    onSuccess: () => invalidateWorkspace(qc, projectId)
  });
}

/** The permanent one: nothing survives it, so the caller confirms first and never offers an Undo. */
export function usePurgeItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; baseVersion: number }) => invoke("items.purge", args.id, args.baseVersion),
    onSettled: () => invalidateWorkspace(qc, projectId)
  });
}

export function useUndo(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entityId?: string) => invoke("oplog.undo", entityId),
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
    mutationFn: (args: { viewId: string; itemId: string; rank: number }) => invoke("views.setRank", args.viewId, args.itemId, args.rank),
    onSuccess: (_r, args) => void qc.invalidateQueries({ queryKey: keys.ranks(args.viewId) })
  });
}

export function useCreateBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateBoardInput, "projectId">): Promise<CreatedBoard> => invoke("boards.create", { ...input, projectId }),
    onSuccess: (board) => {
      // the caller navigates straight to board.defaultViewId, so both caches see it before the refetch lands
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
    mutationFn: (args: { id: string; patch: BoardPatch }) => invoke("boards.update", args.id, args.patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.boards(projectId) })
  });
}

export function useRemoveBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("boards.remove", id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.boards(projectId) });
      void qc.invalidateQueries({ queryKey: keys.views(projectId) });
    }
  });
}

export function useMoveItemsToBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { from: string; to: string; itemIds: string[] }) => invoke("boards.moveItems", args.from, args.to, args.itemIds),
    onSuccess: () => invalidateWorkspace(qc, projectId)
  });
}

export function useCreateView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateViewInput): Promise<View> => invoke("views.create", input),
    onSuccess: (view) => {
      qc.setQueryData<View[]>(keys.views(projectId), (prev) => (prev ? [...prev, view] : prev));
      void qc.invalidateQueries({ queryKey: keys.views(projectId) });
    }
  });
}

export function useUpdateView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: ViewPatch }) => invoke("views.update", args.id, args.patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.views(projectId) })
  });
}

export function useRemoveView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("views.remove", id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.views(projectId) })
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput): Promise<Project> => invoke("projects.create", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.projects })
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (next: AppSettings) => invoke("settings.set", next),
    onSuccess: (saved) => qc.setQueryData(keys.settings, saved)
  });
}

export type { Board, Item, Project, View };
