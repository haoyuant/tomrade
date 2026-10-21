import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Board, BoardPatch, CreateBoardInput } from "@tomradex/domain";
import { invoke } from "../api";
import { invalidateWorkspace } from "./invalidate";
import { keys } from "./keys";

export const useBoards = (projectId: string) => useQuery({ queryKey: keys.boards(projectId), queryFn: () => invoke("boards.list", projectId) });

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
