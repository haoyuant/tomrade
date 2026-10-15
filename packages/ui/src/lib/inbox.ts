import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AcceptOptions, CloseReason, InboxStatus } from "@tomradex/inbox";
import { invoke, subscribe } from "./api";

const keys = {
  all: (projectId: string) => ["inbox", projectId] as const,
  entries: (projectId: string, status: InboxStatus | "all") => ["inbox", projectId, "entries", status] as const,
  sources: (projectId: string) => ["inbox", projectId, "sources"] as const
};

/** A pull, a triage or another window's change refetches the lot, and the sidebar's count with it. */
function useLive(projectId: string) {
  const qc = useQueryClient();
  useEffect(
    () =>
      subscribe("inbox.changed", (id) => {
        if (id !== projectId) return;
        void qc.invalidateQueries({ queryKey: keys.all(projectId) });
        void qc.invalidateQueries({ queryKey: ["contributions", "sidebar", projectId] });
      }),
    [projectId, qc]
  );
}

/** Errors (the plugin is off) come back as a failed query, not an empty list. */
export function useInboxEntries(projectId: string, status: InboxStatus | "all", enabled = true) {
  useLive(projectId);
  return useQuery({ queryKey: keys.entries(projectId, status), queryFn: () => invoke("inbox.list", projectId, status), retry: false, enabled });
}

export function useInboxSources(projectId: string, enabled = true) {
  useLive(projectId);
  return useQuery({ queryKey: keys.sources(projectId), queryFn: () => invoke("inbox.sources", projectId), retry: false, enabled });
}

export function useInboxActions(projectId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: keys.all(projectId) });
    void qc.invalidateQueries({ queryKey: ["contributions", "sidebar", projectId] });
  };
  return {
    refresh: useMutation({ mutationFn: () => invoke("inbox.refresh", projectId), onSuccess: done }),
    setSource: useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => invoke("inbox.setSource", projectId, id, enabled), onSuccess: done }),
    accept: useMutation({ mutationFn: ({ id, opts }: { id: string; opts: AcceptOptions }) => invoke("inbox.accept", projectId, id, opts), onSuccess: done }),
    merge: useMutation({ mutationFn: ({ id, itemId }: { id: string; itemId: string }) => invoke("inbox.merge", projectId, id, itemId), onSuccess: done }),
    close: useMutation({ mutationFn: ({ id, reason }: { id: string; reason: CloseReason }) => invoke("inbox.close", projectId, id, reason), onSuccess: done }),
    reopen: useMutation({ mutationFn: (id: string) => invoke("inbox.reopen", projectId, id), onSuccess: done }),
    reply: useMutation({ mutationFn: ({ id, text }: { id: string; text: string }) => invoke("inbox.reply", projectId, id, text), onSuccess: done })
  };
}
