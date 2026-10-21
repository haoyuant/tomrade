import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateProjectInput, Project, ProjectPatch } from "@tomradex/domain";
import { invoke } from "../api";
import { keys } from "./keys";

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => invoke("projects.list") });

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
