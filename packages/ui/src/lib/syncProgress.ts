import { useEffect, useState } from "react";
import type { SyncProgress } from "@tomradex/files";
import { subscribe } from "~/lib/api";

/**
 * A running sync as the main process tells of it: what the status said when
 * it was read, until a broadcast moves it on. Its end comes as null, so a
 * status read mid-sync never leaves a finished sync looking busy.
 */
export function useSyncProgress(channel: "files.progress" | "storage.progress", projectId: string | null | undefined, read: SyncProgress | undefined): SyncProgress | null {
  const [told, setTold] = useState<{ projectId: string; progress: SyncProgress | null } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    const listen = (id: string, progress: SyncProgress | null) => {
      if (id === projectId) setTold({ projectId, progress });
    };
    return channel === "files.progress" ? subscribe("files.progress", listen) : subscribe("storage.progress", listen);
  }, [channel, projectId]);
  return told && told.projectId === projectId ? told.progress : (read ?? null);
}

/** Ticks once a second while `running`, so an elapsed time moves without a broadcast. */
export function useTicking(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** Disclosures opened in this window stay open while it lives, and only here. */
const opened = new Set<string>();

export function useOpenHere(id: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => opened.has(id));
  const toggle = () => {
    if (opened.has(id)) opened.delete(id);
    else opened.add(id);
    setOpen(opened.has(id));
  };
  return [open, toggle];
}
