import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CommandScope } from "@tomradex/contributions";
import type { RestoreSummary, StorageInfo, StorageProviderView, StorageStatus } from "@tomradex/storage";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/repos";
import type { CheckoutSelection, CheckoutView } from "@tomradex/repos";
import type { CreateFieldInput, FieldOptionInput, FieldOptionPatch, FieldPatch } from "@tomradex/fields";
import type { Repo, RepoPatch } from "@tomradex/domain";
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
} from "@tomradex/domain";
import { invoke } from "./api";

export const keys = {
  projects: ["projects"] as const,
  boards: (projectId: string) => ["boards", projectId] as const,
  views: (projectId: string) => ["views", projectId] as const,
  items: (projectId: string) => ["items", projectId] as const,
  labels: (projectId: string) => ["labels", projectId] as const,
  fields: (projectId: string) => ["fields", projectId] as const,
  ranks: (viewId: string) => ["ranks", viewId] as const,
  history: (projectId: string, itemId: string) => ["history", projectId, itemId] as const,
  /** Per project: with one file per project there is no cross-project "recent". */
  oplog: (projectId: string) => ["oplog", projectId] as const,
  /** The history window's list: every provider's records, undone ones included. */
  timeline: (projectId: string) => ["timeline", projectId] as const,
  settings: ["settings"] as const,
  settingsSections: ["settings", "sections"] as const,
  mcp: (projectId?: string) => ["mcp", projectId ?? ""] as const,
  cacheDir: ["cacheDir"] as const,
  hub: ["hub"] as const,
  hubRemote: ["storage", "hub"] as const,
  repos: (projectId: string) => ["repos", projectId] as const,
  repoCheckouts: ["repos", "checkouts"] as const,
  plugins: ["plugins"] as const,
  storageProviders: ["storage", "providers"] as const,
  restores: ["storage", "restores"] as const,
  storageStatus: (projectId: string) => ["storage", "status", projectId] as const,
  storageInfo: (projectId: string) => ["storage", "info", projectId] as const,
  storageConnection: (providerId: string) => ["storage", "connection", providerId] as const,
  contributions: ["contributions"] as const,
  commands: ["contributions", "commands"] as const,
  badges: (projectId: string) => ["contributions", "badges", projectId] as const,
  statusItems: (projectId?: string) => ["contributions", "status", projectId ?? ""] as const,
  sections: (projectId: string, itemId: string) => ["contributions", "sections", projectId, itemId] as const,
  graphs: ["contributions", "graphs"] as const,
  graphEdges: (projectId: string, graphId: string) => ["contributions", "graph", projectId, graphId] as const,
  assistantAccessories: ["contributions", "assistant-accessories"] as const
};

/** Everything a board write can invalidate, in one call. */
export function invalidateWorkspace(qc: QueryClient, projectId: string): void {
  void qc.invalidateQueries({ queryKey: keys.items(projectId) });
  void qc.invalidateQueries({ queryKey: keys.labels(projectId) });
  void qc.invalidateQueries({ queryKey: keys.oplog(projectId) });
  void qc.invalidateQueries({ queryKey: keys.timeline(projectId) });
  void qc.invalidateQueries({ queryKey: ["history", projectId] });
  void qc.invalidateQueries({ queryKey: keys.contributions });
}

/**
 * Everything keyed by one project. `invalidateWorkspace` deliberately leaves
 * boards, views and ranks alone — a board write cannot change them — but an
 * import from a destination replaces every row, so this one spares nothing.
 */
export function invalidateProject(qc: QueryClient, projectId: string): void {
  invalidateWorkspace(qc, projectId);
  for (const key of [keys.boards(projectId), keys.views(projectId), keys.fields(projectId), keys.projects, keys.storageStatus(projectId), keys.storageInfo(projectId)]) {
    void qc.invalidateQueries({ queryKey: key });
  }
  void qc.invalidateQueries({ queryKey: ["ranks"] });
}

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => invoke("projects.list") });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => invoke("settings.get") });
/** The cards' words come back in the renderer's language, so a language switch fetches them again. */
export const useSettingsSections = (locale?: "en" | "zh") =>
  useQuery({ queryKey: [...keys.settingsSections, locale ?? ""], queryFn: () => invoke("settings.sections", locale) });
