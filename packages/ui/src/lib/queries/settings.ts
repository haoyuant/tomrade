import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AppSettings } from "@tomradex/domain";
import { invoke } from "../api";
import { keys } from "./keys";

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => invoke("settings.get") });
/** The cards' words come back in the renderer's language, so a language switch fetches them again. */
export const useSettingsSections = (locale?: string) =>
  useQuery({ queryKey: [...keys.settingsSections, locale ?? ""], queryFn: () => invoke("settings.sections", locale ?? "en") });
/** The project's own MCP address when one is given; the unscoped server otherwise. */
export const useMcpUrl = (projectId?: string) => useQuery({ queryKey: keys.mcp(projectId), queryFn: () => invoke("mcp.url", projectId), retry: false });
/** Where this machine keeps its caches. Never the truth — every file there can be rebuilt. */
export const useCacheDir = () => useQuery({ queryKey: keys.cacheDir, queryFn: () => invoke("db.dir") });
/** This build: its version and what it runs on. Fixed for the app's life. */
export const useAbout = () => useQuery({ queryKey: keys.about, queryFn: () => invoke("shell.about"), staleTime: Infinity, retry: false });
/** How this system seals secrets: "plaintext" when it has no keychain. */
export const useSecretStorage = () =>
  useQuery({ queryKey: keys.secretStorage, queryFn: () => invoke("settings.secretStorage"), staleTime: Infinity, retry: false });

/** A failed save says so as a toast, unless `reportErrors: false` because the caller shows it in place. */
export const saveSettingsOptions = (qc: QueryClient, reportErrors = true) => ({
  mutationFn: (next: AppSettings) => invoke("settings.set", next),
  meta: { reportErrors },
  onSuccess: (saved: AppSettings) => qc.setQueryData(keys.settings, saved),
  // Whatever showed the new value goes back to what is saved.
  onError: () => void qc.invalidateQueries({ queryKey: keys.settings })
});

export function useSaveSettings({ reportErrors = true }: { reportErrors?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation(saveSettingsOptions(qc, reportErrors));
}
