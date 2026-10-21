import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/hub";
import type { RestoreSummary } from "@tomradex/storage";
import { invoke } from "../api";
import { keys } from "./keys";

/* ── this machine ──────────────────────────────────────────────────────── */

/** This machine: its id and its Hub folder. */
export const useHubInfo = () => useQuery({ queryKey: keys.hub, queryFn: () => invoke("hub.info") });

/** First run, or a move: name the Hub folder. Every project without a folder gets one under it. */
export function useConfigureHub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dir: string) => invoke("hub.configure", dir),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.hub });
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: keys.storage });
    }
  });
}

/** The person has read why `catalog.json` failed to read and writes the salvaged list over it. */
export function useOverwriteCatalog() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => invoke("hub.overwriteCatalog"), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.hub }) });
}

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
      void qc.invalidateQueries({ queryKey: keys.storage });
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
      void qc.invalidateQueries({ queryKey: keys.projects });
    }
  });
}