/** The project's own MCP address when one is given; the unscoped server otherwise. */
export const useMcpUrl = (projectId?: string) => useQuery({ queryKey: keys.mcp(projectId), queryFn: () => invoke("mcp.url", projectId), retry: false });
/** Where this machine keeps its caches. Never the truth — every file there can be rebuilt. */
export const useCacheDir = () => useQuery({ queryKey: keys.cacheDir, queryFn: () => invoke("db.dir") });
/** This machine: its id and its Hub folder. */
export const useHubInfo = () => useQuery({ queryKey: keys.hub, queryFn: () => invoke("hub.info") });

export const useBoards = (projectId: string) => useQuery({ queryKey: keys.boards(projectId), queryFn: () => invoke("boards.list", projectId) });
export const useViews = (projectId: string) => useQuery({ queryKey: keys.views(projectId), queryFn: () => invoke("views.list", projectId) });
export const useItems = (projectId: string) => useQuery({ queryKey: keys.items(projectId), queryFn: () => invoke("items.list", { projectId }) });
export const useLabels = (projectId: string) => useQuery({ queryKey: keys.labels(projectId), queryFn: () => invoke("items.labels", projectId) });
export const useFields = (projectId: string) => useQuery({ queryKey: keys.fields(projectId), queryFn: () => invoke("fields.list", projectId) });

export const useViewRanks = (projectId: string, viewId: string | undefined) =>
  useQuery({ queryKey: keys.ranks(viewId ?? ""), queryFn: () => invoke("views.ranks", projectId, viewId!), enabled: !!viewId });

export const useHistory = (projectId: string, itemId: string | undefined) =>
  useQuery({ queryKey: keys.history(projectId, itemId ?? ""), queryFn: () => invoke("oplog.history", projectId, "item", itemId!), enabled: !!itemId });

/** A project's latest writes. Undefined on the home screen: nothing is recent across projects. */
export const useOplog = (projectId: string | undefined, limit = 5) =>
  useQuery({ queryKey: keys.oplog(projectId ?? ""), queryFn: () => invoke("oplog.recent", projectId!, limit), enabled: !!projectId });

export const useCommands = () => useQuery({ queryKey: keys.commands, queryFn: () => invoke("contributions.commands") });
export const useBadges = (projectId: string) => useQuery({ queryKey: keys.badges(projectId), queryFn: () => invoke("contributions.badges", projectId) });
export const useStatusItems = (projectId?: string) =>
  useQuery({ queryKey: keys.statusItems(projectId), queryFn: () => invoke("contributions.statusItems", { projectId }) });
export const useSections = (projectId: string, itemId: string | undefined) =>
  useQuery({ queryKey: keys.sections(projectId, itemId ?? ""), queryFn: () => invoke("contributions.sections", projectId, itemId!), enabled: !!itemId });
export const useGraphs = () => useQuery({ queryKey: keys.graphs, queryFn: () => invoke("contributions.graphs") });
export const useGraphEdges = (projectId: string, graphId: string | null) =>
  useQuery({ queryKey: keys.graphEdges(projectId, graphId ?? ""), queryFn: () => invoke("contributions.graph", graphId!, { projectId }), enabled: !!graphId });
export const useAssistantAccessories = () =>
  useQuery({ queryKey: keys.assistantAccessories, queryFn: () => invoke("contributions.assistantAccessories"), staleTime: Infinity });

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
    mutationFn: (args: { id: string; patch: Patch; baseVersion: number }) => invoke("items.update", projectId, args.id, args.patch, args.baseVersion),
    onSettled: () => invalidateWorkspace(qc, projectId)
  });
}

export function useDeleteItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("items.delete", projectId, id),
    onSuccess: () => invalidateWorkspace(qc, projectId)
  });
}

/** The permanent one: nothing survives it, so the caller confirms first and never offers an Undo. */
export function usePurgeItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; baseVersion: number }) => invoke("items.purge", projectId, args.id, args.baseVersion),
    onSettled: () => invalidateWorkspace(qc, projectId)
  });
}

/** An undo, redo or rollback can have touched anything: every board, view, rank and file, as well as the items. */
function afterTimelineMove(qc: QueryClient, projectId: string): void {
  invalidateWorkspace(qc, projectId);
  void qc.invalidateQueries({ queryKey: keys.boards(projectId) });
  void qc.invalidateQueries({ queryKey: keys.views(projectId) });
  void qc.invalidateQueries({ queryKey: ["ranks"] });
  void qc.invalidateQueries({ queryKey: ["files", projectId] });
}

