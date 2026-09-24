import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomrade/community";
import type {} from "@tomrade/plugin-studio";
import type { PluginsSnapshot } from "@tomrade/plugins";
import { invoke } from "./api";
import { invalidateProject } from "./queries";

const keys = {
  plugins: ["plugins"] as const,
  community: ["community"] as const,
  search: (text: string, sort: string) => ["community", "search", text, sort] as const,
  plugin: (id: string) => ["community", "plugin", id] as const,
  updates: ["community", "updates"] as const,
  revoked: ["community", "revoked"] as const,
  account: ["community", "account"] as const,
  submissions: ["community", "submissions"] as const,
  studio: ["studio"] as const,
  review: (name: string) => ["studio", "review", name] as const,
  snapshots: (name: string) => ["studio", "snapshots", name] as const
};

/** A snapshot answered by a mutation replaces the list at once, and what the plugins drew is refetched. */
function useSnapshotMutation<A>(fn: (args: A) => Promise<PluginsSnapshot>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (snapshot) => {
      qc.setQueryData(keys.plugins, snapshot);
      void qc.invalidateQueries({ queryKey: ["contributions"] });
      void qc.invalidateQueries({ queryKey: ["settings", "sections"] });
      void qc.invalidateQueries({ queryKey: keys.community });
      void qc.invalidateQueries({ queryKey: keys.studio });
    }
  });
}

export const useInstallFile = () => useSnapshotMutation((file: string) => invoke("plugins.installFile", file));
export const useAddFolder = () => useSnapshotMutation((dir: string) => invoke("plugins.addFolder", dir));
export const useUninstall = () => useSnapshotMutation((a: { id: string; removeData: boolean }) => invoke("plugins.uninstall", a.id, a.removeData));
export const useRollback = () => useSnapshotMutation((id: string) => invoke("plugins.rollback", id));
export const useReload = () => useSnapshotMutation((id: string) => invoke("plugins.reload", id));
export const useSetAutoUpdate = () => useSnapshotMutation((a: { id: string; on: boolean }) => invoke("plugins.setAutoUpdate", a.id, a.on));
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

export const useCommunitySearch = (text: string, sort: "downloads" | "updated" | "title") =>
  useQuery({ queryKey: keys.search(text, sort), queryFn: () => invoke("community.search", { text, sort }), retry: false, staleTime: 60_000 });
export const useCommunityPlugin = (id: string | null) => useQuery({ queryKey: keys.plugin(id ?? ""), queryFn: () => invoke("community.plugin", id!), enabled: !!id, retry: false });
export const useUpdates = () => useQuery({ queryKey: keys.updates, queryFn: () => invoke("community.updates"), retry: false });
export const useRevoked = () => useQuery({ queryKey: keys.revoked, queryFn: () => invoke("community.revoked") });
export const useCommunityAccount = () => useQuery({ queryKey: keys.account, queryFn: () => invoke("community.account"), retry: false });
export const useSubmissions = (enabled: boolean) => useQuery({ queryKey: keys.submissions, queryFn: () => invoke("community.submissions"), enabled, retry: false, refetchInterval: 20_000 });

function useCommunityMutation<A, R>(fn: (args: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void qc.invalidateQueries({ queryKey: keys.community }) });
}

export const useReport = () => useCommunityMutation((a: { id: string; version: string | null; reason: string; details: string }) => invoke("community.report", a.id, a.version, a.reason, a.details));
export const useLinkGitHub = () => useCommunityMutation(() => invoke("community.linkGitHub"));
export const useBecomePublisher = () => useCommunityMutation(() => invoke("community.becomePublisher"));
export const usePublish = () => useCommunityMutation((dir: string) => invoke("community.publish", dir));
export const useRequestReview = () => useCommunityMutation((a: { id: string; version: string }) => invoke("community.requestReview", a.id, a.version));

export const useWorkspaces = () => useQuery({ queryKey: keys.studio, queryFn: () => invoke("studio.list") });
export const useBuildReview = (name: string | null) => useQuery({ queryKey: keys.review(name ?? ""), queryFn: () => invoke("studio.review", name!), enabled: !!name, staleTime: 0 });
export const useSnapshots = (name: string | null) => useQuery({ queryKey: keys.snapshots(name ?? ""), queryFn: () => invoke("studio.snapshots", name!), enabled: !!name });

function useStudioMutation<A, R>(fn: (args: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.studio });
      void qc.invalidateQueries({ queryKey: keys.plugins });
      void qc.invalidateQueries({ queryKey: ["contributions"] });
    }
  });
}

export const useStudioCreate = () => useStudioMutation((a: { projectId: string; name: string; description: string; engine?: string }) => invoke("studio.create", a));
export const useStudioContinue = () => useStudioMutation((a: { projectId: string; name: string; engine?: string }) => invoke("studio.continue", a));
export const useStudioConfirm = () => useStudioMutation((a: { name: string; digest: string }) => invoke("studio.confirm", a.name, a.digest));
export const useStudioPack = () => useStudioMutation((name: string) => invoke("studio.pack", name));
export const useStudioRestore = () => useStudioMutation((a: { name: string; file: string }) => invoke("studio.restore", a.name, a.file));
export const useStudioRemove = () => useStudioMutation((a: { name: string; deleteFiles: boolean }) => invoke("studio.remove", a.name, a.deleteFiles));
