import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StorageInfo, StorageProviderView, StorageStatus } from "@tomradex/storage";
import { invoke } from "../api";
import { invalidateProject } from "./invalidate";
import { keys } from "./keys";

/* ── where a project is stored ─────────────────────────────────────────── */

export const useStorageProviders = () => useQuery({ queryKey: keys.storageProviders, queryFn: (): Promise<StorageProviderView[]> => invoke("storage.providers") });

/** The folder, who drives git in it, the remote, and what travels — everything the block draws. */
export const useStorageInfo = (projectId: string) =>
  useQuery({ queryKey: keys.storageInfo(projectId), queryFn: (): Promise<StorageInfo> => invoke("storage.info", projectId) });

/** Contacts the remote, so it is asked for on open and after an action — never polled. */
export const useStorageStatus = (projectId: string) =>
  useQuery({ queryKey: keys.storageStatus(projectId), queryFn: (): Promise<StorageStatus> => invoke("storage.status", projectId), retry: false, staleTime: 10_000 });

/** Tickets a sync left with delivery records that disagree; settled ones drop out. */
export const useSyncAttention = (projectId: string) =>
  useQuery({ queryKey: keys.syncAttention(projectId), queryFn: () => invoke("storage.attention", projectId), retry: false });

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

/** Whether a destination's account is connected, and as whom. Never the secret. Asked again while a sign-in waits on the person. */
export const useStorageConnection = (providerId: string | undefined) =>
  useQuery({
    queryKey: keys.storageConnection(providerId ?? ""),
    queryFn: () => invoke("storage.connection", providerId!),
    enabled: !!providerId,
    retry: false,
    refetchInterval: (query) => (query.state.data?.pending ? 2_000 : false)
  });

/** Starts a sign-in the person finishes in the browser; the connection query follows it from there. */
export function useSignInStorage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) => invoke("storage.signIn", providerId),
    onSuccess: (state, providerId) => qc.setQueryData(keys.storageConnection(providerId), state)
  });
}

/** Collected where it is needed; the provider keeps it per machine. */
export function useConnectStorage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { providerId: string; secret: string }) => invoke("storage.connect", args.providerId, args.secret),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.storage });
      void qc.invalidateQueries({ queryKey: keys.codeLink.root });
    }
  });
}

export function useDisconnectStorage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) => invoke("storage.disconnect", providerId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.storage });
      void qc.invalidateQueries({ queryKey: keys.codeLink.root });
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
