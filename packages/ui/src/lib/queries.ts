import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CommandScope } from "@tomrade/contributions";
import type { StorageBinding, StorageProviderView, StorageStatus } from "@tomrade/storage";
import type { CreateFieldInput, FieldOptionInput, FieldOptionPatch, FieldPatch } from "@tomrade/fields";
import type {
  AppSettings,
  Board,
  BoardPatch,
  CreateBoardInput,
  CreateItemInput,
  CreateProjectInput,
  CreateViewInput,
  Item,
  Patch,
  Project,
  ProjectPatch,
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
  fields: (projectId: string) => ["fields", projectId] as const,
  ranks: (viewId: string) => ["ranks", viewId] as const,
  history: (itemId: string) => ["history", itemId] as const,
  oplog: ["oplog"] as const,
  settings: ["settings"] as const,
  settingsSections: ["settings", "sections"] as const,
  mcp: ["mcp"] as const,
  dbPath: ["dbPath"] as const,
  plugins: ["plugins"] as const,
  storageProviders: ["storage", "providers"] as const,
  storageStatus: (projectId: string) => ["storage", "status", projectId] as const,
  storageBinding: (projectId: string) => ["storage", "binding", projectId] as const,
  storageConnection: (providerId: string) => ["storage", "connection", providerId] as const,
  contributions: ["contributions"] as const,
  commands: ["contributions", "commands"] as const,
  badges: (projectId: string) => ["contributions", "badges", projectId] as const,
  statusItems: (projectId?: string) => ["contributions", "status", projectId ?? ""] as const,
  sections: (itemId: string) => ["contributions", "sections", itemId] as const,
  graphs: ["contributions", "graphs"] as const,
  graphEdges: (projectId: string, graphId: string) => ["contributions", "graph", projectId, graphId] as const
};

/** Everything a board write can invalidate, in one call. */
export function invalidateWorkspace(qc: QueryClient, projectId: string): void {
  void qc.invalidateQueries({ queryKey: keys.items(projectId) });
  void qc.invalidateQueries({ queryKey: keys.labels(projectId) });
  void qc.invalidateQueries({ queryKey: keys.oplog });
  void qc.invalidateQueries({ queryKey: ["history"] });
  void qc.invalidateQueries({ queryKey: keys.contributions });
}

/**
 * Everything keyed by one project. `invalidateWorkspace` deliberately leaves
 * boards, views and ranks alone — a board write cannot change them — but an
 * import from a destination replaces every row, so this one spares nothing.
 */
export function invalidateProject(qc: QueryClient, projectId: string): void {
  invalidateWorkspace(qc, projectId);
  for (const key of [keys.boards(projectId), keys.views(projectId), keys.fields(projectId), keys.projects, keys.storageStatus(projectId), keys.storageBinding(projectId)]) {
    void qc.invalidateQueries({ queryKey: key });
  }
  void qc.invalidateQueries({ queryKey: ["ranks"] });
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
export const useFields = (projectId: string) => useQuery({ queryKey: keys.fields(projectId), queryFn: () => invoke("fields.list", projectId) });

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
export const useGraphs = () => useQuery({ queryKey: keys.graphs, queryFn: () => invoke("contributions.graphs") });
export const useGraphEdges = (projectId: string, graphId: string | null) =>
  useQuery({ queryKey: keys.graphEdges(projectId, graphId ?? ""), queryFn: () => invoke("contributions.graph", graphId!, { projectId }), enabled: !!graphId });

export const usePlugins = () => useQuery({ queryKey: keys.plugins, queryFn: () => invoke("plugins.list") });

/**
 * The answer is the whole composition after the switch, so the dialog redraws
 * from what actually loaded rather than from what it asked for. A refusal
 * leaves the cache untouched — nothing came down.
 */
export function useSetPluginEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) => invoke("plugins.setEnabled", args.id, args.enabled),
    onSuccess: (snapshot) => {
      qc.setQueryData(keys.plugins, snapshot);
      // A plugin that just loaded or unloaded took its channels, tools, badges
      // and settings cards with it.
      void qc.invalidateQueries({ queryKey: keys.contributions });
      void qc.invalidateQueries({ queryKey: keys.settingsSections });
    }
  });
}

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
    mutationFn: (input: Omit<CreateBoardInput, "projectId">): Promise<Board> => invoke("boards.create", { ...input, projectId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.boards(projectId) });
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
      void qc.invalidateQueries({ queryKey: keys.oplog });
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

/* ── saved views ────────────────────────────────────────────────────────
   Every view write is logged, so the oplog ribbon refetches alongside. */

export function useCreateView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateViewInput, "projectId">): Promise<View> => invoke("views.create", { ...input, projectId }),
    onSuccess: (view) => {
      // the caller navigates straight to the new view, so the cache sees it before the refetch lands
      qc.setQueryData<View[]>(keys.views(projectId), (prev) => (prev ? [...prev, view] : prev));
      void qc.invalidateQueries({ queryKey: keys.views(projectId) });
      void qc.invalidateQueries({ queryKey: keys.oplog });
    }
  });
}

export function useUpdateView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: ViewPatch }) => invoke("views.update", args.id, args.patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.views(projectId) });
      void qc.invalidateQueries({ queryKey: keys.oplog });
    }
  });
}

