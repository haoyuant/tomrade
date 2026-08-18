import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateItemInput, Item, Patch } from "@tomrade/core";

export function useItems() {
  return useQuery({
    queryKey: ["items"],
    queryFn: () => window.tomrade.list()
  });
}

export function useCreateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateItemInput, "by">) => window.tomrade.create(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["items"] })
  });
}

export function usePatchItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: Patch; baseVersion: number }) =>
      window.tomrade.update(args.id, args.patch, args.baseVersion),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["items"] })
  });
}

export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => window.tomrade.remove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["items"] })
  });
}

export function useUndo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => window.tomrade.undo(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["items"] })
  });
}

/** Derive a provenance key from a core Item (simplified G4 UI). */
export function provenanceOf(item: Item): "locked" | "ai" | "human" {
  if (item.humanLocked) return "locked";
  return item.updatedBy.startsWith("ai:") ? "ai" : "human";
}

export type { Item };