import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/im";
import type { ImAllowRequest } from "@tomradex/im";
import { invoke, subscribe } from "./api";

const KEY = ["im"] as const;

/** Every IM query refetches on the main process's `im.changed`, so the panel follows connections and pairings live. */
function useLive() {
  const qc = useQueryClient();
  useEffect(() => subscribe("im.changed", () => void qc.invalidateQueries({ queryKey: KEY })), [qc]);
}

export function useImConnections() {
  useLive();
  return useQuery({ queryKey: [...KEY, "connections"], queryFn: () => invoke("im.connections") });
}
export const useImAdapters = () => useQuery({ queryKey: [...KEY, "adapters"], queryFn: () => invoke("im.adapters") });
export const useImIgnored = () => useQuery({ queryKey: [...KEY, "ignored"], queryFn: () => invoke("im.ignored") });
export const useImDeliveries = () => useQuery({ queryKey: [...KEY, "deliveries"], queryFn: () => invoke("im.deliveries") });
export const useImPairings = () => useQuery({ queryKey: [...KEY, "pairings"], queryFn: () => invoke("im.pairings") });

function useImMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (args: A) => fn(...args), onSettled: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export const useImPairStart = () => useImMutation((connectionId: string, projectId: string) => invoke("im.pairStart", connectionId, projectId));
export const useImPairConfirm = () => useImMutation((connectionId: string) => invoke("im.pairConfirm", connectionId));
export const useImPairCancel = () => useImMutation((connectionId: string) => invoke("im.pairCancel", connectionId));
export const useImRevoke = () => useImMutation((connectionId: string, tenantId: string, actorId: string) => invoke("im.revoke", connectionId, tenantId, actorId));
export const useImAllow = () => useImMutation((request: ImAllowRequest) => invoke("im.allow", request));
export const useImRetry = () => useImMutation((id: string) => invoke("im.retry", id));
export const useImDiscard = () => useImMutation((id: string) => invoke("im.discard", id));
