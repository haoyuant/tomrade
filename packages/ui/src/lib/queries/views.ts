import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateViewInput, View, ViewPatch } from "@tomradex/domain";
import { invoke } from "../api";
import { keys } from "./keys";

export const useViews = (projectId: string) => useQuery({ queryKey: keys.views(projectId), queryFn: () => invoke("views.list", projectId) });

export const useViewRanks = (projectId: string, viewId: string | undefined) =>
  useQuery({ queryKey: keys.ranks(viewId ?? ""), queryFn: () => invoke("views.ranks", projectId, viewId!), enabled: !!viewId });

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
