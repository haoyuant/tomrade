import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/ipc";
import { invoke, subscribe } from "./api";
import { useSaveSettings, useSettings } from "./queries";

export type UpdateChannel = "stable" | "beta";

export interface UpdatePrefs {
  autoCheck: boolean;
  channel: UpdateChannel;
}

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; latest: string }
  | { kind: "available"; version: string; date: string | null }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "failed"; message: string };

export interface UpdateStatus {
  version: string;
  /** checkout: updates with git · local-build: packaged without a feed · location: a Mac copy outside Applications · unsupported: cannot replace itself. */
  blocked: "checkout" | "local-build" | "location" | "unsupported" | null;
  phase: UpdatePhase;
  checkedAt: number | null;
}

/** Implemented by `apps/desktop/src/updater.ts`; declared here for the same reason as the shell's channels. */
declare module "@tomradex/ipc" {
  interface Channels {
    "updates.status": () => UpdateStatus;
    "updates.check": () => UpdateStatus;
    "updates.download": () => UpdateStatus;
    "updates.install": () => boolean;
    "updates.moveToApplications": () => boolean;
  }
  interface Broadcasts {
    "updates.changed": (status: UpdateStatus) => void;
  }
}

const KEY = ["updates"] as const;

let panes = 0;

/** Mounted by whatever shows the update state in full, so the notice keeps quiet while it is on screen. */
export function useUpdatesOnScreen(): void {
  useEffect(() => {
    panes += 1;
    return () => {
      panes -= 1;
    };
  }, []);
}

export const updatesOnScreen = () => panes > 0;

/** Null in a browser tab, or when the updater row is switched off. */
export function useUpdateStatus() {
  const qc = useQueryClient();
  useEffect(() => subscribe("updates.changed", (status) => qc.setQueryData(KEY, status)), [qc]);
  // Not cached for good: a row switched back on has no broadcast to announce it.
  return useQuery({ queryKey: KEY, queryFn: () => invoke("updates.status").catch(() => null) });
}

export function useUpdateActions() {
  const qc = useQueryClient();
  const settle = (status: UpdateStatus) => qc.setQueryData(KEY, status);
  return {
    check: useMutation({ mutationFn: () => invoke("updates.check"), onSuccess: settle }),
    download: useMutation({ mutationFn: () => invoke("updates.download"), onSuccess: settle }),
    install: useMutation({ mutationFn: () => invoke("updates.install") }),
    moveToApplications: useMutation({ mutationFn: () => invoke("updates.moveToApplications") })
  };
}

export function useUpdatePrefs(): [UpdatePrefs | undefined, (patch: Partial<UpdatePrefs>) => void] {
  const settings = useSettings();
  const save = useSaveSettings();
  const prefs = settings.data?.updates as UpdatePrefs | undefined;
  const change = (patch: Partial<UpdatePrefs>) => {
    if (settings.data && prefs) save.mutate({ ...settings.data, updates: { ...prefs, ...patch } });
  };
  return [prefs, change];
}
