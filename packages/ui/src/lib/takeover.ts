import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TakeoverScan } from "@tomradex/takeover";
import { invoke } from "./api";
import { invalidateWorkspace, keys } from "./queries";

/** What would be read and sent. An error means the plugin is off, and there is no way in. */
export const useTakeoverOffer = (projectId: string, enabled = true) => useQuery({ queryKey: keys.takeover.offer(projectId), queryFn: () => invoke("takeover.offer", projectId), enabled, retry: false });

export const useTakeoverScan = (projectId: string) => useMutation({ mutationFn: (input: TakeoverScan) => invoke("takeover.scan", projectId, input) });

export function useTakeoverApply(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { draftId: string; entryIds: string[] }) => invoke("takeover.apply", projectId, args.draftId, args.entryIds),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.codeLink.all(projectId) });
      invalidateWorkspace(qc, projectId);
    }
  });
}