/** ⌘Z. With an entity id, that entity's latest backlog write; without, the newest record anywhere — files included. */
export function useUndo(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    // a bare id is "the newest write to it"; a stamp aims at one write and is refused once something newer stands
    mutationFn: (target?: string | { id: string; stamp: number }) =>
      typeof target === "object" ? invoke("oplog.undo", projectId, target.id, target.stamp) : invoke("oplog.undo", projectId, target),
    onSettled: () => afterTimelineMove(qc, projectId)
  });
}

/** ⇧⌘Z: the record undone most recently. */
export function useRedo(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke("oplog.redo", projectId),
    onSettled: () => afterTimelineMove(qc, projectId)
  });
}

/** The project's history, newest first, undone records included. Fetched when the window opens and after every move. */
export const useTimeline = (projectId: string, enabled: boolean, limit = 200) =>
  useQuery({ queryKey: keys.timeline(projectId), queryFn: () => invoke("oplog.timeline", projectId, limit), enabled });

/** Move the history's cursor: undo everything newer than a live record, or redo up to an undone one. */
export function useRollback(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ref: string) => invoke("oplog.rollback", projectId, ref),
    onSettled: () => afterTimelineMove(qc, projectId)
  });
}

/** Take back one named record — what a toast's Undo does for a file operation. */
export function useRevert(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ref: string) => invoke("oplog.revert", projectId, ref),
    onSettled: () => afterTimelineMove(qc, projectId)
  });
}

export function useSetViewRank(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { viewId: string; itemId: string; rank: number }) => invoke("views.setRank", projectId, args.viewId, args.itemId, args.rank),
    onSuccess: (_r, args) => {
      void qc.invalidateQueries({ queryKey: keys.ranks(args.viewId) });
      // a rank move is logged now, so the ribbon and ⌘Z see it
      void qc.invalidateQueries({ queryKey: keys.oplog(projectId) });
    }
  });
}

/** A whole cell renumbered at once: one write, one history entry, one ⌘Z. */
export function useSetViewRanks(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { viewId: string; ranks: Record<string, number> }) => invoke("views.setRanks", projectId, args.viewId, args.ranks),
    onSuccess: (_r, args) => {
      void qc.invalidateQueries({ queryKey: keys.ranks(args.viewId) });
      void qc.invalidateQueries({ queryKey: keys.oplog(projectId) });
    }
  });
}

export function useCreateBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateBoardInput, "projectId">): Promise<Board> => invoke("boards.create", { ...input, projectId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.boards(projectId) });
      void qc.invalidateQueries({ queryKey: keys.oplog(projectId) });
    }
  });
}

export function useUpdateBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: BoardPatch }) => invoke("boards.update", projectId, args.id, args.patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.boards(projectId) })
  });
}

export function useRemoveBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("boards.remove", projectId, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.boards(projectId) });
      void qc.invalidateQueries({ queryKey: keys.oplog(projectId) });
    }
  });
}

export function useMoveItemsToBoard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { from: string; to: string; itemIds: string[] }) => invoke("boards.moveItems", projectId, args.from, args.to, args.itemIds),
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
      void qc.invalidateQueries({ queryKey: keys.oplog(projectId) });
    }
  });
}

export function useUpdateView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: ViewPatch }) => invoke("views.update", projectId, args.id, args.patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.views(projectId) });
      void qc.invalidateQueries({ queryKey: keys.oplog(projectId) });
    }
  });
}

export function useRemoveView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("views.remove", projectId, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.views(projectId) });
      void qc.invalidateQueries({ queryKey: keys.oplog(projectId) });
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
export const useUpdateField = (projectId: string) => useFieldMutation(projectId, (args: { id: string; patch: FieldPatch }) => invoke("fields.update", projectId, args.id, args.patch));
export const useRemoveField = (projectId: string) => useFieldMutation(projectId, (id: string) => invoke("fields.remove", projectId, id));
export const useAddFieldOption = (projectId: string) =>
  useFieldMutation(projectId, (args: { fieldId: string; input: FieldOptionInput }) => invoke("fields.addOption", projectId, args.fieldId, args.input));
export const useUpdateFieldOption = (projectId: string) =>
  useFieldMutation(projectId, (args: { fieldId: string; optionId: string; patch: FieldOptionPatch }) => invoke("fields.updateOption", projectId, args.fieldId, args.optionId, args.patch));
