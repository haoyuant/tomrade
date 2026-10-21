import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/community";
import type {} from "@tomradex/plugin-studio";
import type { PluginsSnapshot } from "@tomradex/plugins";
import { invoke } from "./api";
import { invalidateProject, keys } from "./queries";

/** A snapshot answered by a mutation replaces the list at once, and what the plugins drew is refetched. */
function useSnapshotMutation<A>(fn: (args: A) => Promise<PluginsSnapshot>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (snapshot) => {
      qc.setQueryData(keys.plugins, snapshot);
      void qc.invalidateQueries({ queryKey: keys.contributions });
      void qc.invalidateQueries({ queryKey: keys.settingsSections });
      void qc.invalidateQueries({ queryKey: keys.community.root });
      void qc.invalidateQueries({ queryKey: keys.studio.root });
    }
  });
}

export const useInstallFile = () => useSnapshotMutation((file: string) => invoke("plugins.installFile", file));
export const useAddFolder = () => useSnapshotMutation((dir: string) => invoke("plugins.addFolder", dir));
export const useUninstall = () => useSnapshotMutation((a: { id: string; removeData: boolean }) => invoke("plugins.uninstall", a.id, a.removeData));
export const useRollback = () => useSnapshotMutation((id: string) => invoke("plugins.rollback", id));
export const useReload = () => useSnapshotMutation((id: string) => invoke("plugins.reload", id));
export const useSetAutoUpdate = () => useSnapshotMutation((a: { id: string; on: boolean }) => invoke("plugins.setAutoUpdate", a.id, a.on));
export const useAllowVersion = () => useSnapshotMutation((id: string) => invoke("plugins.allowVersion", id));
export const useWithdrawVersion = () => useSnapshotMutation((id: string) => invoke("plugins.withdrawVersion", id));
export const useStoreInstall = () => useSnapshotMutation((a: { id: string; version?: string }) => invoke("community.install", a.id, a.version));
export const useStoreUpdate = () => useSnapshotMutation((id: string) => invoke("community.update", id));

export function useUndoVia(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (namespace: string) => invoke("oplog.undoVia", projectId!, namespace),
    onSuccess: () => {
      if (projectId) invalidateProject(qc, projectId);
    }
  });
}

/** Official and Community in one search; each source says on its own whether it answered. */
export const useBrowse = (text: string, sort: "downloads" | "updated" | "title", officialOnly: boolean) =>
  useQuery({ queryKey: keys.community.browse(text, sort, officialOnly), queryFn: () => invoke("community.browse", { text, sort, officialOnly }), retry: false, staleTime: 60_000 });
export const useCommunityPlugin = (id: string | null) => useQuery({ queryKey: keys.community.plugin(id ?? ""), queryFn: () => invoke("community.plugin", id!), enabled: !!id, retry: false });
export const useUpdates = () => useQuery({ queryKey: keys.community.updates, queryFn: () => invoke("community.updates"), retry: false });
export const useRevoked = () => useQuery({ queryKey: keys.community.revoked, queryFn: () => invoke("community.revoked") });
export const useCommunityAccount = () => useQuery({ queryKey: keys.community.account, queryFn: () => invoke("community.account"), retry: false });
export const usePublished = (enabled: boolean) => useQuery({ queryKey: keys.community.published, queryFn: () => invoke("community.published"), enabled, retry: false });
/** Downloads the package and reads it here; the install that follows reuses the download. */
export const useInspect = (id: string, version: string) => useQuery({ queryKey: keys.community.inspect(id, version), queryFn: () => invoke("community.inspect", id, version), retry: false, staleTime: 300_000 });

function useCommunityMutation<A, R>(fn: (args: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void qc.invalidateQueries({ queryKey: keys.community.root }) });
}

export const useReport = () => useCommunityMutation((a: { id: string; version: string | null; reason: string; details: string }) => invoke("community.report", a.id, a.version, a.reason, a.details));
export const useLinkGitHub = () => useCommunityMutation(() => invoke("community.linkGitHub"));
export const useBecomePublisher = () => useCommunityMutation(() => invoke("community.becomePublisher"));
export const usePublish = () => useCommunityMutation((dir: string) => invoke("community.publish", dir));

export const useWorkspaces = () => useQuery({ queryKey: keys.studio.root, queryFn: () => invoke("studio.list") });
export const useBuildReview = (name: string | null) => useQuery({ queryKey: keys.studio.review(name ?? ""), queryFn: () => invoke("studio.review", name!), enabled: !!name, staleTime: 0 });
export const useSnapshots = (name: string | null) => useQuery({ queryKey: keys.studio.snapshots(name ?? ""), queryFn: () => invoke("studio.snapshots", name!), enabled: !!name });

function useStudioMutation<A, R>(fn: (args: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.studio.root });
      void qc.invalidateQueries({ queryKey: keys.plugins });
      void qc.invalidateQueries({ queryKey: keys.contributions });
    }
  });
}

export const useStudioCreate = () => useStudioMutation((a: { projectId: string; name: string; description: string; engine?: string }) => invoke("studio.create", a));
export const useStudioContinue = () => useStudioMutation((a: { projectId: string; name: string; engine?: string }) => invoke("studio.continue", a));
export const useStudioConfirm = () => useStudioMutation((a: { name: string; digest: string }) => invoke("studio.confirm", a.name, a.digest));
export const useStudioPack = () => useStudioMutation((name: string) => invoke("studio.pack", name));
export const useStudioRestore = () => useStudioMutation((a: { name: string; file: string }) => invoke("studio.restore", a.name, a.file));
export const useStudioRemove = () => useStudioMutation((a: { name: string; deleteFiles: boolean }) => invoke("studio.remove", a.name, a.deleteFiles));
