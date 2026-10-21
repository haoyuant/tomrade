import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// the machineSetup.* channels
import type {} from "@tomradex/machine-setup";
import { invoke } from "./api";
import { keys } from "./queries";

/** The machine's git, polled only while its install runs; the window coming back looks again. */
export function useGitStatus() {
  return useQuery({
    queryKey: keys.machineSetup.git,
    queryFn: () => invoke("machineSetup.git"),
    staleTime: 10_000,
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => {
      const phase = query.state.data?.install?.phase;
      return phase === "running" || phase === "waiting" ? 2_000 : false;
    }
  });
}

export function useInstallGit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke("machineSetup.installGit"),
    onSuccess: (status) => qc.setQueryData(keys.machineSetup.git, status)
  });
}

export function useCancelGitInstall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke("machineSetup.cancelGitInstall"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.machineSetup.git })
  });
}
