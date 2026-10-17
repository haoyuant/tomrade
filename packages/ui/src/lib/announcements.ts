import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Announcement } from "@tomradex/announcements";
import { invoke, subscribe } from "./api";

export type { Announcement };

const KEY = ["announcements"] as const;

/** Empty in a browser tab, or when the announcements row is switched off. */
export function useAnnouncements() {
  const qc = useQueryClient();
  useEffect(() => subscribe("announcements.changed", (list) => qc.setQueryData(KEY, list)), [qc]);
  return useQuery({ queryKey: KEY, queryFn: () => invoke("announcements.list").catch(() => [] as Announcement[]) });
}

export function useMarkAnnouncementSeen() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => invoke("announcements.markSeen", id), onSuccess: (list) => qc.setQueryData(KEY, list) });
}
