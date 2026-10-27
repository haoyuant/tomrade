import { useSyncExternalStore } from "react";

/** What another part of the window asks the assistant panel to do: ⌘K's sessions and actions. */
export type PanelRequest =
  | { kind: "newThread" }
  /** A new conversation, sent these words at once. */
  | { kind: "startWith"; text: string }
  | { kind: "openSession"; sessionId: string }
  | { kind: "toggleBar" }
  | { kind: "nextWaiting" };

const requests = new Set<(request: PanelRequest) => void>();

/** Asks the panel; it answers whether it is open or folded, so open it first when the answer should be seen. */
export const askPanel = (request: PanelRequest): void => {
  for (const listener of requests) listener(request);
};

export function onPanelRequest(listener: (request: PanelRequest) => void): () => void {
  requests.add(listener);
  return () => requests.delete(listener);
}

/** The terminal session the panel shows in place of a thread, if any: what "this session" means to ⌘K. */
let shown: { projectId: string; sessionId: string } | null = null;
const shownListeners = new Set<() => void>();

export function setPanelSession(next: { projectId: string; sessionId: string } | null): void {
  if (shown?.projectId === next?.projectId && shown?.sessionId === next?.sessionId) return;
  shown = next;
  for (const listener of shownListeners) listener();
}

export const usePanelSession = (projectId: string): string | null =>
  useSyncExternalStore(
    (listener) => {
      shownListeners.add(listener);
      return () => shownListeners.delete(listener);
    },
    () => (shown?.projectId === projectId ? shown.sessionId : null)
  );
