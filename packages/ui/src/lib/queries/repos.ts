import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/repos";
import type { CheckoutSelection, CheckoutView, FolderRepo } from "@tomradex/repos";
import type { Repo, RepoPatch } from "@tomradex/domain";
import { invoke } from "../api";
import { keys } from "./keys";

/* ── repositories ────────────────────────────────────────────────────────
   The URL is the project's; the checkout is this machine's. */

export const useRepos = (projectId: string) => useQuery({ queryKey: keys.repos(projectId), queryFn: (): Promise<Repo[]> => invoke("repos.list", projectId) });
export const useRepoCheckouts = () => useQuery({ queryKey: keys.repoCheckouts, queryFn: (): Promise<CheckoutView[]> => invoke("repos.checkouts") });

function useRepoMutation<A, R>(projectId: string | null, fn: (args: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      if (projectId) void qc.invalidateQueries({ queryKey: keys.repos(projectId) });
      void qc.invalidateQueries({ queryKey: keys.repoCheckouts });
      // where an agent would run may have changed
      void qc.invalidateQueries({ queryKey: keys.agent.workdirAll });
    }
  });
}

export const useCreateRepo = (projectId: string) =>
  useRepoMutation(projectId, (input: { remote: string; name?: string; defaultBranch?: string }): Promise<Repo> => invoke("repos.create", { ...input, projectId }));
export const useAddRepoFromFolder = (projectId: string) => useRepoMutation(projectId, (dir: string): Promise<FolderRepo> => invoke("repos.addFromFolder", projectId, dir));
export const useUpdateRepo = (projectId: string) => useRepoMutation(projectId, (args: { id: string; patch: RepoPatch }) => invoke("repos.update", projectId, args.id, args.patch));
export const useRemoveRepo = (projectId: string) => useRepoMutation(projectId, (id: string) => invoke("repos.remove", projectId, id));
export const useSelectCheckout = () => useRepoMutation(null, (args: { remote: string; dir: string }): Promise<CheckoutSelection> => invoke("repos.selectCheckout", args.remote, args.dir));
export const useClearCheckout = () => useRepoMutation(null, (remote: string) => invoke("repos.clearCheckout", remote));
export const useSetRunInCheckout = () => useRepoMutation(null, (args: { remote: string; on: boolean }) => invoke("repos.setRunInCheckout", args.remote, args.on));
export const useCloneRepoInto = () => useRepoMutation(null, (args: { remote: string; branch: string; parent: string }) => invoke("repos.cloneInto", args.remote, args.branch, args.parent));
