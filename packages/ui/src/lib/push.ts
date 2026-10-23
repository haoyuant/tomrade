import { useQuery } from "@tanstack/react-query";
import type {} from "@tomradex/ipc";
import { invoke } from "./api";
import { keys } from "./queries/keys";

export interface PushFailure {
  at: number;
  channel: "ntfy" | "bark" | "feishu";
  error: string;
}

/** Implemented by `apps/desktop/src/attention.ts`; declared here for the same reason as the shell's channels. */
declare module "@tomradex/ipc" {
  interface Channels {
    "attention.pushStatus": () => PushFailure | null;
  }
}

/** The last phone push that did not get through, or null once one has. */
export function usePushStatus() {
  return useQuery({ queryKey: keys.pushStatus, queryFn: () => invoke("attention.pushStatus").catch(() => null) });
}
