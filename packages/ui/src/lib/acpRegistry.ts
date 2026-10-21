import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// the acpRegistry.* channels
import type {} from "@tomradex/acp-registry";
import { invoke } from "./api";
import { keys } from "./queries";

/** The registry's offerable agents, asked only while the fold is open; the backend caches across launches. */
export const useRegistryAgents = (enabled: boolean) =>
  useQuery({ queryKey: keys.acpRegistry.list, queryFn: () => invoke("acpRegistry.list"), enabled, staleTime: 5 * 60_000 });

export function useRegistryChange() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: keys.acpRegistry.list });
    void qc.invalidateQueries({ queryKey: keys.agent.engines });
  };
  const add = useMutation({ mutationFn: (id: string) => invoke("acpRegistry.add", id), onSuccess: done });
  const remove = useMutation({ mutationFn: (id: string) => invoke("acpRegistry.remove", id), onSuccess: done });
  const refresh = useMutation({
    mutationFn: () => invoke("acpRegistry.list", true),
    onSuccess: (listing) => qc.setQueryData(keys.acpRegistry.list, listing)
  });
  return { add, remove, refresh };
}