export const useRemoveFieldOption = (projectId: string) =>
  useFieldMutation(projectId, (args: { fieldId: string; optionId: string; moveTo?: string }) => invoke("fields.removeOption", projectId, args.fieldId, args.optionId, args.moveTo));

/** `dir` is where the project's folder goes; blank lets the Hub place it under `projects/<slug>`. */
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { input: CreateProjectInput; dir?: string }): Promise<Project> => invoke("projects.create", args.input, args.dir ? { dir: args.dir } : undefined),
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
    mutationFn: (args: { id: string; deleteFolder?: boolean }) => invoke("projects.remove", args.id, args.deleteFolder ? { deleteFolder: true } : undefined),
    onSuccess: (_r, { id }) => {
      for (const key of [keys.boards(id), keys.views(id), keys.items(id), keys.labels(id), keys.badges(id), keys.statusItems(id), keys.oplog(id)]) {
        qc.removeQueries({ queryKey: key });
      }
      void qc.invalidateQueries({ queryKey: keys.projects });
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

/** The folder, who drives git in it, the remote, and what travels — everything the block draws. */
export const useStorageInfo = (projectId: string) =>
  useQuery({ queryKey: keys.storageInfo(projectId), queryFn: (): Promise<StorageInfo> => invoke("storage.info", projectId) });

/** Contacts the remote, so it is asked for on open and after an action — never polled. */
export const useStorageStatus = (projectId: string) =>
  useQuery({ queryKey: keys.storageStatus(projectId), queryFn: (): Promise<StorageStatus> => invoke("storage.status", projectId), retry: false, staleTime: 10_000 });

/** Re-point the project at a folder. Empty: written; holding this project: adopted; another's: refused. */
export function useSetFolder(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dir: string) => invoke("storage.setFolder", projectId, dir),
    onSettled: () => invalidateProject(qc, projectId)
  });
}

export function useSetAutoCommit(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) => invoke("storage.setAutoCommit", projectId, on),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.storageInfo(projectId) })
  });
}

export function useSetExports(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (namespaces: string[]) => invoke("storage.setExports", projectId, namespaces),
    onSettled: () => invalidateProject(qc, projectId)
  });
}

/** Give the project's own repository a remote and push. Refused inside the user's own checkout. */
export function useBindStorage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { providerId: string; config: Record<string, unknown> }) => invoke("storage.bind", projectId, args.providerId, args.config),
    onSettled: () => invalidateProject(qc, projectId)
  });
}

/** Forget the remote. The repository and nothing remote is deleted. */
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

/** Drop the cache and read the folder again. The folder is the truth, so nothing but the undo window is lost. */
export function useRebuildStorage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke("storage.rebuild", projectId),
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["storage"] });
      void qc.invalidateQueries({ queryKey: ["codeLink"] });
    }
  });
}

export function useDisconnectStorage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) => invoke("storage.disconnect", providerId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["storage"] });
      void qc.invalidateQueries({ queryKey: ["codeLink"] });
    }
  });
}

/** Imperative on purpose: nothing is listed until someone asks to choose. */
export function useBrowseStorage() {
  return useMutation({ mutationFn: (providerId: string) => invoke("storage.browse", providerId) });
}

export function useDraftStorage() {
  return useMutation({ mutationFn: (args: { providerId: string; name: string }) => invoke("storage.draft", args.providerId, args.name) });
}

/** Open a folder that already holds a project; resolves to its id. */
export function useAttachFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dir: string) => invoke("storage.attach", dir),
    onSuccess: (projectId) => invalidateProject(qc, projectId)
  });
}

/** Clone a published project into the Hub and open it; resolves to its id. */
export function useAttachRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { providerId: string; config: Record<string, unknown> }) => invoke("storage.attachRemote", args.providerId, args.config),
    onSuccess: (projectId) => invalidateProject(qc, projectId)
  });
}

/* ── this machine ──────────────────────────────────────────────────────── */

/** First run, or a move: name the Hub folder. Every project without a folder gets one under it. */
export function useConfigureHub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dir: string) => invoke("hub.configure", dir),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.hub });
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: ["storage"] });
    }
  });
}

export type { Board, Item, Project, View };

/* ── the Hub's own remote ─────────────────────────────────────────────── */

/** The Hub folder's remote, its state, and the projects its catalog names that are not here. Contacts the remote. */
export const useHubRemote = () => useQuery({ queryKey: keys.hubRemote, queryFn: () => invoke("storage.hubInfo"), retry: false, staleTime: 10_000 });

