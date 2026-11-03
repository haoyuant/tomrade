import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PageConfig } from "@tomradex/build-page";
import { invoke } from "./api";
import { keys } from "./queries";

/** What may be ticked and what was. An error means the plugin is off. */
export const useBuildPageState = (projectId: string, enabled = true) => useQuery({ queryKey: keys.buildPage.state(projectId), queryFn: () => invoke("buildPage.state", projectId), enabled, retry: false });

export const useBuildPagePreview = (projectId: string) => useMutation({ mutationFn: (config: PageConfig) => invoke("buildPage.preview", projectId, config) });

export function useBuildPagePublish(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (previewId: string) => invoke("buildPage.publish", projectId, previewId),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.buildPage.state(projectId) })
  });
}
