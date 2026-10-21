import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "~/lib/api";
import { STORE } from "./store";

/** Which conversation the panel shows: the one last picked in this project while it is listed, else the newest. */
export function useThreadSelection(projectId: string, threads: { id: string }[] | undefined) {
  const [chosenThread, setChosenThread] = useState<string | null>(() => localStorage.getItem(STORE.thread(projectId)));
  // A conversation archived while on screen (its ticket finished) stays until the person opens another or the app restarts.
  const shown = useRef<string | null>(null);
  const listed = chosenThread && threads?.some((th) => th.id === chosenThread) ? chosenThread : null;
  const lingering = !listed && chosenThread && shown.current === chosenThread ? chosenThread : null;
  const threadId = listed ?? lingering ?? threads?.[0]?.id ?? null;
  shown.current = threadId;
  // Whatever follows the conversation on screen — the desktop pet — is told which one this is.
  useEffect(() => {
    if (threadId) void invoke("agent.showing", threadId).catch(() => {});
  }, [threadId]);
  const choose = useCallback((id: string) => {
    setChosenThread(id);
    localStorage.setItem(STORE.thread(projectId), id);
  }, [projectId]);
  const clear = useCallback(() => setChosenThread(null), []);
  return { threadId, choose, clear };
}
