import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { invoke } from "../api";
import { invalidateWorkspace } from "./invalidate";
import { keys } from "./keys";

export const useHistory = (projectId: string, itemId: string | undefined) =>
  useQuery({ queryKey: keys.history(projectId, itemId ?? ""), queryFn: () => invoke("oplog.history", projectId, "item", itemId!), enabled: !!itemId });

/** A project's latest writes. Undefined on the home screen: nothing is recent across projects. */
export const useOplog = (projectId: string | undefined, limit = 5) =>
  useQuery({ queryKey: keys.oplog(projectId ?? ""), queryFn: () => invoke("oplog.recent", projectId!, limit), enabled: !!projectId });

/** An undo, redo or rollback can have touched anything: every board, view, rank and file, as well as the items. */
function afterTimelineMove(qc: QueryClient, projectId: string): void {
  invalidateWorkspace(qc, projectId);
  void qc.invalidateQueries({ queryKey: keys.boards(projectId) });
  void qc.invalidateQueries({ queryKey: keys.views(projectId) });
  void qc.invalidateQueries({ queryKey: keys.ranksAll });
  void qc.invalidateQueries({ queryKey: keys.files.all(projectId) });
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