const invalidateHub = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: keys.hubRemote });
  void qc.invalidateQueries({ queryKey: keys.hub });
  void qc.invalidateQueries({ queryKey: keys.projects });
};

/** Make the Hub folder a repository of Tomrade's own and give it a remote. */
export function useBindHub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { providerId: string; config: Record<string, unknown> }) => invoke("storage.hubBind", args.providerId, args.config),
    onSettled: () => invalidateHub(qc)
  });
}

export function useUnbindHub() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => invoke("storage.hubUnbind"), onSettled: () => invalidateHub(qc) });
}

export function useSyncHub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke("storage.hubSync"),
    onSettled: () => {
      invalidateHub(qc);
      void qc.invalidateQueries({ queryKey: keys.settings });
    }
  });
}

/** Clone every project the Hub knows and this machine does not; resolves to their ids. */
export function useAttachAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke("storage.hubAttachAll"),
    onSettled: () => {
      invalidateHub(qc);
      void qc.invalidateQueries({ queryKey: ["storage"] });
    }
  });
}

/* ── restoring ───────────────────────────────────────────────────────────
   What the account names and this machine lacks. A local read: progress
   arrives as broadcasts, the poll is only a backstop while work is under way. */

const restoreActive = (summary?: RestoreSummary) => !!summary?.entries.some((e) => e.state === "queued" || e.state === "restoring");

export const useRestores = () =>
  useQuery({ queryKey: keys.restores, queryFn: () => invoke("storage.restores"), refetchInterval: (q) => (restoreActive(q.state.data) ? 2_000 : false) });

/** Try one project again now; the card follows by broadcast. */
export function useRetryRestore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => invoke("storage.restore", projectId),
    onSuccess: (summary) => qc.setQueryData(keys.restores, summary)
  });
}

/** Take a project this computer does not have out of the account's (or Hub's) catalog. Deletes nothing. */
export function useRemoveFromHub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => invoke("storage.removeFromHub", projectId),
    onSuccess: (summary) => qc.setQueryData(keys.restores, summary)
  });
}

/** Open the folder holding a project that has no remote to come back from. */
export function useLocateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { projectId: string; dir: string }) => invoke("storage.locate", args.projectId, args.dir),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.restores });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    }
  });
}

/* ── repositories ────────────────────────────────────────────────────────
   The URL is the project's; the checkout is this machine's. */

export const useRepos = (projectId: string) => useQuery({ queryKey: keys.repos(projectId), queryFn: (): Promise<Repo[]> => invoke("repos.list", projectId) });
export const useRepoCheckouts = () => useQuery({ queryKey: keys.repoCheckouts, queryFn: (): Promise<CheckoutView[]> => invoke("repos.checkouts") });

function useRepoMutation<A, R>(projectId: string | null, fn: (args: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      if (projectId) void qc.invalidateQueries({ queryKey: keys.repos(projectId) });
      void qc.invalidateQueries({ queryKey: keys.repoCheckouts });
      // where an agent would run may have changed
      void qc.invalidateQueries({ queryKey: ["agent", "workdir"] });
    }
  });
}

export const useCreateRepo = (projectId: string) =>
  useRepoMutation(projectId, (input: { remote: string; name?: string; defaultBranch?: string }): Promise<Repo> => invoke("repos.create", { ...input, projectId }));
export const useUpdateRepo = (projectId: string) => useRepoMutation(projectId, (args: { id: string; patch: RepoPatch }) => invoke("repos.update", projectId, args.id, args.patch));
export const useRemoveRepo = (projectId: string) => useRepoMutation(projectId, (id: string) => invoke("repos.remove", projectId, id));
export const useSelectCheckout = () => useRepoMutation(null, (args: { remote: string; dir: string }): Promise<CheckoutSelection> => invoke("repos.selectCheckout", args.remote, args.dir));
export const useClearCheckout = () => useRepoMutation(null, (remote: string) => invoke("repos.clearCheckout", remote));
export const useSetRunInCheckout = () => useRepoMutation(null, (args: { remote: string; on: boolean }) => invoke("repos.setRunInCheckout", args.remote, args.on));
export const useCloneRepoInto = () => useRepoMutation(null, (args: { remote: string; branch: string; parent: string }) => invoke("repos.cloneInto", args.remote, args.branch, args.parent));
