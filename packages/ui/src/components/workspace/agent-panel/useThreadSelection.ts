import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, logQuietly } from "~/lib/api";
import { STORE } from "./store";

/** Explicit opens include archives; a saved selection must still be listed after restart. */
export function useThreadSelection(projectId: string, threads: { id: string }[] | undefined) {
  const [selection, setSelection] = useState(() => ({ id: localStorage.getItem(STORE.thread(projectId)), explicit: false }));
  const chosenThread = selection.id;
  // A conversation archived while on screen (its ticket finished) stays until the person opens another or the app restarts.
  const shown = useRef<string | null>(null);
  const listed = chosenThread && threads?.some((th) => th.id === chosenThread) ? chosenThread : null;
  const lingering = !listed && chosenThread && (selection.explicit || shown.current === chosenThread) ? chosenThread : null;
  const threadId = listed ?? lingering ?? threads?.[0]?.id ?? null;
  shown.current = threadId;
  // Whatever follows the conversation on screen — the desktop pet — is told which one this is.
  useEffect(() => {
    if (threadId) void invoke("agent.showing", threadId).catch(logQuietly("agent.showing"));
  }, [threadId]);
  const choose = useCallback((id: string) => {
    setSelection({ id, explicit: true });
    localStorage.setItem(STORE.thread(projectId), id);
  }, [projectId]);
  const clear = useCallback(() => setSelection({ id: null, explicit: false }), []);
  return { threadId, choose, clear };
}
