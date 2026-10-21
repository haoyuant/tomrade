import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateItemInput, Patch } from "@tomradex/domain";
import { invoke } from "../api";
import { invalidateWorkspace } from "./invalidate";
import { keys } from "./keys";

export const useItems = (projectId: string) => useQuery({ queryKey: keys.items(projectId), queryFn: () => invoke("items.list", { projectId }) });
export const useLabels = (projectId: string) => useQuery({ queryKey: keys.labels(projectId), queryFn: () => invoke("items.labels", projectId) });

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

/** The permanent one: nothing survives it, so the caller confirms first and never offers an Undo. */
export function usePurgeItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; baseVersion: number }) => invoke("items.purge", projectId, args.id, args.baseVersion),
    onSettled: () => invalidateWorkspace(qc, projectId)
  });
}
