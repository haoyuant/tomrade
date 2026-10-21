import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/ipc";
import { invoke, subscribe } from "./api";
import { keys } from "./queries/keys";

type LoginState =
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "approval" }
  | { kind: "disabled" }
  | { kind: "unavailable"; reason: "checkout" | "location" | "unsupported" };

export interface BackgroundStatus {
  platform: string;
  keepRunning: boolean;
  startAtLogin: boolean;
  login: LoginState;
  error?: string;
}

/** Implemented by `apps/desktop/src/background.ts`; declared here for the same reason as the shell's channels. */
declare module "@tomradex/ipc" {
  interface Channels {
    "background.status": () => BackgroundStatus;
    "background.set": (patch: { keepRunning?: boolean; startAtLogin?: boolean }) => BackgroundStatus;
    "background.openLoginSettings": () => void;
  }
  interface Broadcasts {
    "background.changed": (status: BackgroundStatus) => void;
  }
}

/** Null in a browser tab, or when the background row is switched off. */
export function useBackgroundStatus() {
  const qc = useQueryClient();
  useEffect(() => subscribe("background.changed", (status) => qc.setQueryData(keys.background, status)), [qc]);
  // Refetched on focus: the person may have just approved or switched it off in the system's settings.
  return useQuery({ queryKey: keys.background, queryFn: () => invoke("background.status").catch(() => null), refetchOnWindowFocus: true });
}

export function useSetBackground() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { keepRunning?: boolean; startAtLogin?: boolean }) => invoke("background.set", patch),
    onSuccess: (status) => qc.setQueryData(keys.background, status)
  });
}

export const openLoginSettings = () => invoke("background.openLoginSettings");