export function useRemoveView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("views.remove", id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.views(projectId) });
      void qc.invalidateQueries({ queryKey: keys.oplog });
    }
  });
}

/* ── the field registry ─────────────────────────────────────────────────
   Definitions are schema: every change lands live and refetches the items,
   because removing a field or an option takes values with it. */

function useFieldMutation<A, R>(projectId: string, fn: (args: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.fields(projectId) });
      void qc.invalidateQueries({ queryKey: keys.items(projectId) });
    }
  });
}

export const useCreateField = (projectId: string) =>
  useFieldMutation(projectId, (input: Omit<CreateFieldInput, "projectId">) => invoke("fields.create", { ...input, projectId }));
export const useUpdateField = (projectId: string) => useFieldMutation(projectId, (args: { id: string; patch: FieldPatch }) => invoke("fields.update", args.id, args.patch));
export const useRemoveField = (projectId: string) => useFieldMutation(projectId, (id: string) => invoke("fields.remove", id));
export const useAddFieldOption = (projectId: string) =>
  useFieldMutation(projectId, (args: { fieldId: string; input: FieldOptionInput }) => invoke("fields.addOption", args.fieldId, args.input));
export const useUpdateFieldOption = (projectId: string) =>
  useFieldMutation(projectId, (args: { fieldId: string; optionId: string; patch: FieldOptionPatch }) => invoke("fields.updateOption", args.fieldId, args.optionId, args.patch));
export const useRemoveFieldOption = (projectId: string) =>
  useFieldMutation(projectId, (args: { fieldId: string; optionId: string; moveTo?: string }) => invoke("fields.removeOption", args.fieldId, args.optionId, args.moveTo));

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput): Promise<Project> => invoke("projects.create", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.projects })
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: ProjectPatch }) => invoke("projects.update", args.id, args.patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.projects })
  });
}

/**
 * The other write undo cannot reach: projects sit outside the oplog, and the
 * delete takes the history of everything inside it. The caller confirms first,
 * never offers an Undo, and leaves the project's caches behind rather than
 * refetching them for a scope that is gone.
 */
export function useRemoveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("projects.remove", id),
    onSuccess: (_r, id) => {
      for (const key of [keys.boards(id), keys.views(id), keys.items(id), keys.labels(id), keys.badges(id), keys.statusItems(id)]) {
        qc.removeQueries({ queryKey: key });
      }
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: keys.oplog });
      void qc.invalidateQueries({ queryKey: keys.contributions });
    }
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (next: AppSettings) => invoke("settings.set", next),
    onSuccess: (saved) => qc.setQueryData(keys.settings, saved)
  });
}

/* ── where a project is stored ─────────────────────────────────────────── */

export const useStorageProviders = () => useQuery({ queryKey: keys.storageProviders, queryFn: (): Promise<StorageProviderView[]> => invoke("storage.providers") });

export const useStorageBinding = (projectId: string) =>
  useQuery({ queryKey: keys.storageBinding(projectId), queryFn: (): Promise<StorageBinding | null> => invoke("storage.binding", projectId) });

/** Contacts the remote, so it is asked for on open and after an action — never polled. */
export const useStorageStatus = (projectId: string) =>
  useQuery({ queryKey: keys.storageStatus(projectId), queryFn: (): Promise<StorageStatus> => invoke("storage.status", projectId), retry: false, staleTime: 10_000 });

/** Point a project at a destination and publish it there. */
export function useBindStorage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { providerId: string; config: Record<string, unknown> }) => invoke("storage.bind", projectId, args.providerId, args.config),
    onSettled: () => invalidateProject(qc, projectId)
  });
}

/** Forget the destination. Nothing there is deleted. */
export function useUnbindStorage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke("storage.unbind", projectId),
    onSettled: () => invalidateProject(qc, projectId)
  });
}

/** Take theirs, then publish ours. A refusal is the point, so the caller shows it. */
export function useSyncStorage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke("storage.sync", projectId),
    onSettled: () => invalidateProject(qc, projectId)
  });
}

/** Whether a destination's account is connected, and as whom. Never the secret. */
export const useStorageConnection = (providerId: string | undefined) =>
  useQuery({
    queryKey: keys.storageConnection(providerId ?? ""),
    queryFn: () => invoke("storage.connection", providerId!),
    enabled: !!providerId,
    retry: false
  });

/** Collected where it is needed; the provider keeps it per machine. */
export function useConnectStorage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { providerId: string; secret: string }) => invoke("storage.connect", args.providerId, args.secret),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["storage"] })
  });
}

export function useDisconnectStorage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) => invoke("storage.disconnect", providerId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["storage"] })
  });
}

/** Imperative on purpose: nothing is listed until someone asks to choose. */
export function useBrowseStorage() {
  return useMutation({ mutationFn: (providerId: string) => invoke("storage.browse", providerId) });
}

export function useDraftStorage() {
  return useMutation({ mutationFn: (args: { providerId: string; name: string }) => invoke("storage.draft", args.providerId, args.name) });
}

/** Bring in a project this machine does not know; resolves to its id. */
export function useAttachProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { providerId: string; config: Record<string, unknown> }) => invoke("storage.attach", args.providerId, args.config),
    onSuccess: (projectId) => invalidateProject(qc, projectId)
  });
}

export type { Board, Item, Project, View };
