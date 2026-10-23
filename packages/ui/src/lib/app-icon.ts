import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/ipc";
import { invoke, subscribe } from "./api";
import { keys } from "./queries/keys";

export type AppIcon = "transparent" | "sun";

/** Implemented by `apps/desktop/src/app-icon.ts`; declared here for the same reason as the shell's channels. */
interface AppIconStatus {
  platform: string;
  icon: AppIcon;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "appIcon.status": () => AppIconStatus;
    "appIcon.set": (icon: AppIcon) => AppIconStatus;
  }
  interface Broadcasts {
    "appIcon.changed": (status: AppIconStatus) => void;
  }
}

/** Null in a browser tab, or when the desktop shell does not provide the row. */
export function useAppIconStatus() {
  const qc = useQueryClient();
  useEffect(() => subscribe("appIcon.changed", (status) => qc.setQueryData(keys.appIcon, status)), [qc]);
  return useQuery({ queryKey: keys.appIcon, queryFn: () => invoke("appIcon.status").catch(() => null) });
}

export function useSetAppIcon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (icon: AppIcon) => invoke("appIcon.set", icon),
    onSuccess: (status) => qc.setQueryData(keys.appIcon, status)
  });
}
