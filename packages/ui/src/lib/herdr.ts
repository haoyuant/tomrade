import { useQuery } from "@tanstack/react-query";
import type {} from "@tomradex/code-link";
import { invoke } from "./api";

export type HerdrState = "notInstalled" | "notRunning" | "running";

/** The onboarding id the post-launch recommendation is put away under. */
export const HERDR_HINT = "hint.herdr";

export const herdrInstallQuery = { queryKey: ["codeLink", "herdrInstall"] as const, queryFn: () => invoke("codeLink.herdrInstall"), staleTime: 60_000 };

/** How herdr installs here; asked only where it is missing, since asking runs brew. */
export const useHerdrInstall = (enabled: boolean) => useQuery({ ...herdrInstallQuery, enabled });

/** A terminal that opened and is not herdr's, on a machine without herdr: what the recommendation follows. */
export const plainLaunch = (launch: { mode: string; launched: boolean; pane?: string | null }, herdr: HerdrState | undefined): boolean =>
  launch.mode === "terminal" && launch.launched && !launch.pane && herdr === "notInstalled";

/**
 * Whether to raise the recommendation now: after a plain launch, only while the
 * person has not seen it, and once — a second launch before the seen mark is
 * saved must not raise it again.
 */
export function herdrHintGate() {
  let raised = false;
  return (launch: Parameters<typeof plainLaunch>[0], herdr: HerdrState | undefined, seen: boolean): boolean => {
    if (raised || seen || !plainLaunch(launch, herdr)) return false;
    raised = true;
    return true;
  };
}
