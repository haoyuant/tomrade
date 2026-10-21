import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../api";
import { keys } from "./keys";

export const usePlugins = () => useQuery({ queryKey: keys.plugins, queryFn: () => invoke("plugins.list") });

/**
 * The answer is the whole composition after the switch, so the dialog redraws
 * from what actually loaded rather than from what it asked for. A refusal
 * leaves the cache untouched — nothing came down.
 */
export function useSetPluginEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) => invoke("plugins.setEnabled", args.id, args.enabled),
    onSuccess: (snapshot) => {
      qc.setQueryData(keys.plugins, snapshot);
      // A plugin that just loaded or unloaded took its channels, tools, badges
      // and settings cards with it.
      void qc.invalidateQueries({ queryKey: keys.contributions });
      void qc.invalidateQueries({ queryKey: keys.settingsSections });
    }
  });
}
