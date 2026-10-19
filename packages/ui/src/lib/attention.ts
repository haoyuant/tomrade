import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { invoke, subscribe } from "~/lib/api";
import { isLeadWindow } from "~/lib/window-chrome";

/** One thing an agent is waiting on the person for — the desktop shell's attention row keeps the list. */
export interface AttentionEntry {
  key: string;
  projectId: string;
  threadId: string | null;
  itemId: string | null;
  itemKey: string | null;
  kind: "permission" | "question" | "waiting" | "stuck";
  who: string | null;
  text: string | null;
  /** Since when it has waited in this kind. */
  since: number;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "attention.list": () => AttentionEntry[];
  }
  interface Broadcasts {
    "attention.changed": (entries: AttentionEntry[]) => void;
    "attention.open": (entry: AttentionEntry) => void;
    /** A followed tomrade:// link, e.g. from an IM reply. */
    "app.open": (target: { projectId: string; itemId?: string; threadId?: string; path?: string }) => void;
  }
}

const KEY = ["attention"] as const;

/** Empty in a browser tab, or when the attention row is switched off. */
export function useAttention(): AttentionEntry[] {
  const qc = useQueryClient();
  useEffect(() => subscribe("attention.changed", (entries) => qc.setQueryData(KEY, entries)), [qc]);
  return useQuery({ queryKey: KEY, queryFn: () => invoke("attention.list").catch(() => []), staleTime: Infinity }).data ?? [];
}

// A clicked notification may name another project: it waits here until that project's shell mounts.
let waiting: Pick<AttentionEntry, "projectId" | "threadId" | "itemId"> | null = null;
const listeners = new Set<() => void>();

/** The entry a clicked notification asked to show, once, if it belongs to this project. */
export function takeOpenRequest(projectId: string): Pick<AttentionEntry, "projectId" | "threadId" | "itemId"> | null {
  if (waiting?.projectId !== projectId) return null;
  const entry = waiting;
  waiting = null;
  return entry;
}

export function onOpenRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Brings up the entry's project, whose shell then opens the conversation (or the ticket). */
export function useOpenAttention(): (entry: Pick<AttentionEntry, "projectId" | "threadId" | "itemId">) => void {
  const navigate = useNavigate();
  return useCallback(
    (entry: Pick<AttentionEntry, "projectId" | "threadId" | "itemId">) => {
      waiting = entry;
      if (!window.location.hash.startsWith(`#/p/${entry.projectId}`)) void navigate({ to: "/p/$projectId", params: { projectId: entry.projectId } });
      for (const listener of listeners) listener();
    },
    [navigate]
  );
}

/** Mounted once at the root: a clicked notification, or a followed tomrade:// link, opens what it is about. */
export function AttentionOpener() {
  const open = useOpenAttention();
  const navigate = useNavigate();
  // Every window hears it; the one the shell brought forward opens it.
  useEffect(() => subscribe("attention.open", (entry) => isLeadWindow() && open(entry)), [open]);
  useEffect(() => subscribe("app.open", (target) => {
    if (!isLeadWindow()) return;
    if (target.path !== undefined) void navigate({ to: "/p/$projectId/f/$", params: { projectId: target.projectId, _splat: target.path } });
    else open({ projectId: target.projectId, threadId: target.threadId ?? null, itemId: target.itemId ?? null });
  }), [open, navigate]);
  return null;
}
