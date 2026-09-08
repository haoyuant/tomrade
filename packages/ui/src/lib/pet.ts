import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { AssistantAccessory } from "@tomrade/contributions";
import { invokeDynamic, subscribeDynamic } from "./api";

interface AccessoryState {
  mood: string;
}

const stateOf = (value: unknown): AccessoryState =>
  typeof value === "object" && value !== null && typeof (value as { mood?: unknown }).mood === "string" ? { mood: (value as { mood: string }).mood } : { mood: "idle" };

const key = (accessory: AssistantAccessory, threadId: string | null) => ["assistant-accessory", accessory.id, accessory.stateChannel, threadId ?? ""] as const;

export function useAccessoryState(accessory: AssistantAccessory, threadId: string | null) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: key(accessory, threadId),
    queryFn: async () => stateOf(await invokeDynamic(accessory.stateChannel, threadId)),
    staleTime: Infinity,
    retry: false
  });
  useEffect(() => {
    return subscribeDynamic(accessory.changedChannel, (changedThreadId, state) => {
      if (changedThreadId === threadId) qc.setQueryData(key(accessory, threadId), stateOf(state));
    });
  }, [accessory, qc, threadId]);
  return query;
}
